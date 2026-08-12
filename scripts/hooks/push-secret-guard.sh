#!/usr/bin/env bash
#
# scripts/hooks/push-secret-guard.sh — PreToolUse(Bash) フック。`git push` の直前に
# gitleaks で秘密情報スキャンを行い、検出したらブロックする（issue #682）。
#
# ## なぜ要るか
#
# `scripts/quality-gate.sh` が gitleaks を走らせるのは `--secrets` / `--full` のときだけで、
# その `--pr` / `--full` は既定でクラウド委譲（CLAUDE.md）。実際の流れは
#
#   実装 → --fast（gitleaks なし）→ git push → クラウドで --full（gitleaks あり）
#                                       ↑ ここで初めて外部へ出る
#
# つまり **push 前にローカルで秘密情報を見る検査が存在しなかった**。#680 では調査結果に
# 実 AWS アクセスキー ID を貼ったまま push しようとし、止めたのは GitHub の push protection
# だけだった（public リポジトリ）。本フックはその push という「外部へ出る境界」そのものを
# 監視する（`pr-gate-guard.sh` が `gh pr create`/`merge` という境界を監視するのと同じ位置づけ）。
#
# ## `--fast` へ足さなかった理由
#
# `gitleaks detect` は git 履歴を走査する。`.gitleaksignore` の指紋は
# `<commit>:<file>:<rule>:<line>` で **commit SHA** を含むため、`--no-git`（作業ツリーのみ・
# 履歴を見ない）にすると指紋の形式が変わり、既知の受容フィクスチャが再び検出されうる
# （`quality-gate.sh` の secrets ステップのコメント参照）。加えて `--no-git` は毎回の
# `--fast`（内側ループ）に足すことになり、変更ごとに実行される負荷が乗る。
#
# 本フックは push という**低頻度の境界アクション**でのみ発火し、かつ **push しようとしている
# コミット範囲だけ**（`<base>..HEAD`）を履歴付きで走査する。履歴付きなので commit SHA ベースの
# 既存 `.gitleaksignore` 指紋がそのまま使え、新しい指紋形式を増やす必要が無い。範囲を絞るので
# 全履歴の unshallow も不要（ローカル開発機は基本 shallow ではないが、範囲を絞ることで
# そもそも触れる履歴が小さく保たれる）。
#
# ## gitleaks が無い場合
#
# `scripts/quality-gate.sh` の他の任意ツール（gitleaks 自身・semgrep・lhci）と同じ規約:
# 既定は **SKIP**（stderr に明示の警告を出した上で push は通す＝「無言で通す」ことはしない）。
# `OPEN_RECEPTION_STRICT_SECRET_SCAN=1` を立てると `--strict` 相当で **FAIL**（push をブロック）
# に切り替わる。
#
# 終了コード: 0=許可 / 2=ブロック（stderr の内容が Claude に返る）
#
# 明示的に迂回する場合のみ:
#   OPEN_RECEPTION_SKIP_SECRET_SCAN=1 git push ...

set -u

# 早期 exit を最優先する: 本フックは全 Bash 呼び出しで起動されるため、
# 対象コマンドでなければ git にも gitleaks にも触れずに即座に抜ける。
payload="$(cat)"
tool="$(printf '%s' "${payload}" | jq -r '.tool_name // ""')"
[ "${tool}" = "Bash" ] || exit 0

cmd="$(printf '%s' "${payload}" | jq -r '.tool_input.command // ""')"

# 「データとして書かれた言及」を落としてから判定する（pr-gate-guard.sh と同じ方針）。
#   1. ヒアドキュメントの本文（コミットメッセージ・ドキュメント生成）
#   2. 引用符で囲まれた文字列
#   3. `#` 以降の行コメント
scan="$(printf '%s' "${cmd}" | perl -0777 -pe "
  s/<<-?\s*(['\"]?)(\w+)\1.*?^[ \t]*\2[ \t]*\$//gms;
  s/'[^']*'//g;
  s/\"[^\"]*\"//g;
  s/(^|\s)#[^\n]*//g;
" | tr '\n' ' ')"

printf '%s' "${scan}" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+push([[:space:]]|$)' || exit 0

# 明示的な迂回。フック自身の環境変数と、コマンド行に書かれたインライン代入の両方を見る
# （フックは対象コマンドの**実行前に別プロセスとして**起動されるため、
# `VAR=1 git push ...` はフック側の環境には届かない。迂回がコマンドとして transcript に
# 残るぶん監査上も望ましい）。
if [ "${OPEN_RECEPTION_SKIP_SECRET_SCAN:-0}" = "1" ] ||
   printf '%s' "${scan}" | grep -Eq '(^|[;&|[:space:]])OPEN_RECEPTION_SKIP_SECRET_SCAN=1([[:space:]]|$)'; then
  exit 0
fi

# git リポジトリ外では判定できない（git push 自体が失敗するはずなので実害も無い）。
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

if ! command -v gitleaks >/dev/null 2>&1; then
  if [ "${OPEN_RECEPTION_STRICT_SECRET_SCAN:-0}" = "1" ]; then
    cat >&2 <<'EOF'
BLOCKED by push-secret-guard.sh: gitleaks が見つからないため秘密情報スキャンを実行できません。

OPEN_RECEPTION_STRICT_SECRET_SCAN=1 が設定されているため、未スキャンでの push は許可しません
（scripts/quality-gate.sh の --strict と同じ扱い）。

対処:
  - gitleaks をインストールする（brew install gitleaks）
  - どうしても迂回する場合のみ: OPEN_RECEPTION_SKIP_SECRET_SCAN=1 git push ...
EOF
    exit 2
  fi
  echo "⚠️  push-secret-guard.sh: gitleaks not installed — secret scan SKIPPED (push allowed). Install gitleaks or set OPEN_RECEPTION_STRICT_SECRET_SCAN=1 to block instead." >&2
  exit 0
fi

# push しようとしている範囲だけを対象にする。base が分からない場合のみ全履歴へ
# フォールバックする（commit SHA ベースの指紋は変わらないので .gitleaksignore はそのまま効く）。
base_ref=""
for candidate in origin/main main origin/master master; do
  if git rev-parse --verify -q "${candidate}" >/dev/null 2>&1; then
    base_ref="${candidate}"
    break
  fi
done

if [ -n "${base_ref}" ]; then
  out="$(gitleaks detect --no-banner --redact --log-opts="${base_ref}..HEAD" 2>&1)"
else
  out="$(gitleaks detect --no-banner --redact 2>&1)"
fi
status=$?

if [ "${status}" -eq 0 ]; then
  exit 0
fi

if [ "${status}" -eq 1 ]; then
  cat >&2 <<EOF
BLOCKED by push-secret-guard.sh: gitleaks が push しようとしているコミットの中に秘密情報らしき
文字列を検出しました。

${out}

対処:
  - 実 secret なら push しない。当該コミットから取り除く（履歴に残っているなら
    git filter-repo 等で除去してから push）
  - 既知の受容済みフィクスチャ（テスト等）なら .gitleaksignore に指紋を追加する
    （<commit>:<file>:<rule>:<line> の形式。書いてある指紋そのものは検出値を含めない）
  - どうしても迂回する場合のみ: OPEN_RECEPTION_SKIP_SECRET_SCAN=1 git push ...
EOF
  exit 2
fi

# 0/1 以外（想定外のエラー）: スキャンを完了できなかった。無言で通さず警告した上で許可する
# （quality-gate.sh の skip_unverified と同じ「検査できなかった」扱い。実 secret を検出した
# ときの skip_or_fail 相当の扱いとは意味が違う）。
echo "⚠️  push-secret-guard.sh: gitleaks did not complete normally (exit ${status}) — secret scan UNVERIFIED (push allowed). Review manually. Output:" >&2
printf '%s\n' "${out}" >&2
exit 0
