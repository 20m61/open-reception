#!/bin/bash
# PreToolUse guard: 明確に破壊的なシェルコマンドをブロックする。
#
# **なぜリポジトリに置くのか**: これまで同等のガードは各自の `~/.claude/hooks/` にあったが、
# ユーザ階層の設定は**クラウドセッション（Claude Code on the web）へ引き継がれない**。
# 自律ループをクラウドで回すとガードだけが消えるため、リポジトリ側へ移して
# ローカル・クラウドの双方で効くようにする（`docs/cloud-dev-environment.md`）。
# 各自の `~/.claude/hooks/` 版は他リポジトリ向けにそのまま残してよい（二重に走っても無害）。
#
# 入力: stdin に PreToolUse フックの JSON ペイロード。
# 終了コード: 2 = 理由を stderr に出してブロック / 0 = 許可。
#
# ここが守るのは CLAUDE.md「ガード」節の機械化: 保護ブランチへの force-push 禁止、
# `--no-verify` での迂回禁止、認証情報を文脈へ読み込まない、の 3 点が中心。

set -u

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // ""')

if [ "$tool" != "Bash" ]; then
  exit 0
fi

cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')

# 引用符で囲まれた部分を落としてから走査する。JSON ペイロードを echo するようなケースで
# 中身の文字列が誤検出されるのを避ける（完全ではないが典型例は拾える）。
scan=$(printf '%s' "$cmd" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")

block() {
  printf 'BLOCKED by guard-destructive.sh: %s\nCommand: %s\n' "$1" "$cmd" >&2
  exit 2
}

# 1. ホーム/ルートを丸ごと消す rm。
#    パスが **ちょうど** / , ~ , $HOME , /Users/<user> , /home/<user> , /root のときだけ止める
#    （/tmp/foo や /Users/x/scratch のような部分パスは通す）。
#    macOS は /Users/<user>、Linux（クラウドセッション）は /home/<user> と /root。
HOME_ROOTS='(/[[:space:]]*(\||&|;|$)|~[[:space:]]*(\||&|;|$)|~/[[:space:]]*(\||&|;|$)|\$HOME[[:space:]]*(\||&|;|$)|/Users/[^/[:space:]]+/?[[:space:]]*(\||&|;|$)|/home/[^/[:space:]]+/?[[:space:]]*(\||&|;|$)|/root/?[[:space:]]*(\||&|;|$))'
if printf '%s' "$scan" | grep -Eq "rm[[:space:]]+-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*[[:space:]]+${HOME_ROOTS}"; then
  block "mass-delete targeting home or root filesystem (/ , ~, \$HOME, /Users/<user>, /home/<user>, /root)"
fi
if printf '%s' "$scan" | grep -Eq "rm[[:space:]]+-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*[[:space:]]+${HOME_ROOTS}"; then
  block "mass-delete targeting home or root filesystem (/ , ~, \$HOME, /Users/<user>, /home/<user>, /root)"
fi

# 2. 保護ブランチへの force push。
if printf '%s' "$scan" | grep -Eq 'git[[:space:]]+push([[:space:]]+[^&|;]+)*[[:space:]]+(--force|--force-with-lease|-f)([[:space:]]+.*)?[[:space:]]+(origin[[:space:]]+)?(main|master|production|release)\b'; then
  block "force push to protected branch (main/master/production/release)"
fi

# 3. 保護追跡ブランチに対する reset --hard。
if printf '%s' "$scan" | grep -Eq 'git[[:space:]]+reset[[:space:]]+--hard[[:space:]]+(origin/)?(main|master|production|release)\b'; then
  block "git reset --hard against a protected tracking branch"
fi

# 4. 認証情報ファイルを文脈へ読み込む操作（PII/secret 最小化 = rules/pii-secret-minimization.md）。
if printf '%s' "$scan" | grep -Eq '(\bcat\b|\bbat\b|\bhead\b|\btail\b|\bless\b|\bmore\b)[[:space:]]+[^|]*(~/\.aws/credentials|/\.aws/credentials|~/\.ssh/id_[a-zA-Z0-9_]+(\s|$)|/\.ssh/id_[a-zA-Z0-9_]+(\s|$)|\.pem(\s|$)|\.key(\s|$))'; then
  block "reading private credential file into transcript (AWS / SSH private key / .pem)"
fi

# 5. macOS のセキュリティ機構を落とす操作（Linux では単に一致しない）。
if printf '%s' "$scan" | grep -Eq '(csrutil[[:space:]]+disable|spctl[[:space:]]+--master-disable|socketfilterfw[[:space:]]+--setglobalstate[[:space:]]+off|fdesetup[[:space:]]+disable)'; then
  block "disables a macOS security primitive (SIP / Gatekeeper / firewall / FileVault)"
fi

# 6. --no-verify によるフック迂回。CLAUDE.md が明示的に禁じている
#    （署名失敗は 1Password/鍵をアンロックして解決する。迂回しない）。
if printf '%s' "$scan" | grep -Eq 'git[[:space:]]+(commit|push|merge|rebase)[[:space:]]+[^#]*--no-verify'; then
  block "--no-verify bypasses git hooks; investigate the failure instead"
fi

# 7. curl|bash（リモートコード実行）。
if printf '%s' "$scan" | grep -Eq '(curl|wget)[[:space:]]+[^|]*\|\s*(sh|bash|zsh|fish)\b'; then
  block "curl/wget piped to a shell — inspect the script first"
fi

# 8. `rg -r` を「再帰」と誤用する（`-r` は --replace）。
#
#    `rg -rn 'pat' path` は**マッチを文字列 "n" へ置換して出力する**。結果は一見すると
#    grep の出力に見えるので、**リポジトリ側のバグに見える誤読**を生む。実際にこの周回で
#    5 回踏み、うち 1 回は「props が改名されている」と誤診した。
#    再帰は既定なのでフラグ自体が不要。行番号は `-n`、置換したいときだけ `--replace` と書く。
if printf '%s' "$scan" | grep -Eq '(^|[|;&[:space:]])rg[[:space:]]+(-[a-qs-zA-Z]*r|--replace([[:space:]]|=))'; then
  block "rg -r is --replace (not recursive) and rewrites matches; recursion is the default — drop -r, use -n for line numbers"
fi

# 9. 背景実行の出力を tail で切り詰める。
#
#    `run_in_background` の出力は**失敗時に読む唯一の材料**。`| tail -N` を噛ませると
#    要約だけが残り、原因（スタックトレース・どのステップで落ちたか）を捨てることになる。
#    実際にこの周回で VRM 検査の失敗理由を一度失い、切り分けに数回のビルドを浪費した。
#    ログはファイルへ落とし（`> file 2>&1`）、必要な部分をあとから読むこと。
#    **ファイルへ落としてから読むのは正しい**（`cmd > log 2>&1` のあと `tail log`）。
#    リダイレクトが 1 つも無い場合だけを止める ── 広く止めるとこの正しい手順まで
#    ブロックされ、摩擦でガードごと無効化される（実際に最初の実装がそうなった）。
if [ "$(printf '%s' "$payload" | grep -c '"run_in_background"[[:space:]]*:[[:space:]]*true')" -gt 0 ] \
  && printf '%s' "$scan" | grep -Eq '\|[[:space:]]*(tail|head)([[:space:]]|$)' \
  && ! printf '%s' "$scan" | grep -Eq '>[[:space:]]*[^|&[:space:]]+'; then
  block "background output piped to tail/head discards the failure reason; redirect to a file (> log 2>&1) instead"
fi

exit 0
