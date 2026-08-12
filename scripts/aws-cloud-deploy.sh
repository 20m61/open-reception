#!/usr/bin/env bash
# =============================================================================
# Claude Code on the cloud から AWS dev へデプロイするための wrapper (spec §5)。
#
#   scripts/aws-cloud-deploy.sh <preflight|verify|diff|deploy|smoke>
#
# クラウドから素の `cdk deploy` を打たないための唯一の入口。迂回しても既定 qualifier の
# ロールを assume できず失敗する（fail-closed）が、迂回を前提にしない。
#
# 判定ロジックはこのファイルに書かない（bash はテストしづらい）。観測を集めて
# scripts/aws-preflight.ts と scripts/aws-diff-gate.ts へ渡す。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUALIFIER="orcloud01"
# 🔴 **`--toolkit-stack-name` を明示する。** bootstrap は
# `--toolkit-stack-name CDKToolkit-orcloud01` で行った（既定の `CDKToolkit` ではない）。
# これを渡さずに `cdk deploy` すると、CDK の toolkit 参照（staging bucket 名の解決等）が
# 既定の `CDKToolkit` を探しにいき、`claude-deploy-role-restriction.json` の
# allowlist（`CDKToolkit-orcloud01` のみ）に無い名前なので Deny に当たる。
# これらの参照は try/catch で握りつぶされ致命的にはならない（レビューで確認済み）が、
# 握りつぶされた権限エラーに依存する状態を放置しない。渡せば
# `CDKToolkit-orcloud01` を正しく参照し、allowlist の当該エントリも実際に使われる。
TOOLKIT_STACK_NAME="CDKToolkit-${QUALIFIER}"
DEPLOY_ENV="${OR_DEPLOY_ENV:-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
# 🔴 **スタックごとにリージョンを持つ。** `OpenReception-CfMonitoring-*` は
# cross-region 参照の都合で us-east-1 固定（`infra/bin/open-reception.ts`）。他の 2 つは
# 既定リージョン（ap-northeast-1）。`<name>:<region>` の形で 1 つの配列にまとめ、
# `${entry%%:*}` / `${entry##*:}` で分解する（Important D）。
STACKS=(
  "OpenReception-Web-${DEPLOY_ENV}:${REGION}"
  "OpenReception-WebMonitoring-${DEPLOY_ENV}:${REGION}"
  "OpenReception-CfMonitoring-${DEPLOY_ENV}:us-east-1"
)
STACK_NAMES=()
for _entry in "${STACKS[@]}"; do
  STACK_NAMES+=("${_entry%%:*}")
done

usage() {
  echo "Usage: $0 <preflight|verify|diff|deploy|smoke>" >&2
}

if [ $# -lt 1 ]; then
  usage
  exit 2
fi
SUB="$1"
shift || true

case "${SUB}" in
  preflight|verify|diff|deploy|smoke) ;;
  *)
    echo "未知のサブコマンド: ${SUB}" >&2
    usage
    exit 2
    ;;
esac

# 環境の固定。dev 以外はここで止める（脅威 T13）。
if [ "${DEPLOY_ENV}" != "dev" ]; then
  echo "OR_DEPLOY_ENV=${DEPLOY_ENV} は許可されていません（dev のみ）" >&2
  exit 2
fi

# --help はサブコマンド判定だけして抜ける（テストが AWS に触れずに済むように）。
if [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

# `identity` (JSON 文字列) から 1 フィールドを取り出す。
#
# 🔴 **欠落を「問題なし」に落とさない。** `JSON.parse(s).Account` が `undefined` を
# 返しても素朴には例外にならず `console.log(undefined)` が "undefined" という文字列を
# 印字して exit 0 してしまう ―― それだと後続の JSON に一見もっともらしいがおかしな値が
# 静かに混ざる。ここでは値が欠けていたら明示的に非ゼロで落とし、`set -e` に拾わせる。
json_field() {
  local json="$1" field="$2"
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(s);
      } catch (e) {
        console.error("JSON parse に失敗しました: " + e.message);
        process.exit(1);
      }
      const value = parsed[process.argv[1]];
      if (typeof value !== "string" || value === "") {
        console.error("フィールド " + process.argv[1] + " が見つかりません");
        process.exit(1);
      }
      console.log(value);
    });
  ' "${field}" <<< "${json}"
}

collect_observation() {
  local out="$1" min_seconds="$2"
  local identity account arn expiry remaining porcelain clean stamp neg

  # 🔴 **VITEST 実行中は絶対に AWS へ到達しない。** `tests/hooks/aws-cloud-deploy.test.ts` は
  # この wrapper を実際に起動して振る舞いを確認する（`tests/hooks/guard-destructive.test.ts`
  # と同じ方針）。テストは意図的に壊れた資格情報を渡しているが、クラウド box の
  # デプロイウィンドウ中に `npm test` が走った場合、周囲の環境変数には**本物の**資格情報が
  # 残っている可能性がある。「1 つの文字列アサーションだけがネットワークとの間に立つ」
  # 状態を避けるため、テストランタイムであること自体をここで検知して先に止める。
  if [ -n "${VITEST:-}" ]; then
    echo "VITEST 実行中のため collect_observation は AWS を呼びません（テストの安全装置）" >&2
    return 1
  fi

  if ! identity="$(aws sts get-caller-identity --output json 2>&1)"; then
    echo "AWS 認証情報を解決できません: ${identity}" >&2
    return 1
  fi
  # json_field は失敗時に非ゼロで終わる（`set -e` により collect_observation ごと
  # 打ち切られる）。「取得できないので undefined 文字列を JSON に埋め込む」は許さない。
  account="$(json_field "${identity}" Account)"
  arn="$(json_field "${identity}" Arn)"

  # credential の残時間。取得できなければ null（判定不能を PASS にしない）。
  #
  # 🔴 **NaN を JSON に生で埋め込まない。** `AWS_CREDENTIAL_EXPIRATION` が不正な形式
  # （空でないがパース不能）だと `Date.parse` は例外を投げず `NaN` を返す。
  # `console.log(NaN)` は "NaN" という文字列を出力して exit 0 するため、
  # 素朴な実装では `set -euo pipefail` に捕まらず、後段のヒアドキュメントへ
  # `"credentialSecondsRemaining": NaN,` という**不正な JSON**をそのまま書き込んでしまう
  # （node -e 自体は成功して見えるが、下流の `JSON.parse` で初めて壊れて分かる ―
  # 診断としては不親切）。ここでは NaN を検出したら明示的に "null" 文字列を出力し、
  # 既存の「取得できなければ null」経路へ合流させる。
  expiry="${AWS_CREDENTIAL_EXPIRATION:-}"
  if [ -n "${expiry}" ]; then
    # 🔴 **明示的な `process.exit(0)` を置かない。** stdout はコマンド置換
    # （パイプ）で捕捉されるため非同期で書き出される。`console.log` の直後に
    # `process.exit()` を呼ぶと、書き込みが完了する前にプロセスが終了して出力が
    # 欠ける可能性がある（Node の既知の落とし穴）。ここでは 1 行の三項演算子に
    # まとめ、node の自然終了に任せる。
    remaining="$(node -e '
      const ms = Date.parse(process.argv[1]);
      console.log(Number.isNaN(ms) ? "null" : Math.floor((ms - Date.now()) / 1000));
    ' "${expiry}")"
  else
    remaining="null"
  fi

  # 🔴 **workingTreeClean は fail-closed でなければならない。** `git status` 自体が
  # 失敗した場合（壊れた worktree・権限エラー等）、`[ -z "$(git status ...)" ]` は
  # 標準出力が空という理由で `clean=true` を返してしまう ―― 「判定できない」が
  # 「問題なし」に化ける（Important 2）。`git status` の終了コードを明示的に見る。
  if ! porcelain="$(git -C "${ROOT}" status --porcelain -uall)"; then
    echo "git status を実行できませんでした（判定不能）" >&2
    return 1
  fi
  if [ -z "${porcelain}" ]; then clean=true; else clean=false; fi

  # 品質ゲートのスタンプ（既存の scripts/lib/gate-stamp.sh を使う）。
  # shellcheck source=lib/gate-stamp.sh
  . "${ROOT}/scripts/lib/gate-stamp.sh"
  # 🔴 **cwd を ROOT に固定してから呼ぶ。** `gate_stamp_satisfies` → `gate_tree_fingerprint`
  # は `git ls-files` をプロセスの cwd に対して実行する。他のすべての git 呼び出しは
  # `git -C "${ROOT}"` で明示しているのに、ここだけ暗黙の cwd に依存すると、
  # `infra/` などから起動されたときに `quality-gate.sh`（cd ROOT 後にスタンプを書く）
  # と指紋が食い違い、スタンプがあるのに偽の FAIL になる（Important 3。本リポジトリに
  # 同種の罠の既知インシデントあり）。
  if ( cd "${ROOT}" && gate_stamp_satisfies "pr" ); then stamp=true; else stamp=false; fi

  # --live-only: S 系（SimulatePrincipalPolicy）はここでは実行しない。
  # OpenReceptionClaudeDeploy-dev は iam:SimulatePrincipalPolicy を持たない前提であり、
  # S 系は人間が Admin 環境の runbook で別途実施する（Important 5b）。
  if npx tsx "${ROOT}/scripts/aws-negative-tests.ts" --live-only; then neg=true; else neg=false; fi

  cat > "${out}" <<EOF
{
  "callerArn": "${arn}",
  "accountId": "${account}",
  "region": "${REGION}",
  "qualifier": "${QUALIFIER}",
  "environment": "${DEPLOY_ENV}",
  "credentialSecondsRemaining": ${remaining},
  "workingTreeClean": ${clean},
  "gateStampSatisfied": ${stamp},
  "negativeTestsPassed": ${neg}
}
EOF
  npx tsx "${ROOT}/scripts/aws-preflight.ts" "${out}" "${min_seconds}"
}

# 🔴 **diff と deploy で同じ change set 名を使う。ただし「gate が承認した change set が
# そのまま実行される」わけではない ―― CDK のソースで確認済み。**
#
# `infra/node_modules/aws-cdk/lib/index.js` の `createChangeSetAndCleanup()` は、
# 指定した名前の change set が既に存在すれば `cleanupOldChangeset()` →
# `cfn.deleteChangeSet()` で**無条件に削除してから**、`cfn.createChangeSet()` で
# 新しく作り直す（`options.exists` が true のときの分岐。CDK は「既存の named change
# set を再利用する」という API を公開していない）。つまり `deploy` の `cdk deploy
# --change-set-name X` は、`diff` が承認したのと同じ名前 `X` の change set を
# **必ず削除して作り直す**。gate が見た内容と実際に実行される内容は、
# ワーキングツリーが gate 通過後に一切変わっていなければ同一のはずだが、
# 「同じ change set オブジェクトを承認して実行している」という保証はどこにも無い。
#
# **それでも同じ名前を使う理由は別にある。** changeSet ARN は stack 名を埋め込まないため
# （`arn:...:changeSet/<name>/<id>`）、IAM 側は名前でしかスコープできない。
# `claude-deploy-entry.json` / `claude-deploy-role-restriction.json` はどちらも
# `changeSet/claude-gate-*/*` という名前パターンで Allow / NotResource を絞っている
# （Important A）。名前を固定していなければ、この IAM スコープ自体が機能しない。
# **「実行される change set を gate が承認したものに固定する」という保証は、この
# 仕組みには無い。**
changeset_name() {
  echo "claude-gate-$(git -C "${ROOT}" rev-parse --short HEAD)"
}

run_diff_gate() {
  local stack="$1" region="$2" cs_name cs_json
  cs_name="$(changeset_name)"
  cs_json="$(mktemp)"

  # cdk が change set を作る。--no-execute で実行しない。
  # スタックがまだ存在しない場合（初回デプロイ）、CDK は自動的に CREATE 型の change set を
  # 作る。全リソースが Add として現れるだけで、以降の判定ロジックは通常の diff と同じに
  # 扱われる（Important D の「初回デプロイの挙動」）。
  if ! ( cd "${ROOT}/infra" && npx cdk deploy "${stack}" \
      -c env="${DEPLOY_ENV}" \
      -c "@aws-cdk/core:bootstrapQualifier=${QUALIFIER}" \
      --toolkit-stack-name "${TOOLKIT_STACK_NAME}" \
      --change-set-name "${cs_name}" --no-execute ); then
    echo "  ⛔ ${stack}（${region}）の change set 作成（cdk deploy --no-execute）に失敗しました" >&2
    echo "     （直前の cdk 出力を参照。cdk 側のエラーメッセージがそのまま上に表示されているはずです）" >&2
    return 1
  fi

  # 🔴 **--region を明示する。** `OpenReception-CfMonitoring-dev` は us-east-1
  # （`infra/bin/open-reception.ts`）だが、AWS CLI の既定リージョンは `${REGION}`
  # （通常 ap-northeast-1）。`--region` を渡さないと `describe-change-set` が
  # 誤ったリージョンへ飛び、「スタックが存在しない」という不可解な ValidationError で
  # `set -e` によりループごと落ちる（Important D）。
  if ! aws cloudformation describe-change-set \
      --stack-name "${stack}" --change-set-name "${cs_name}" --region "${region}" \
      --output json > "${cs_json}"; then
    echo "  ⛔ ${stack}（${region}）の change set を取得できませんでした（describe-change-set 失敗）" >&2
    echo "     （直前の aws 出力を参照。region 指定・change set 名・権限を確認してください）" >&2
    return 1
  fi

  npx tsx "${ROOT}/scripts/aws-diff-gate.ts" "${cs_json}" "${stack}"
}

case "${SUB}" in
  preflight)
    collect_observation "$(mktemp)" 1200
    ;;
  verify)
    "${ROOT}/scripts/quality-gate.sh" --pr
    ( cd "${ROOT}" && npm run build:open-next )
    ;;
  diff)
    collect_observation "$(mktemp)" 1200
    for entry in "${STACKS[@]}"; do run_diff_gate "${entry%%:*}" "${entry##*:}"; done
    ;;
  deploy)
    collect_observation "$(mktemp)" 2400
    for entry in "${STACKS[@]}"; do run_diff_gate "${entry%%:*}" "${entry##*:}"; done
    cs_name="$(changeset_name)"
    ( cd "${ROOT}/infra" && npx cdk deploy "${STACK_NAMES[@]}" \
        -c env="${DEPLOY_ENV}" \
        -c "@aws-cdk/core:bootstrapQualifier=${QUALIFIER}" \
        --toolkit-stack-name "${TOOLKIT_STACK_NAME}" \
        --change-set-name "${cs_name}" \
        --require-approval broadening )
    ;;
  smoke)
    if [ -z "${OR_SMOKE_URL:-}" ]; then
      echo "OR_SMOKE_URL が未設定です（デプロイ済み URL を渡してください）" >&2
      exit 2
    fi
    "${ROOT}/scripts/url-quality-gate.sh" "${OR_SMOKE_URL}"
    ( cd "${ROOT}" && E2E_BASE_URL="${OR_SMOKE_URL}" npm run test:e2e:live )
    ;;
esac
