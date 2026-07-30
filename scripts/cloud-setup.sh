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

# --- gh CLI --------------------------------------------------------------
# プリインストールされていない。ループ workflow は gh pr create / gh pr merge /
# gh issue に全面的に依存するので必須。GitHub プロキシが認証を代行するため
# トークンの設定は不要（`echo $GH_TOKEN` が proxy-injected ならその状態）。
apt-get update -y || true
apt-get install -y gh || true

# --- 品質ゲートの任意ツール ------------------------------------------------
# 無いと quality-gate.sh が SKIP する。SKIP は FAIL にならないので、
# **マージゲート（--full）が黙って弱くなる**のが怖い。入れて等価にしておく。
pip install --break-system-packages semgrep || true &

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
