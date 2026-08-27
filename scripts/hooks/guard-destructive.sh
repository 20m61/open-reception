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

# 「データとして書かれた言及」を落としてから走査する。落とす対象は順に:
#   1. ヒアドキュメントの本文（PR 本文・文書生成）
#   2. 引用符で囲まれた文字列（JSON ペイロードを echo するようなケース）
#
# 🔴 **1 が無いと実際に誤検出する。** 2026-08-18、PR #703 のクラウドセッションで、
# PR 本文を `cat > body.md <<'EOF' … EOF` で書き出そうとしたところ、**本文が
# `aws-issue-credentials.sh` という文字列を含んでいただけ**で実行レーン規則 (#675) に
# 引っかかりブロックされた（委譲先は Write ツールへ迂回して切り抜けた）。
# 誤検出はガードが信用を失う経路そのものなので、`pr-gate-guard.sh` と同じ前処理を持たせる。
#
# perl を使うのは複数行にまたがる heredoc 本文を消すため（`sed -E` の行指向では書けない）。
# perl が無い環境では引用符落としだけに縮退する（**厳しい側**に倒れるので安全）。
scan=$(printf '%s' "$cmd" | perl -0777 -pe "
  s/<<-?\s*(['\"]?)(\w+)\1.*?^[ \t]*\2[ \t]*\$//gms;
" 2>/dev/null || printf '%s' "$cmd")
scan=$(printf '%s' "$scan" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")

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

# 2b. 保護ブランチの**リモート削除**。
#
# 🔴 **force push を止めるだけでは足りない。** 削除は別の入口で、同じだけ壊せる。
# `.claude/settings.json` が後始末のために `Bash(git push origin --delete:*)` を
# auto-allow しているので、**ここで止めないとプロンプト無しで main を消せる**
# （2026-08-27 の自動セキュリティレビューが指摘。許可を足した PR #822 の直後）。
#
# git は同じ操作に複数の書き方を許すため、**全部塞ぐ**:
#   git push origin --delete main / git push --delete origin main
#   git push origin -d main       / git push origin :main
#   refs/heads/ 前置つきの各形
#
# ブランチ名は**終端を縛る**（`\b` ではなく「区切りか行末」）。`\b` だと
# `fix/main-menu-overflow` や `release-notes-draft` のような**保護ブランチ名を含むだけの
# トピックブランチ**を巻き込み、規約が要求する後始末をガードが妨げる。
PROTECTED_REF='(refs/heads/)?(main|master|production|release)([[:space:]]|$)'
if printf '%s' "$scan" | grep -Eq "git[[:space:]]+push([[:space:]]+[^&|;]+)*[[:space:]]+(--delete|-d)([[:space:]]+[^&|;]+)*[[:space:]]+${PROTECTED_REF}"; then
  block "remote delete of a protected branch (main/master/production/release)"
fi
if printf '%s' "$scan" | grep -Eq "git[[:space:]]+push([[:space:]]+[^&|;]+)*[[:space:]]+:${PROTECTED_REF}"; then
  block "remote delete of a protected branch (main/master/production/release)"
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

# 10. 実行レーン: クラウドで走らせてはいけない作業 (#675)。
#
#     開発は Claude Code on the web が既定（2026-08-18）。ほとんどはクラウドで回してよいが、
#     **短命 STS の発行だけはローカル macOS 限定**である ―― 出力に資格情報そのものを含み、
#     使い捨て VM の記録に残しうる。
#
#     🔴 **安いリテラル一致で先に絞る。** 本フックは全 Bash 呼び出しで起動されるので、
#     毎回 tsx を起動したら開発が体感で遅くなる（配線検査がゲートで 5 秒タイムアウトして
#     偽の赤を仕込みかけた前例がある）。該当パスに触れたときだけ判定 CLI を呼ぶ。
#     ここに並ぶリテラルは `LOCAL_REQUIRED_RULES[].matches` と一致していなければならず、
#     ドリフトは `src/domain/governance/execution-lane.test.ts` が検出する。
#
#     判定（どの platform で止めるか・理由・代替手段）は CLI 側が正本。CLI が動かない
#     ときは**止める** ―― ここまで来ている時点で資格情報を扱うコマンドだと分かっており、
#     「判定できなかったから通す」は塞ぎたい穴をそのまま開ける（"検査できなかった" を
#     PASS にしないという quality-gate の判断と同じ）。
if printf '%s' "$scan" | grep -q 'aws-issue-credentials\.sh'; then
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  lane_out=$(npx --no-install tsx "${ROOT_DIR}/scripts/check-execution-lane.ts" "$scan" 2>&1)
  lane_status=$?
  if [ "$lane_status" -eq 2 ]; then
    block "$lane_out"
  elif [ "$lane_status" -ne 0 ]; then
    block "実行レーンを判定できませんでした（#675）。判定 CLI の出力: ${lane_out}"
  fi
fi

exit 0
