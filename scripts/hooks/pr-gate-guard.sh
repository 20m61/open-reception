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

# 判定対象を抽出する。「データとして書かれた言及」と「読み取りコマンドの引数としての言及」を
# 落としてから、パターンを当てる。
#
# 落とす対象は順に:
#   1. ヒアドキュメントの本文（コミットメッセージ・ドキュメント生成）
#   2. 引用符で囲まれた**散文**（guard-destructive.sh と同じ方針）
#   3. `#` 以降の行コメント
#   4. 全段が読み取り専用コマンドのパイプライン (#960)
#
# 🔴 **このガードが止めているのは「うっかり」であって、意図的な迂回ではない**
# （docs/quality-gate.md の委譲プロンプトの項と同じ立場）。迂回したい人には
# `OPEN_RECEPTION_SKIP_GATE_GUARD=1` という、transcript に残る道が用意してある。
# だから判定の設計方針は「あらゆる書き方を封じる」ではなく、**日常的に打つ形について
# 誤発火せず、日常的に打つ実行形を漏らさない**である。ただし緩める方向の変更では、
# 変更前に止まっていた形を必ず測り直す（.claude/rules/opus5-autonomous-loop.md）。
#
# 🔴 **引用符を一律に落とすと、引用したパスでの実行が素通りする** (#960)。
# `npx tsx "scripts/merge-pull-request.ts" 1` は変更前の実測で通っていた ―― 迂回が
# 「クォートを 2 つ足す」で済むなら、止めたい実行も同じ手ですり抜ける。
# 空白を含まない引用は**トークン（パス・引数）**なので中身を残し、空白を含む引用を
# 散文として落とす。コミットメッセージは空白を含むので従来どおり落ちる。
#
# 🔴 **ただし引用を外すと、引用の中のメタ文字がシェルの区切りとして再解釈される。**
# `rg -n 'create|merge' scripts/merge-pull-request.ts` が `|` で割れ、後半の塊の先頭語が
# `merge` になって読み取り扱いから外れる（＝誤ブロック）。中身は残しつつ、区切りに
# 使う文字だけを \x01 へ潰しておく（判定パターンにこれらの文字は現れない）。
QUOTE_AND_COMMENT_FILTER="
  s/<<-?\s*(['\"]?)(\w+)\1.*?^[ \t]*\2[ \t]*\$//gms;
  s/'([^'\s]*)'/ my \$t = \$1; \$t =~ tr{|&;()\`<>}{\x01}; \$t /ge;
  s/\"([^\"\s]*)\"/ my \$t = \$1; \$t =~ tr{|&;()\`<>}{\x01}; \$t /ge;
  s/'[^']*'//g;
  s/\"[^\"]*\"//g;
  s/(^|\s)#[^\n]*//g;
"

# 塊へ割る。区別が 2 つある:
#
#   - **段の連結**（`|` / `|&` / サブシェル・コマンド置換・プロセス置換の括弧・backtick）
#     … 同じ塊の中の段として残す。中身が実行系なら塊ごと判定対象に残るので、
#     `bash <(cat scripts/merge-pull-request.ts)` や `cat X |& bash` が読み取り扱いに
#     落ちない（🔴 ここを境界にすると、読み取りの段だけが落ちて実行の段に検出語が
#     残らない ―― `cat X | bash` と同じ穴が別の綴りで開く）
#   - **実行の境界**（`;` / `&&` / `||` / `&` / 改行）… 別々に判定する
#
# `|&` は `&&` / `&` より先に食わせる（`&` 単独の文字クラスに先に当たると塊が割れる）。
SEGMENT_SPLITTER='s/\|\&/|/g; s/[`()]/|/g; s/(\&\&|\|\||[;&\n])/\n/g'

# 読み取りコマンドの引数として現れただけの塊を落とす (#960)。
#
# 変更前は「コマンド文字列に scripts/merge-pull-request.ts が含まれるか」だけを見ており、
# `grep -n delete scripts/merge-pull-request.ts | head -20` までブロックしていた。grep は
# 何もマージしないので、この発火はガードの目的（red のままマージさせない）に寄与しない。
# 一方で調査が止まり、誤発火が続けば OPEN_RECEPTION_SKIP_GATE_GUARD=1 の常用 ――
# 本リポジトリが繰り返し警告している「override の習慣化」―― へ倒れる。
#
# 判定は**既定 deny**。落とすのは「そのパイプラインの全段が読み取り専用コマンド」のときだけで、
# 実行しうる語（npx / node / xargs / bash / time / 未知のコマンド）が 1 つでも混じれば従来どおり見る。
#
# 🔴 **段ごとに落とすと `cat scripts/merge-pull-request.ts | bash` が素通りする** ――
# 「読み取りを通した結果、実行の検出が弱くなる」形なので、判定単位はパイプライン全体。
#
# 🔴 **allowlist には「他プロセスを起動しない道具」しか入れない。** `find` / `fd` /
# `sort`（`--compress-program`）/ `awk`（`system()`）は起動できるので入れない ――
# 道具を 1 つ足すたびに同型の穴が増える族なので、疑わしいものは deny 側に置く。
# `tests/hooks/pr-gate-guard.test.ts` が allowlist の中身を静的に縛っている。
READ_ONLY_FILTER='
    function stage_is_read(text,   m, t, i, j, cmd) {
      m = split(text, t, /[ \t]+/)
      i = 1
      while (i <= m && (t[i] == "" || t[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/)) i++
      # 🔴 代入だけの塊を read にしない。`SCRIPT=scripts/merge-pull-request.ts; npx tsx $SCRIPT`
      # で検出語が消える（実行そのものは次の塊で起こる）。空白だけの塊は read でよい。
      if (i > m) return (text ~ /^[ \t]*$/)
      for (j = i; j <= m; j++) {
        if (t[j] ~ /^(-exec|-execdir|-ok|-okdir|-x|-X)$/) return 0
        if (t[j] ~ /^--(exec|exec-batch|compress-program)(=|$)/) return 0
        # 標準出力のリダイレクトと tee。読み取りの結果を別の場所へ置ける＝あとで実行できる
        # （stderr の `2>` は対象外。`grep ... 2>/dev/null` は日常的に打つ）
        if (t[j] ~ /^(1?>|>>|&>|>\|)/) return 0
      }
      cmd = t[i]
      sub(/^.*\//, "", cmd)
      if (cmd == "sed") { for (j = i; j <= m; j++) if (t[j] ~ /^-i/) return 0 }
      if (cmd != "git") return (cmd in READ)
      # git はサブコマンドで読み書きが割れる。`-c core.pager=...` のような
      # 「任意コマンドを起動しうる option」は、値がサブコマンド位置に来て GIT_READ に
      # 無いので deny 側へ落ちる（値を読み飛ばすのは -C / --git-dir / --work-tree だけ）。
      j = i + 1
      while (j <= m) {
        if (t[j] == "-C" || t[j] == "--git-dir" || t[j] == "--work-tree") { j += 2; continue }
        if (t[j] ~ /^-/) { j++; continue }
        break
      }
      return (j <= m && (t[j] in GIT_READ))
    }
    BEGIN {
      split("grep egrep fgrep rg ag ack cat bat head tail sed wc nl cut tr diff colordiff ls stat file column basename dirname realpath jq yq", r, " ")
      for (i in r) READ[r[i]] = 1
      split("log show diff grep blame cat-file ls-files ls-tree describe status rev-parse", g, " ")
      for (i in g) GIT_READ[g[i]] = 1
    }
    {
      n = split($0, stage, "|")
      for (s = 1; s <= n; s++) if (!stage_is_read(stage[s])) { print; next }
    }
'

# 🔴 **抽出に失敗したら deny 側へ倒す。** perl / awk が無い環境や、フィルタが落ちた場合に
# 空文字を返すと、以降の grep が全部外れて**ガードが丸ごと無言で無効化**される（fail-open）。
# 判定できないときは生のコマンドをそのまま渡し、従来どおりの素朴な包含判定に落とす。
extract_scan() {
  local raw="$1" out status
  out="$(
    set -o pipefail
    printf '%s' "${raw}" |
      perl -0777 -pe "${QUOTE_AND_COMMENT_FILTER}" |
      perl -0777 -pe "${SEGMENT_SPLITTER}" |
      awk "${READ_ONLY_FILTER}"
  )"
  status=$?
  if [ "${status}" -ne 0 ]; then
    printf '%s' "${raw}"
    return 0
  fi
  printf '%s' "${out}"
}

scan="$(extract_scan "${cmd}")"

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
   printf '%s' "${scan}" | grep -Eq '^[[:space:]]*(export[[:space:]]+)?OPEN_RECEPTION_SKIP_GATE_GUARD=1([[:space:]]|$)'; then
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
