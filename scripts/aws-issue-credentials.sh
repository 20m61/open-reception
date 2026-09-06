#!/usr/bin/env bash
# =============================================================================
# デプロイ窓を開ける (spec §8)。**ローカル Mac の Admin 環境で人間が実行する。**
#
#   scripts/aws-issue-credentials.sh [--hours N] [--print] [--no-context]
#
# OpenReceptionClaudeDeploy-dev を assume して短命 STS を発行し、
# claude.ai/code の環境ダイアログへ貼るための値をクリップボードへ入れる。
#
# 🔴 **9 変数まとめて入れる（#989）。** AWS の 5 つに加えて、デプロイに必須の context
#    4 つ（`OR_APP_SECRETS_NAME` / `OR_ORIGIN_VERIFY_SECRET` / `OR_PUBLIC_ORIGIN_OVERRIDE` /
#    `OR_PROVIDER_SECRET_BACKEND`）も同じブロックに載せる。以前は AWS の 5 つだけを
#    コピーしていたため、残り 4 つが「リポジトリに書いてあるから後で」になり、
#    2026-09-06 の 3 回目のデプロイで **`OR_APP_SECRETS_NAME` だけが未登録**のまま窓を開けて
#    `diff` が止まった。落ちたのは 4 つのうち唯一「秘密の値ではない」もので、
#    **秘密 3 つは貼る意識が働くのに非秘密の 1 つだけ抜ける**という形だった。
#    9 つを 1 回のコピーにすれば「一部だけ貼る」余地そのものが消える。
#
#    値は `~/.config/open-reception/deploy-context.env`（`OR_DEPLOY_CONTEXT_FILE` で変更可）
#    か環境変数から取る。**リポジトリの中には置かない** —— `OR_ORIGIN_VERIFY_SECRET` は
#    秘密そのもので、`.gitignore` に頼る形にすると ignore 行が消えた瞬間に commit され得る。
#
#    🔴 解決は **assume-role より前**に置く。欠けていれば資格情報を発行せずに終わる ――
#    使えない窓を開けない（欠落に `diff` で気づくと、そこまでの往復が丸ごと窓を食う）。
#
# 🔴 値は既定で表示しない。ファイルにも書かない。ログにも残さない。
#    「窓が開いている＝credential が生きている」なので、状態を二重に持たない。
#
# 🔴 呼び出し元の環境が SHELLOPTS=xtrace を export していると、bash は新しい
#    プロセス起動時にそれを自動的に引き継ぐ（`set -x` を書いていなくても有効になる）。
#    このスクリプトは値を変数に載せて扱うので、継承されたトレースをここで明示的に
#    無効化しておく（`set -x` は書かない＝有効化しない、というだけでは足りない）。
set +x

set -euo pipefail

ACCOUNT="822063948773"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/OpenReceptionClaudeDeploy-dev"
EXTERNAL_ID="open-reception-claude-cloud-dev"
REGION="ap-northeast-1"
HOURS=4
PRINT=false
WITH_CONTEXT=true
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --hours)
      HOURS="${2:-}"
      shift 2
      ;;
    --print)
      PRINT=true
      shift
      ;;
    --no-context)
      # AWS の 5 つだけを入れる。context を別経路で登録済みのときの逃げ道。
      WITH_CONTEXT=false
      shift
      ;;
    *)
      echo "未知の引数: $1" >&2
      exit 2
      ;;
  esac
done

if ! printf '%s' "${HOURS}" | grep -Eq '^[0-9]+$'; then
  echo "--hours には整数を指定してください（1〜12）" >&2
  exit 2
fi
if [ "${HOURS}" -lt 1 ] || [ "${HOURS}" -gt 12 ]; then
  echo "--hours は 1〜12 の範囲で指定してください（指定: ${HOURS}）" >&2
  exit 2
fi

# 🔴 **context の解決は assume-role より前**（#989）。ここで落とせば資格情報は発行されず、
# 「開いたが使えない窓」を作らずに済む。判定は `src/domain/governance/deploy-context.ts` の
# 純関数が持ち、`aws-cloud-deploy.sh` の必須 context ガードと同じ基準を使う
# （ここで基準を写経すると、片方だけ直る型の欠陥になる）。
#
# 値は stdout 経由でのみ受け取る（argv に載せない＝ `ps` に秘密が出ない）。
# 失敗時の stderr はそのまま通す ―― 純関数側が「変数名だけで値を出さない」診断を作る。
CONTEXT_BLOCK=""
if [ "${WITH_CONTEXT}" = true ]; then
  if ! CONTEXT_BLOCK="$(npx --no-install tsx "${ROOT}/scripts/deploy-context-block.ts")"; then
    echo "デプロイ context を解決できないため、窓を開けずに終了します（--no-context で省略できます）" >&2
    exit 2
  fi
fi

# 🔴 **VITEST 実行中は絶対に AWS へ到達しない。** `scripts/aws-cloud-deploy.sh` の
# `collect_observation` と同じ安全装置（Important 7）。このスクリプトのテストは
# 実際にスクリプトを起動して引数検証を確かめる（`tests/hooks/aws-issue-credentials.test.ts`）。
# 上の境界チェックにバグが入って値がすり抜けた場合でも、ここで確実に止め、
# ローカル Mac に設定済みの実資格情報で本物の `aws sts assume-role` が飛ぶ事故を防ぐ。
# （実測: 上限を 24 に変異させて確認したとき、境界チェックをすり抜けた --hours 13 が
# この安全装置を追加する前は実際に AWS STS まで到達し、`ValidationError` で失敗した。
# 資格情報は発行されなかったが、意図しない実 API 呼び出しが起きた事実は残る。）
if [ -n "${VITEST:-}" ]; then
  echo "VITEST 実行中のため AWS を呼びません（テストの安全装置）" >&2
  exit 1
fi

# `set -euo pipefail` の下で、単純な代入文 `VAR="$(cmd)"` は cmd の終了コードを
# そのまま引き継ぐ（`local VAR=$(cmd)` のように `local` が終了コードを隠す罠には
# 当たらない）。assume-role が失敗すればここでスクリプトごと止まる
# ＝「窓が開いた」という嘘の成功メッセージは出ない。
CREDS="$(aws sts assume-role \
  --role-arn "${ROLE_ARN}" \
  --role-session-name "claude-cloud-$(date +%Y%m%d-%H%M)" \
  --external-id "${EXTERNAL_ID}" \
  --duration-seconds "$((HOURS * 3600))" \
  --output json)"

# 🔴 `CREDS` にはこの時点で SecretAccessKey が生の JSON として入っている。
# 以降の node 呼び出しは stdin 経由でのみ受け渡す（コマンドライン引数には絶対に
# 乗せない＝ `ps` の引数一覧に値が出ない）。パース失敗時のエラーメッセージも
# 汎用文言に丸め、入力（`s`）の内容を一切含めない。JSON.parse の SyntaxError は
# 実装によっては入力の断片をメッセージへ含めることがあるため、try/catch で
# その既定のエラーメッセージを握りつぶす。フィールド欠落も「undefined 文字列」を
# 埋め込まず、明示的に非ゼロで落とす（`scripts/aws-cloud-deploy.sh` の
# `json_field` と同じ方針）。
#
# `pipefail` が効いているため、この node 呼び出しが失敗（exit 1）すれば
# パイプライン全体の終了コードが非ゼロになり、代入文がそれを引き継いで
# `set -e` に拾われる。
BLOCK="$(printf '%s' "${CREDS}" | REGION="${REGION}" node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    console.error("assume-role の応答を JSON として解釈できませんでした");
    process.exit(1);
  }
  const c = parsed && parsed.Credentials;
  const required = ["AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration"];
  const missing = c ? required.filter((k) => typeof c[k] !== "string" || c[k] === "") : required;
  if (missing.length > 0) {
    console.error("assume-role の応答に必要なフィールドがありません: " + missing.join(","));
    process.exit(1);
  }
  process.stdout.write(
    "AWS_ACCESS_KEY_ID=" + c.AccessKeyId + "\n" +
    "AWS_SECRET_ACCESS_KEY=" + c.SecretAccessKey + "\n" +
    "AWS_SESSION_TOKEN=" + c.SessionToken + "\n" +
    "AWS_REGION=" + process.env.REGION + "\n" +
    "AWS_CREDENTIAL_EXPIRATION=" + c.Expiration + "\n"
  );
});
')"

# BLOCK の最終行（AWS_CREDENTIAL_EXPIRATION=...）から表示用の期限だけを取り出す。
# CREDS を再度パースし直さない（秘密値の再受け渡し経路を増やさない）。
EXPIRY="${BLOCK##*AWS_CREDENTIAL_EXPIRATION=}"
EXPIRY="${EXPIRY%$'\n'}"

# 🔴 **期限を取り出した後に連結する。** 先に足すと `${BLOCK##*AWS_CREDENTIAL_EXPIRATION=}`
# が context の行まで拾い、表示する期限が壊れる（値そのものが漏れる形にはならないが、
# 「窓が閉じる時刻」を読み違える）。
VAR_COUNT=5
if [ -n "${CONTEXT_BLOCK}" ]; then
  BLOCK="${BLOCK}"$'\n'"${CONTEXT_BLOCK}"
  VAR_COUNT=9
fi

if [ "${PRINT}" = true ]; then
  printf '%s\n' "${BLOCK}"
else
  # 🔴 pbcopy は macOS 専用で、無ければ失敗する。「コピーできなかったので代わりに
  # 表示する」というフォールバックは絶対に行わない（値が既定で表示されないという
  # 唯一最大の要件を破る）。存在確認とコピー結果の両方を明示的に確認し、
  # 失敗時は「コピーできた」という嘘のメッセージを出さずに非ゼロで終了する。
  if ! command -v pbcopy >/dev/null 2>&1; then
    echo "pbcopy が見つかりません（macOS 以外の環境？）。値は表示していません。--print を明示するか pbcopy を用意してください。" >&2
    exit 1
  fi
  if ! printf '%s' "${BLOCK}" | pbcopy; then
    echo "クリップボードへのコピーに失敗しました（値は表示していません）。--print を明示するか環境を確認してください。" >&2
    exit 1
  fi
  echo "クリップボードへコピーしました（値は表示していません）"
fi

echo "窓が閉じる時刻: ${EXPIRY}（${HOURS} 時間）"
echo "claude.ai/code の環境ダイアログへ ${VAR_COUNT} つの環境変数を登録してください。"
if [ "${VAR_COUNT}" -eq 5 ]; then
  echo "（--no-context のため AWS の 5 つだけです。デプロイ context 4 つは別途登録してください）"
fi
echo "🔴 貼り終えてから新しいセッションを作ってください（env はコンテナ起動時に焼き込まれます）。"
echo "窓を閉じるときは、同じダイアログから AWS の 5 つを削除してください。"
