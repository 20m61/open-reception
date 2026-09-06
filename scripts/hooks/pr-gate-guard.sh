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
if tool="$(printf '%s' "${payload}" | jq -r '.tool_name // ""' 2>/dev/null)" && [ -n "${tool}" ]; then
  payload_readable=1
else
  # 🔴 **「落ちた」だけでなく「空を返した」も判定不能である。** jq が exit 0 で空を返す・
  # payload に tool_name が無い場合、`tool=""` は `[ "${tool}" = "Bash" ] || exit 0` を通って
  # **Bash 経路も MCP 経路も無検査で許可**になっていた（4 周目のレビュー）。
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
    # tool_name は読めたのに command が読めない／空、という劣化もある。判定材料が
    # 無いのだから deny 側（payload をそのまま素朴に検査する枝）へ倒す。
    if ! cmd="$(printf '%s' "${payload}" | jq -r '.tool_input.command // ""' 2>/dev/null)" || [ -z "${cmd}" ]; then
      cmd="${payload}"; payload_readable=0
    fi
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
# 🔴 **whitelist は「狭くて退屈」でなければならない。** 3 周目のレビューは、緩い whitelist が
# そのまま実行経路になることを 3 つ実証した:
#
#   - `GIT_EXTERNAL_DIFF=./scripts/merge-pull-request.ts git diff` … 先頭の環境変数代入を
#     読み飛ばしていたため、**実際にスクリプトが起動した**
#   - `cat "'" a.txt; gh pr merge 12 "'"` … 引用を正規表現で潰していたため、シェルとは
#     違う対応付けになり `;` が消えた
#   - `sed -n "w /tmp/m.ts" <path>` / `./bin/cat <path>` … `sed` はファイルを書けて
#     （GNU sed は `e` でコマンドも起動する）、basename だけ見ると綴りを詐称できる
#
# よって:
#   - **引用はシェルの規則どおりに辿る**（正規表現の対消しをやめ、状態機械で走査する）
#   - **環境変数代入は無害な名前だけ**（`LC_*` / `LANG` / `TZ`）。値にも検出語を許さない
#   - **先頭語に `/` を含むものは通さない**（綴りの詐称を防ぐ）
#   - **`sed` は allowlist に入れない**（`w` / `e` / `r` を素朴に判定できない）
#   - `$` と backtick は引用の中でも展開が起きるので、現れた時点で落とす
#
# ここから 1 つでも外れたら 2 の従来判定へ落ちる。**つまり「見落とした綴り」は
# 常にブロックされる側へ倒れる** —— 綴りを足し忘れても穴にならない。
# 代償は誤ブロックが残ることで、それは #960 が消したかった痛みだが、
# **穴を開けるより誤発火を残すほうが安い**（迂回は transcript に残る脱出ハッチがある）。
#
# 🔴 **このガードが止めているのは「うっかり」であって、故意の迂回ではない。**
# 2 コマンドに分ければ何でもできるし、`bash -c "..."` は 1 段目にも 2 段目にも掛からない。
# 止めたいのは「ゲートを回し忘れたまま PR / マージへ進む」ことだけである。
PLAIN_READ_PREDICATE='
  my $cmd = do { local $/; <STDIN> };
  # stderr の始末は読み取り調査で日常的に打つ。ファイルは作れないので先に外す。
  $cmd =~ s{2>\s*/dev/null}{}g;
  $cmd =~ s{2>&1}{}g;

  # 🔴 **解釈しない。** バックスラッシュ・`$`・backtick・波括弧・改行が現れたら、
  # その時点で 2 段目へ落とす。ここを「正しく解釈しよう」とした版は、レビューのたびに
  # bash との差を出した（行継続で語をつなぐ / `$(...)` / `${IFS}` / `{a,b}` 展開 /
  # 語中の `#`）。**解釈しなければ差は生まれない** —— 残った部分集合では、語の切れ目は
  # 「引用の外の空白」だけで決まり、bash と一致する（エスケープも展開も無いため）。
  exit 1 if $cmd =~ /[\\\$`{}\n\r]/;

  my $MENTION = qr{scripts/(merge|create)-pull-request\.ts};
  # 読み取り専用の道具。**他プロセスを起動できる／ファイルを書けるものは入れない**
  # （`find` / `fd` の -exec、`sort --compress-program`、`awk` の system()、
  #  `less` / `more` の `!` と LESSOPEN、`xargs`、`sed` の `w` `e` `r`、`tee`、
  #  そして `uniq` —— 第 2 位置引数が**出力ファイル**になる）。
  my %READ = map { $_ => 1 } qw(
    grep egrep fgrep rg cat head tail wc nl cut tr
    diff colordiff ls stat file column basename dirname realpath jq git
  );
  my %GIT_READ = map { $_ => 1 } qw(
    log show diff grep blame cat-file ls-files ls-tree describe status rev-parse
  );
  # 先頭に置いても道具の振る舞いを変えない変数だけ。`PATH` / `GIT_*` / `*_PAGER` /
  # `*_CONFIG*` / `LESSOPEN` は**起動するものを差し替えられる**ので通さない。
  my %SAFE_ENV = map { $_ => 1 } qw(LANG LC_ALL LC_COLLATE LC_CTYPE LC_MESSAGES LC_NUMERIC LC_TIME TZ);
  # 値としてプログラムや出力先を取る option。この直後に検出語が来たら通さない。
  my $VALUE_TAKES_PROGRAM = qr{(pager|pre|exec|program|output|file)$};

  # --- 語へ割る ------------------------------------------------------------
  # エスケープが無いので、引用の対応は左から素朴に取れる（bash と一致する）。
  my @tokens; my $cur = ""; my $has = 0; my $state = "none";
  for my $c (split //, $cmd) {
    if ($state eq "none") {
      if ($c eq chr(39)) { $state = "single"; $has = 1; next }
      if ($c eq chr(34)) { $state = "double"; $has = 1; next }
      if ($c =~ /\s/)    { push @tokens, $cur if $has; $cur = ""; $has = 0; next }
      if ($c eq "|")     { push @tokens, $cur if $has; $cur = ""; $has = 0; push @tokens, "\x00PIPE"; next }
      exit 1 if $c =~ /[;&<>()]/;   # 区切り・背景実行・リダイレクト・サブシェル
      $cur .= $c; $has = 1; next;
    }
    if ($c eq ($state eq "single" ? chr(39) : chr(34))) { $state = "none"; next }
    $cur .= $c;
  }
  exit 1 unless $state eq "none";   # 引用が閉じていない = 素朴に読めない
  push @tokens, $cur if $has;

  # --- 段ごとの判定 ---------------------------------------------------------
  my @stages = ([]);
  for my $t (@tokens) {
    if ($t eq "\x00PIPE") { push @stages, []; next }
    push @{$stages[-1]}, $t;
  }
  for my $stage (@stages) {
    my @t = @$stage;
    while (@t && $t[0] =~ /^([A-Za-z_]\w*)=/) {
      exit 1 unless $SAFE_ENV{$1};
      shift @t;
    }
    # basename へ正規化しないので、`./bin/cat` のようなフルパス起動はここで落ちる
    # （綴りを詐称して allowlist を通る形を作らせない）。
    my $c = @t ? $t[0] : "";
    exit 1 unless $READ{$c};
    # パスを値に取る option（`--out=/tmp/x`）。読んだ結果を別の場所へ置けると、
    # そこから実行できる（`cat X > /tmp/m.ts` と同じ族）。
    exit 1 if grep { /^-/ && m{=.*/} } @t;
    if ($c eq "git") {
      my $i = 1;
      while ($i < @t) {
        if ($t[$i] eq "-C" || $t[$i] eq "--git-dir" || $t[$i] eq "--work-tree") { $i += 2; next }
        last if $t[$i] !~ /^-/;
        $i++;
      }
      exit 1 unless $i < @t && $GIT_READ{$t[$i]};
      # `git show HEAD --output /tmp/m.ts -- <検出語>` は**内容をファイルへ書ける**。
      # 空白区切りだと上の `=.*/` 検査に掛からないので、綴りに関わらず拒む。
      exit 1 if grep { /^--output(=|$)/ } @t;
    }
    # 検出語は**位置引数**として現れていなければならない。option の値として渡す形
    # （`git grep --open-files-in-pager=<検出語>` / `rg --pre <検出語>`）は通さない ――
    # option の値に置くと、読み取りの道具がそれを**起動する**。
    for my $i (1 .. $#t) {
      next unless $t[$i] =~ $MENTION;
      exit 1 if $t[$i] =~ /^-/;
      my $prev = $t[$i - 1];
      next unless $prev =~ /^-/;
      exit 1 if $prev =~ $VALUE_TAKES_PROGRAM;
      # `-O` は git grep の pager 指定。他の道具の `-o` は値を取らないほうが普通
      # （`rg -o` = --only-matching）なので、git のときだけ見る。
      exit 1 if $c eq "git" && $prev =~ /^-[A-Za-z]*O$/;
    }
  }
  # 🔴 **作業証明を出す。** 終了コードだけで「素朴な読み取り」と断定すると、
  # perl が「落ちずに何もせず成功」しただけで**判定が丸ごと許可へ倒れる**（5 周目のレビュー）。
  print "PLAIN_READ_OK";
  exit 0;

'

if [ -z "${required}" ] && [ -n "${cmd}" ]; then
  # 🔴 終了コードではなく**作業証明**を見る（perl が何もせず成功しただけで
  # 許可へ倒れないように）。
  if [ "$(printf '%s' "${cmd}" | perl -e "${PLAIN_READ_PREDICATE}" 2>/dev/null)" = "PLAIN_READ_OK" ]; then
    exit 0
  fi
fi

# 2. 従来判定。「データとして書かれた言及」を落としてから、コマンド文字列へパターンを当てる。
# これをしないと、本フック自身を説明するコミットメッセージ（`gh pr merge` という文字列を
# 含む）で git commit がブロックされる、という誤検知を踏む。
#
# 🔴 **引用の対消しを正規表現でやらない。** シェルとは違う対応付けになる:
# `cat "<単引用符>" a.txt; gh pr merge 12 "<単引用符>"` は、正規表現だと引用が
# 「二重引用符の中の単引用符 2 つ」で対になり、**その間の `;` ごと消えて**
# `gh pr merge` が判定から落ちる（3 周目のレビューが実証。変更前からの穴）。
# 1 段目と同じ走査でトークンへ割り、**空白を含む引用（＝散文）から来たトークンだけ**を捨てる。
#
# 🔴 **引用したパスでの実行を素通りさせない。** `npx tsx "scripts/merge-pull-request.ts" 1` は
# 変更前の実測で通っていた ―― 迂回が「クォートを 2 つ足す」で済むなら、止めたい実行も
# 同じ手ですり抜ける。空白を含まない引用はトークンなので中身を残す。
#
# 🔴 **抽出に失敗したら deny 側へ倒す。** perl が無い／引用が閉じていない場合に空文字を
# 返すと、以降の grep が全部外れて**ガードが丸ごと無言で無効化**される（fail-open）。
# 判定できないときは生のコマンドをそのまま渡す。
LEGACY_SCAN='
  my $cmd = do { local $/; <STDIN> };
  # 🔴 **行継続はシェルが畳む。** `gh pr \<改行> merge 12` は `gh pr merge 12` として
  # 実行されるので、先に畳んでおかないと行単位の grep が取りこぼす（5 周目のレビュー）。
  $cmd =~ s/\\\n//g;
  # ヒアドキュメントの本文（コミットメッセージ・ドキュメント生成）は判定対象外
  $cmd =~ s/<<-?\s*(["\x27]?)(\w+)\1.*?^[ \t]*\2[ \t]*$//gms;
  my @out; my $cur = ""; my $has = 0; my $prose = 0; my $expand = 0; my $state = "none";
  my @ch = split //, $cmd;
  # 🔴 二重引用符の中でも `$(...)` と backtick は**展開されて実行される**ので、
  # 空白を含んでいても散文として捨てない（`grep "$(npx tsx scripts/...)" x` が
  # 素通りしていた。実測）。
  my $flush = sub {
    if ($has && (!$prose || $expand)) {
      # `$(` `)` backtick は語の切れ目。潰さないと `"$(gh pr merge 12)"` の `gh` が
      # `(` に隣接して、判定側の `(^|[;&|[:space:]])gh` に一致しない（5 周目のレビュー）。
      my $t = $cur; $t =~ s/[\$`()]/ /g;
      push @out, $t;
    }
    $cur = ""; $has = 0; $prose = 0; $expand = 0;
  };
  for (my $i = 0; $i < @ch; $i++) {
    my $c = $ch[$i];
    if ($state eq "none") {
      if ($c eq chr(92)) { $i++; last if $i >= @ch; $cur .= $ch[$i]; $has = 1; next }
      if ($c eq chr(39)) { $state = "single"; $has = 1; next }
      if ($c eq chr(34)) { $state = "double"; $has = 1; next }
      # 🔴 **`#` がコメントを始めるのは語の先頭だけ**（bash の規則）。語中の `#` まで
      # コメント扱いにすると `cat a.txt#z; gh pr merge 12` の `;` 以降が消える
      # （4 周目のレビュー。変更前の正規表現は「前が空白」を要求していた）。
      if ($c eq "#" && !$has) { $i++ while $i < @ch && $ch[$i] ne "\n"; $flush->(); next }
      if ($c =~ /\s/)    { $flush->(); next }
      # 🔴 リダイレクトは**語の間に置ける**（`gh pr >/dev/null merge 12`）。演算子を
      # 区切りとして残すと `gh pr` と `merge` が分断されて判定から落ちるので、
      # 演算子とその行き先を捨てる。
      if ($c eq "<" || $c eq ">") {
        $flush->();
        $i++ while $i + 1 < @ch && $ch[$i + 1] =~ /[>&\s]/;
        $i++ while $i + 1 < @ch && $ch[$i + 1] !~ /\s/;
        next;
      }
      if ($c =~ /[;&|()`]/) { $flush->(); push @out, $c; next }
      $cur .= $c; $has = 1; next;
    }
    my $q = $state eq "single" ? chr(39) : chr(34);
    if ($c eq $q) { $state = "none"; next }
    if ($state eq "double" && $c eq chr(92)) { $i++; last if $i >= @ch; $cur .= $ch[$i]; next }
    # 空白を含む引用は散文（コミットメッセージ・説明文）。そのトークンごと捨てる
    $prose = 1 if $c =~ /\s/;
    # 🔴 展開されて**実行される**のは `$(...)` と backtick だけ。裸の `$VAR` まで
    # expand 扱いにすると、`git commit -m "… ($USER)"` のような散文が誤ブロックになる
    # （5 周目のレビュー。このフックが最初に踏んだ誤検知と同じ形）。
    $expand = 1 if $state eq "double" && $c eq chr(96);
    $expand = 1 if $state eq "double" && $c eq chr(36) && $i + 1 < @ch && $ch[$i + 1] eq "(";
    $cur .= $c;
  }
  exit 1 unless $state eq "none";   # 引用が閉じていない = 素朴に読めない
  $flush->();
  print join(" ", @out);
  exit 0;
'
if [ "${payload_readable}" = "0" ]; then
  # 🔴 payload を読めなかったときは、引用の除去そのものが危険になる。
  # payload は JSON なのでコマンド全体が二重引用符の中にあり、「空白を含む引用＝散文」の
  # 規則がコマンドを丸ごと捨ててしまう（実測でこれが fail-open だった）。
  # 記号を空白へ潰して、素朴な語の並びとして検査する。
  # 記号を空白へ潰して、素朴な語の並びとして検査する。**外部コマンドを使わない** ――
  # ここは「道具が落ちている」経路なので、`tr` を挟むと同じ穴がもう 1 段増える
  # （実測: jq と tr が同時に落ちると `gh pr merge` が JSON の引用に囲まれて素通りした）。
  scan="${payload//[!A-Za-z0-9\/._=-]/ }"
  # 🔴 **MCP のツール名も見る。** payload を読めていないので `tool` は "Bash" に倒して
  # あるが、素通しすると 2026-08-21 に main を red にした経路（MCP でのマージ）が
  # 無言で開く。`tr` の後も `_` は残るので素朴に拾える。
  if printf '%s' "${scan}" | grep -q 'mcp__github__merge_pull_request'; then
    required="full"; action="GitHub MCP でのマージ (payload を読めていない)"
  elif printf '%s' "${scan}" | grep -q 'mcp__github__create_pull_request'; then
    required="pr"; action="GitHub MCP での PR 作成 (payload を読めていない)"
  fi
elif ! scan="$(printf '%s' "${cmd}" | perl -e "${LEGACY_SCAN}" 2>/dev/null)"; then
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
