#!/usr/bin/env bash
#
# scripts/hooks/pr-gate-guard.sh — PreToolUse フック（Bash と GitHub MCP ツール）。
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
#
# 🔴 **Bash だけを見ていると迂回される。** このフックは `gh pr merge` → スクリプト →
# 生 REST と、経路が変わるたびに穴を塞いできた（下の分岐の履歴がそれ）。次の穴は
# **GitHub MCP ツール**だった ── `mcp__github__merge_pull_request` は Bash を通らないので
# PreToolUse(Bash) からは見えない。2026-08-21、`--pr` しか回していない PR がこの経路で
# マージされ、**main が sast で red になった**（`sast` は `--full` でしか走らない）。
# よって MCP のツール名も見る。

set -u

# 早期 exit を最優先する: 本フックは全 Bash 呼び出しで起動されるため、
# 対象コマンドでなければ git にも触れずに即座に抜ける。
payload="$(cat)"
tool="$(printf '%s' "${payload}" | jq -r '.tool_name // ""')"

required=""
action=""

# GitHub MCP 経由の PR 作成・マージ。**Bash を通らない**ので、コマンド文字列は見ない。
case "${tool}" in
  mcp__github__merge_pull_request)
    required="full"; action="GitHub MCP でのマージ (${tool})" ;;
  mcp__github__create_pull_request)
    required="pr"; action="GitHub MCP での PR 作成 (${tool})" ;;
esac

if [ -n "${required}" ]; then
  cmd=""
else
  [ "${tool}" = "Bash" ] || exit 0
  cmd="$(printf '%s' "${payload}" | jq -r '.tool_input.command // ""')"
fi

# 「データとして書かれた言及」を落としてから判定する。これをしないと、本フック自身を
# 説明するコミットメッセージ（`gh pr merge` という文字列を含む）で git commit が
# ブロックされる、という誤検知を踏む。落とす対象は順に:
#   1. ヒアドキュメントの本文（コミットメッセージ・ドキュメント生成）
#   2. 引用符で囲まれた**散文**（guard-destructive.sh と同じ方針）
#   3. `#` 以降の行コメント
#
# 🔴 **引用符を一律に落とすと、引用したパスでの実行が素通りする** (#960)。
# `npx tsx "scripts/merge-pull-request.ts" 1` は変更前の実測で通っていた ―― 迂回が
# 「クォートを 2 つ足す」で済むなら、止めたい実行も同じ手ですり抜ける。
# 空白を含まない引用は**トークン（パス・引数）**なので引用だけを外し、空白を含む引用を
# 散文として落とす。コミットメッセージは空白を含むので従来どおり落ちる。
scan="$(printf '%s' "${cmd}" | perl -0777 -pe "
  s/<<-?\s*(['\"]?)(\w+)\1.*?^[ \t]*\2[ \t]*\$//gms;
  s/'([^'\s]*)'/\$1/g;
  s/\"([^\"\s]*)\"/\$1/g;
  s/'[^']*'//g;
  s/\"[^\"]*\"//g;
  s/(^|\s)#[^\n]*//g;
")"

# 読み取りコマンドの引数として現れただけの塊を落とす (#960)。
#
# 変更前は「コマンド文字列に scripts/merge-pull-request.ts が含まれるか」だけを見ており、
# `grep -n delete scripts/merge-pull-request.ts | head -20` までブロックしていた。grep は
# 何もマージしないので、この発火はガードの目的（red のままマージさせない）に寄与しない。
# 一方で調査が止まり、誤発火が続けば OPEN_RECEPTION_SKIP_GATE_GUARD=1 の常用 ――
# 本リポジトリが繰り返し警告している「override の習慣化」―― へ倒れる。
#
# 判定は**既定 deny**にする。落とすのは「そのパイプラインの全段が読み取り専用コマンド」の
# ときだけで、実行しうる語（npx / node / tsx / xargs / bash / time / 未知のコマンド）が
# 1 つでも混じれば従来どおり見る。
#
# 🔴 **読み取りの出力が実行系へ流れる形を落とさない**のがここの肝である
# （`cat scripts/merge-pull-request.ts | bash`）。段ごとに落とすと、この形が
# 「cat の段だけ落ちて bash の段には言及が無い」で素通りする ―― 読み取りを通した結果
# 実行の検出が弱くなる、という今回の変更が作りうる穴そのものなので、判定単位は
# **パイプライン全体**にしてある。
scan="$(printf '%s' "${scan}" |
  perl -0777 -pe 's/(\&\&|\|\||[;&()`\n])/\n/g' |
  awk '
    function stage_is_read(text,   m, t, i, j, cmd) {
      m = split(text, t, /[ \t]+/)
      i = 1
      # 先頭の空要素と環境変数代入（FOO=1 cmd ...）を読み飛ばす
      while (i <= m && (t[i] == "" || t[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/)) i++
      if (i > m) return 1          # 実行語が無い（空の塊）
      # 🔴 読み取りコマンドでも、他のコマンドを起動する形は読み取りではない
      # （`find . -name x -exec npx tsx scripts/merge-pull-request.ts \;`）。
      for (j = i; j <= m; j++)
        if (t[j] == "-exec" || t[j] == "-execdir" || t[j] == "-ok" || t[j] == "-okdir") return 0
      cmd = t[i]
      sub(/^.*\//, "", cmd)       # /usr/bin/grep → grep（./scripts/x.ts → x.ts なので deny 側）
      if (cmd != "git") return (cmd in READ)
      # git はサブコマンドで読み書きが割れる。global option を飛ばして最初の語を見る
      j = i + 1
      while (j <= m && t[j] ~ /^-/) { if (t[j] == "-C" || t[j] == "-c") j++; j++ }
      return (j <= m && (t[j] in GIT_READ))
    }
    BEGIN {
      split("grep egrep fgrep rg ag ack cat bat head tail sed awk less more wc nl sort uniq cut tr diff colordiff ls stat file find fd tree jq yq column basename dirname realpath", r, " ")
      for (i in r) READ[r[i]] = 1
      split("log show diff grep blame cat-file ls-files ls-tree describe status rev-parse", g, " ")
      for (i in g) GIT_READ[g[i]] = 1
    }
    {
      n = split($0, stage, "|")
      for (s = 1; s <= n; s++) if (!stage_is_read(stage[s])) { print; next }
    }
  ')"

# Bash 経路の判定。**MCP 経路で既に決まっているならここは通さない**
# （空の scan が `else exit 0` に落ちて、せっかくの判定が捨てられる）。
if [ -z "${required}" ]; then
  if printf '%s' "${scan}" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)'; then
    required="full"; action="gh pr merge"
  elif printf '%s' "${scan}" | grep -q 'scripts/merge-pull-request\.ts'; then
    # 🔴 **マージの主経路も REST へ移った (#702)。**
    # クラウドでは `gh pr merge` が GraphQL 403 になるため、実際に使われるのはこちら。
    # 見ていないと**移した先がそのままゲートの抜け道**になる（#678 で作成側に開けかけた穴と同型）。
    required="full"; action="scripts/merge-pull-request.ts"
  elif printf '%s' "${scan}" | grep -Eq 'repos/[^[:space:]]+/pulls/[0-9]+/merge'; then
    # スクリプトを経由しない生の REST マージ（`gh api .../pulls/<n>/merge -X PUT`）。
    # **PR の照会（`.../pulls/<n>` や `.../pulls?...`）は止めない** —— 日常的に使うので、
    # ここを広く取ると誤検出でガードごと迂回される。`/merge` で終わる形だけを見る。
    required="full"; action="REST でのマージ (gh api .../pulls/<n>/merge)"
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
fi

# 明示的な迂回。フック自身の環境変数と、コマンド行に書かれたインライン代入の両方を見る。
#
# 後者が必須: 本フックは対象コマンドの**実行前に別プロセスとして**起動されるため、
# `OPEN_RECEPTION_SKIP_GATE_GUARD=1 gh pr merge ...` と書いてもフック側の環境には届かない。
# ドキュメントしている迂回方法はこの形であり、かつ迂回がコマンドとして transcript に
# 残るぶん監査上も望ましい。判定には引用符・heredoc を落とした ${scan} を使うので、
# 「文中で迂回方法に言及しただけ」では迂回できない。
#
# 🔴 **代入は「塊の先頭」でしか認めない** (#960)。上で空白を含まない引用の引用符を外す
# ようにしたため、`echo "OPEN_RECEPTION_SKIP_GATE_GUARD=1" && gh pr merge 12` が
# 迂回として通ってしまった（既存テストが検出）。シェルとしてもこの形は代入ではない。
# ${scan} は塊ごとに改行済みなので、行頭に立っているものだけを見る。
if [ "${OPEN_RECEPTION_SKIP_GATE_GUARD:-0}" = "1" ] ||
   printf '%s' "${scan}" | grep -Eq '^[[:space:]]*OPEN_RECEPTION_SKIP_GATE_GUARD=1([[:space:]]|$)'; then
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
