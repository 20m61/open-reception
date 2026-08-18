#!/usr/bin/env bash
#
# scripts/hooks/pr-gate-guard.sh — PreToolUse(Bash) フック。
#
# 本リポジトリは GitHub Actions を使わない方針なので `scripts/quality-gate.sh` が唯一の
# 品質ゲートだが、「PR 前に --pr / マージ前に --full」は規約（CLAUDE.md）上の**自己申告**
# でしかなかった。本フックは `gh pr create` / `gh pr merge` を実行直前に捕まえ、
# **今の作業ツリーに対する green なゲート実行の記録が無ければブロック**する。
#
# 判定は scripts/lib/gate-stamp.sh のスタンプ（.git 配下・worktree ごと）に基づく。
# ゲート後にファイルを 1 文字でも編集すると指紋が変わり、記録は stale として無効になる。
#
# 終了コード: 0=許可 / 2=ブロック（stderr の内容が Claude に返る）
#
# 意図的に迂回する場合のみ、明示的に環境変数を立てる:
#   OPEN_RECEPTION_SKIP_GATE_GUARD=1 gh pr create ...

set -u

# 早期 exit を最優先する: 本フックは全 Bash 呼び出しで起動されるため、
# 対象コマンドでなければ git にも触れずに即座に抜ける。
payload="$(cat)"
tool="$(printf '%s' "${payload}" | jq -r '.tool_name // ""')"
[ "${tool}" = "Bash" ] || exit 0

cmd="$(printf '%s' "${payload}" | jq -r '.tool_input.command // ""')"

# 「データとして書かれた言及」を落としてから判定する。これをしないと、本フック自身を
# 説明するコミットメッセージ（`gh pr merge` という文字列を含む）で git commit が
# ブロックされる、という誤検知を踏む。落とす対象は順に:
#   1. ヒアドキュメントの本文（コミットメッセージ・ドキュメント生成）
#   2. 引用符で囲まれた文字列（guard-destructive.sh と同じ方針）
#   3. `#` 以降の行コメント
scan="$(printf '%s' "${cmd}" | perl -0777 -pe "
  s/<<-?\s*(['\"]?)(\w+)\1.*?^[ \t]*\2[ \t]*\$//gms;
  s/'[^']*'//g;
  s/\"[^\"]*\"//g;
  s/(^|\s)#[^\n]*//g;
" | tr '\n' ' ')"

required=""
action=""
if printf '%s' "${scan}" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)'; then
  required="full"; action="gh pr merge"
elif printf '%s' "${scan}" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'; then
  required="pr"; action="gh pr create"
elif printf '%s' "${scan}" | grep -q 'scripts/create-pull-request\.ts'; then
  # 🔴 **REST 経由の PR 作成も同じ門を通す (#678)。**
  # クラウドセッションでは `gh pr create` が GraphQL 403 で使えないため PR 作成を
  # `scripts/create-pull-request.ts` へ移した。ここを見ていないと、**移した先が
  # そのままゲートの抜け道になる** —— 開発をクラウドへ移した後はそちらが主経路なので、
  # 抜け道の方が既定になってしまう。
  required="pr"; action="scripts/create-pull-request.ts"
else
  exit 0
fi

# 明示的な迂回。フック自身の環境変数と、コマンド行に書かれたインライン代入の両方を見る。
#
# 後者が必須: 本フックは対象コマンドの**実行前に別プロセスとして**起動されるため、
# `OPEN_RECEPTION_SKIP_GATE_GUARD=1 gh pr merge ...` と書いてもフック側の環境には届かない。
# ドキュメントしている迂回方法はこの形であり、かつ迂回がコマンドとして transcript に
# 残るぶん監査上も望ましい。判定には引用符・heredoc を落とした ${scan} を使うので、
# 「文中で迂回方法に言及しただけ」では迂回できない。
if [ "${OPEN_RECEPTION_SKIP_GATE_GUARD:-0}" = "1" ] ||
   printf '%s' "${scan}" | grep -Eq '(^|[;&|[:space:]])OPEN_RECEPTION_SKIP_GATE_GUARD=1([[:space:]]|$)'; then
  exit 0
fi

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/gate-stamp.sh"
# shellcheck source=../lib/gate-stamp.sh
. "${LIB}"

gate_stamp_satisfies "${required}"
case "$?" in
  0) exit 0 ;;                 # 要求 tier 以上の green 記録あり
  2) exit 0 ;;                 # git リポジトリ外 = 判定不能。gh 自体が動かないので素通し
esac

cat >&2 <<EOF
BLOCKED by pr-gate-guard.sh: ${action} の前に必要な品質ゲートが green になっていません。

このリポジトリは GitHub Actions を使わないため、./scripts/quality-gate.sh が唯一のゲートです
（CLAUDE.md「品質ゲート」/ docs/quality-gate.md）。**現在の作業ツリー**に対する
\`--${required}\` 以上の PASS 記録が見つかりませんでした。

原因は次のいずれかです:
  - まだゲートを走らせていない
  - 走らせた tier が不足している（例: --fast のみ。${action} には --${required} 以上が要る）
  - ゲート実行後にファイルを編集した（記録が stale になった。ゲートは実際に検査した
    ツリーの内容に紐づきます）

対処:
  ./scripts/quality-gate.sh --${required}
（worktree では、その worktree の絶対パスで起動してください。記録は worktree ごとに独立です。）

red のまま PR / マージしないこと。ゲートが落ちたら出力そのまま報告し、原因を潰してから
再実行してください。どうしても意図的に迂回する必要がある場合のみ:
  OPEN_RECEPTION_SKIP_GATE_GUARD=1 <command>
EOF
exit 2
