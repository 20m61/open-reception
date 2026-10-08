#!/bin/bash
# Claude Code on the web の「Setup script」欄へ貼る内容の**バージョン管理された正本**。
#
# このファイル自体はどこからも実行されない（環境ダイアログに貼られた文字列が実体）。
# 貼り忘れ・食い違いを避けるため、変更したら claude.ai/code 側も更新すること。
# 設定手順と背景は docs/cloud-dev-environment.md。
#
# 制約（Anthropic 側の仕様）:
#   - **非ゼロ終了するとセッションごと起動しない** → 非必須は `|| true` で握る
#   - 5 分以内に終える → 独立な導入は `&` と `wait` で並行化
#   - 初回のみ実行され、結果はファイルシステムのスナップショットとしてキャッシュされる

set -u

# --- gh CLI / unzip --------------------------------------------------------
# gh: プリインストールされていない。GitHub プロキシが認証を代行するためトークンの設定は
# 不要（`echo $GH_TOKEN` が proxy-injected ならその状態）。
#
# 🔴 **PR 作成・マージは gh に依存しない (#1117)。** この install は best-effort
# （`|| true`）で、実際に失敗したまま走っているセッションが在る ―― 2026-09-15 に
# `command -v gh` が空のまま周回が回り、PR 作成だけが落ちた。以来、公開経路は
# `curl` で REST を直接叩く（`scripts/lib/github-api.ts`）。**ここで入ることを
# 当てにする手順を書かないこと。** gh が在れば `gh issue view` 等に使えるだけの
# 便宜であって、ループの前提ではない。
# unzip: 下の AWS CLI v2 インストーラ（公式配布は zip）が使う。並行ブロックより先に
# 同期で入れておく必要がある（並行ブロックの実行順は保証されないため）。
apt-get update -y || true
apt-get install -y gh unzip || true

# --- AWS CLI v2 (#680) -----------------------------------------------------
# 🔴 **このファイルは claude.ai/code の環境ダイアログ「Setup script」欄へ人間が貼る内容の
# コピーであり、このファイル自体は実行されない。変更したら環境ダイアログ側も貼り替えること**
# （ファイル冒頭の注記と同じ制約）。
#
# なぜ要るか: scripts/aws-cloud-deploy.sh の preflight/diff/deploy はすべて `aws` を
# 直接シェルアウトする（sts get-caller-identity / cloudformation describe-change-set 等）。
# 入っていないと `aws: command not found` で失敗し、しかも旧実装はそれを「AWS 認証情報を
# 解決できません」という誤った層のせいにしていた（2026-08 の初回試行で実際に踏んだ、
# docs/cloud-dev-environment.md §1・§4）。
#
# `command -v aws` で先にガードする ―― ファイルシステムのスナップショットが既に
# インストール済みの状態でキャッシュされているセッションで、毎回 60MB 弱のダウンロードと
# 再インストールを繰り返さないため（5 分制約の消費を避ける）。
(
  command -v aws >/dev/null 2>&1 && exit 0
  curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip &&
    unzip -q /tmp/awscliv2.zip -d /tmp &&
    /tmp/aws/install
) || true &

# --- 品質ゲートの任意ツール ------------------------------------------------
# 無いと quality-gate.sh が SKIP する。SKIP は FAIL にならないので、
# **マージゲート（--full）が黙って弱くなる**のが怖い。入れて等価にしておく。
# 🔴 semgrep は**専用 venv**（/opt/semgrep-venv）へ入れ、/usr/local/bin/semgrep を張る。
# system の site-packages へ入れると、イメージ側の Python パッケージと依存が重なって壊れる:
# - 2026-10 に `mcp` 1.29.0 と 2.2.0 が重なり、semgrep 1.180.0 が import で落ちた
#   （`ImportError: cannot import name 'TASK_STATUS_COMPLETED' from 'mcp.types'`）。
#   `command -v semgrep` は成功するので、壊れていることは sast を走らせるまで見えない
# - 以前は debian 由来の PyJWT（RECORD 無し）を pip が uninstall できず依存解決が止まり、
#   `--ignore-installed PyJWT` で凌いでいた（docs/cloud-dev-environment.md §4 / §6.1）。
#   venv はイメージのパッケージを見ないので、この回避も要らなくなる
# ⚠️ `pysemgrep` も張る。semgrep 本体は処理の一部を `pysemgrep` へ **PATH 経由で**渡すので、
# semgrep だけ張ると system 側の壊れた pysemgrep が拾われて同じ ImportError で落ちる（実測）。
# 直後の `|| true` は失敗を握り潰すが、SessionStart の gate_tool_report が欠落を名指しする。
(
  python3 -m venv /opt/semgrep-venv &&
    /opt/semgrep-venv/bin/pip install --quiet semgrep &&
    ln -sf /opt/semgrep-venv/bin/semgrep /usr/local/bin/semgrep &&
    ln -sf /opt/semgrep-venv/bin/pysemgrep /usr/local/bin/pysemgrep
) || true &

(
  GL=8.29.0
  curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${GL}/gitleaks_${GL}_linux_x64.tar.gz" \
    -o /tmp/gl.tgz && tar -xzf /tmp/gl.tgz -C /usr/local/bin gitleaks
) || true &

# --- Playwright ブラウザ ---------------------------------------------------
# 過去のクラウドセッションでは /opt/pw-browsers に同梱されており
# playwright.config.ts がそれを自動検出していた（docs/handoff-2026-07-12.md）。
# イメージが変わって同梱されない場合に備えてここでも入れる。
# ⚠️ ダウンロード元 cdn.playwright.dev は **Trusted の既定許可リストに無い**。
# 環境の Network access を Custom にして許可しないとここは失敗し、e2e / VRT /
# --full が回らない。
npx --yes playwright@1.61.1 install --with-deps chromium || true &

wait
exit 0
