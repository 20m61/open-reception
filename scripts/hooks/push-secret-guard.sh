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
#
# ## 検出できない経路（正直に書く。詳細は #682 の報告参照）
#
# 本フックは Claude Code の Bash ツール呼び出しに対する**文字列パターンマッチ**であり、
# `.git/hooks/pre-push` のような git 自体のフックでも OS レベルの強制でもない。以下は
# 塞いでいない: (1) シェル間接（`eval`、変数に入れたコマンド、push する別スクリプトの実行）
# — コマンド文字列に `git ... push` がそのまま現れないため、(2) 別バイナリの中で内部的に
# spawn される `git push` 子プロセス（例: `gh` が内部で push するケース）、(3) このセッションを
# 経由しない push（別ターミナル・別セッション・gitleaks 未導入のクラウド環境）、
# (4) **`git "push" origin HEAD` / `git 'push' ...` のようにサブコマンド自体を引用符で
# 囲んだ書き方**。上の引用符除去（2.）はトークンごと丸ごと消すため、「文字列として言及
# されただけの push」と「引用符で包んだ実サブコマンドとしての push」を区別できず、
# 後者もろとも消えて検出漏れになる。引用符の中身だけを剥がす向きに直すと、今度は
# 誤検出（`echo "gh pr merge"` のような地の文）を増やす方向に倒れるため、意図的に
# 直していない（#682 の報告に判断根拠あり）。稀な書き方だが、無いことにはしない。

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
#
# 🔴 **改行を潰す前に文単位（is_git_push）で見る必要がある。** 元々ここで `tr '\n' ' '`
# まで済ませていたため、複数行コマンドの改行が消え、「先頭行が git で始まらない」複数行
# コマンド（例: `echo hi` の次行に `git push`）が **1 つの非マッチな文へ結合**され、
# push が一度もスキャンされなかった（レビューで実際に踏んだ。Bash ツール呼び出しの
# ごく普通の形であり、回避手口ではない）。`scan_lines`（改行を残す）を is_git_push へ、
# `scan`（従来どおり空白へ平坦化・他の単純な grep 判定用）はそのまま残す。
scan_lines="$(printf '%s' "${cmd}" | perl -0777 -pe "
  s/<<-?\s*(['\"]?)(\w+)\1.*?^[ \t]*\2[ \t]*\$//gms;
  s/'[^']*'//g;
  s/\"[^\"]*\"//g;
  s/(^|\s)#[^\n]*//g;
")"
scan="$(printf '%s' "${scan_lines}" | tr '\n' ' ')"

# `git push` を「サブコマンド位置」で検出する。単純な `git\s+push` 正規表現だと
# `git -C <path> push` / `git --git-dir=... push` のように **global option を挟んだ**
# 呼び出しを取りこぼす（worktree 作業では `-C` を素直に使う）。一方で `git log --grep push`
# や `git config --get remote.origin.pushurl` のように「push」という語が引数として現れる
# だけのコマンドは誤検出したくない（誤検出はガードの回避を誘発し、検出漏れより悪い）。
#
# トークン単位で判定する: 先頭が git バイナリ（`git` そのもの、または `/path/to/git` の
# ように `/git` で終わるパス）であることを確認し、そこから先を左から読み、
# 値を separate 引数で取る global option（`-C`・`-c`・`--git-dir`・`--work-tree`・
# `--namespace`・`--exec-path`・`--super-prefix`）は 2 トークン、それ以外の `-` 始まりの
# トークン（`--git-dir=...` のような `=` 付き・`--no-pager` のような単体フラグ）は 1 トークン
# 読み飛ばす。最初に現れた非オプション・トークンが「サブコマンド」で、それが `push` なら
# 一致、`push` 以外（`log` 等）ならそのコマンドはそこで打ち切り、以降の引数（`--grep push`
# の `push` 等）は見ない。
is_git_push() {
  printf '%s' "$1" | perl -e '
    my $text = do { local $/; <STDIN> };
    my $found = 0;
    for my $stmt (split /[;&|\n]+/, $text) {
      my @tok = split " ", $stmt;
      next unless @tok;
      my $bin = $tok[0];
      next unless $bin eq "git" || $bin =~ m{/git\z};
      my $i = 1;
      while ($i <= $#tok) {
        my $t = $tok[$i];
        if ($t eq "push") { $found = 1; last; }
        last unless $t =~ /^-/;
        if ($t =~ /\A(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix)\z/) { $i += 2; }
        else { $i += 1; }
      }
      last if $found;
    }
    exit($found ? 0 : 1);
  '
}

is_git_push "${scan_lines}" || exit 0

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
