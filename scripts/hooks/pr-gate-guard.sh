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
# 🔴 **jq が落ちたら deny 側へ倒す。** 失敗を空文字として扱うと `tool` が "" になり、
# Bash 経路も MCP 経路も判定されずに素通りする（ガードが丸ごと無言で無効化される）。
# 読めなかったときは payload 全体を Bash のコマンドとみなして素朴に検査する。
if tool="$(printf '%s' "${payload}" | jq -r '.tool_name // ""' 2>/dev/null)"; then
  payload_readable=1
else
  tool="Bash"; payload_readable=0
fi

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
  if [ "${payload_readable}" = "1" ]; then
    cmd="$(printf '%s' "${payload}" | jq -r '.tool_input.command // ""' 2>/dev/null)" || cmd="${payload}"
  else
    cmd="${payload}"
  fi
fi

# ---------------------------------------------------------------------------
# 判定は 2 段。
#
#   1. **素朴な読み取りコマンドなら、そこで通す**（#960）
#   2. それ以外は、従来どおりコマンド文字列そのものへパターンを当てる
#
# 🔴 **1 は whitelist であって、実行形の blacklist ではない。**
#
# 最初の実装は逆向きだった ―― コマンドを塊へ割り、「読み取りに見える塊」を判定対象から
# 落としていた。独立レビューが 2 周にわたって抜け道を出し、**そのたびに綴りを 1 つ足す**
# 形になった（`|&` → プロセス置換 → `&>` → `sed --in-place` → `git grep -O` …）。
# `.claude/rules/opus5-autonomous-loop.md`「値を調整している自分には気づけない」の型なので、
# 前提を替えた: **落とすのではなく、通すものを列挙する。**
#
# 通すのは「シェルの機能を一切使わない、読み取り専用コマンドのパイプライン」だけ:
#
#   - `;` `&` `&&` `||` backtick `$(` `<(` `>(` `>` ヒアドキュメント を含まない
#     （リダイレクトも背景実行も置換も無い ―― 「読んだ結果を置いてから実行する」形が作れない）
#   - 各段の先頭語が読み取り専用の道具（`git` は読み取りサブコマンドのみ）
#   - 検出語が**位置引数**として現れている（`--pager=<検出語>` のように option の値として
#     渡されていたら通さない ―― `sort --compress-program` / `git grep -O` はこの形）
#   - パスを値に取る option（`--out=/tmp/x`）を含まない
#
# ここから 1 つでも外れたら 2 の従来判定へ落ちる。**つまり「見落とした綴り」は
# 常に従来どおりブロックされる側へ倒れる** —— 綴りを足し忘れても穴にならない。
# 代償は誤ブロックが残ることで、それは #960 が消したかった痛みだが、
# **穴を開けるより誤発火を残すほうが安い**（迂回は transcript に残る脱出ハッチがある）。
PLAIN_READ_PREDICATE='
  my $cmd = do { local $/; <STDIN> };
  # 読み取り専用の道具。**他プロセスを起動できるものは入れない**
  # （`find` / `fd` の -exec、`sort --compress-program`、`awk` の system()、
  #  `less` / `more` の `!` と LESSOPEN、`xargs`）。
  my %READ = map { $_ => 1 } qw(
    grep egrep fgrep rg ag ack cat bat head tail sed wc nl cut tr uniq
    diff colordiff ls stat file column basename dirname realpath jq yq git
  );
  my %GIT_READ = map { $_ => 1 } qw(
    log show diff grep blame cat-file ls-files ls-tree describe status rev-parse
  );
  # 引用の中身は構造の判定から隠す（メタ文字だけ潰す。中身は位置の判定で使う）
  $cmd =~ s/\x27([^\x27]*)\x27/ my $t = $1; $t =~ tr{|&;()`<>\n}{\x01}; $t /ge;
  $cmd =~ s/"([^"]*)"/ my $t = $1; $t =~ tr{|&;()`<>\n}{\x01}; $t /ge;
  # `2>/dev/null` だけは通す（読み取り調査で日常的に打つ。stderr を捨てるだけで
  # 「読んだ結果を置いてから実行する」形は作れない）。他の `>` は全部拒む ――
  # `cat X 2>&1 > /tmp/m.ts` は 2 つ目の `>` で落ちる。
  $cmd =~ s{2>\s*/dev/null}{}g;
  exit 1 if $cmd =~ /[;&`>\n]/;                 # 区切り・背景実行・置換・リダイレクト
  exit 1 if $cmd =~ /\$\(|<\(|\|\|/;
  my @stages = split /\|/, $cmd, -1;
  exit 1 unless @stages;
  for my $stage (@stages) {
    my @t = grep { length } split /\s+/, $stage;
    shift @t while @t && $t[0] =~ /^[A-Za-z_]\w*=/;   # 先頭の環境変数代入
    exit 1 unless @t;
    my $c = $t[0]; $c =~ s{.*/}{};                    # /usr/bin/grep → grep
    exit 1 unless $READ{$c};
    exit 1 if $c eq "sed" && grep { /^(-i|--in-place)/ } @t;
    if ($c eq "git") {
      my $i = 1;
      while ($i < @t) {
        if ($t[$i] eq "-C" || $t[$i] eq "--git-dir" || $t[$i] eq "--work-tree") { $i += 2; next }
        last if $t[$i] !~ /^-/;
        $i++;
      }
      exit 1 unless $i < @t && $GIT_READ{$t[$i]};
    }
    # 検出語は**位置引数**として現れていなければならない。option の値として渡す形
    # （`--open-files-in-pager=<検出語>` / `--open-files-in-pager <検出語>`）は通さない ――
    # option の値に置くと、読み取りの道具がそれを**起動する**（git grep の pager がその例で、
    # 独立レビューが実際に任意スクリプトを走らせて見せた）。
    # ヒアドキュメント（`<<`）とパスを値に取る option（`--out=/tmp/x`）を明示的に拒む枝は
    # 置いていない ―― どちらも「改行を含む」「サブコマンド位置に値が来る」で既に落ちており、
    # 変異を当てても行列が気づかなかった（＝死んだ枝）。
    for my $i (0 .. $#t) {
      next unless $t[$i] =~ m{scripts/(merge|create)-pull-request\.ts|repos/[^\s]+/pulls/[0-9]+/merge};
      exit 1 if $t[$i] =~ /^-/;
      # 直前が「値としてプログラム／出力先を取る option」なら通さない。
      # 長い option 全部（`--compress-program <検出語>`）と、`-o` / `-O` で終わる
      # 短い option（`git grep -O <検出語>` は pager としてそれを起動する）。
      # `--` は位置引数の区切りなので除く。`head -20 <検出語>` のような
      # 「値を取らない短い option の直後」は通す（読み取りの日常形）。
      next if $i == 0;
      my $prev = $t[$i - 1];
      exit 1 if $prev =~ /^--./;
      exit 1 if $prev =~ /^-[A-Za-z]*[oO]$/;
    }
  }
  exit 0;
'

if [ -z "${required}" ] && [ -n "${cmd}" ]; then
  if printf '%s' "${cmd}" | perl -e "${PLAIN_READ_PREDICATE}" 2>/dev/null; then
    exit 0
  fi
fi

# 2. 従来判定。「データとして書かれた言及」を落としてから、コマンド文字列へパターンを当てる。
# これをしないと、本フック自身を説明するコミットメッセージ（`gh pr merge` という文字列を
# 含む）で git commit がブロックされる、という誤検知を踏む。落とす対象は順に:
#   1. ヒアドキュメントの本文（コミットメッセージ・ドキュメント生成）
#   2. 引用符で囲まれた**散文**（guard-destructive.sh と同じ方針）
#   3. `#` 以降の行コメント
#
# 🔴 **引用符を一律に落とすと、引用したパスでの実行が素通りする** (#960)。
# `npx tsx "scripts/merge-pull-request.ts" 1` は変更前の実測で通っていた ―― 迂回が
# 「クォートを 2 つ足す」で済むなら、止めたい実行も同じ手ですり抜ける。
# 空白を含まない引用は**トークン（パス・引数）**なので中身を残し、空白を含む引用を
# 散文として落とす。コミットメッセージは空白を含むので従来どおり落ちる。
#
# 🔴 **抽出に失敗したら deny 側へ倒す。** perl が無い環境で空文字を返すと、以降の grep が
# 全部外れて**ガードが丸ごと無言で無効化**される（fail-open）。判定できないときは
# 生のコマンドをそのまま渡す。
LEGACY_FILTER="
  s/<<-?\s*(['\"]?)(\w+)\1.*?^[ \t]*\2[ \t]*\$//gms;
  s/'([^'\s]*)'/\$1/g;
  s/\"([^\"\s]*)\"/\$1/g;
  s/'[^']*'//g;
  s/\"[^\"]*\"//g;
  s/(^|\s)#[^\n]*//g;
"
if [ "${payload_readable}" = "0" ]; then
  # 🔴 payload を読めなかったときは、引用の除去そのものが危険になる。
  # payload は JSON なのでコマンド全体が二重引用符の中にあり、「空白を含む引用＝散文」の
  # 規則がコマンドを丸ごと捨ててしまう（実測でこれが fail-open だった）。
  # 記号を空白へ潰して、素朴な語の並びとして検査する。
  scan="$(printf '%s' "${payload}" | tr -c 'A-Za-z0-9/._=-' ' ')"
elif ! scan="$(printf '%s' "${cmd}" | perl -0777 -pe "${LEGACY_FILTER}" 2>/dev/null)"; then
  scan="${cmd}"
fi

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
