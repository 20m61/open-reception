#!/usr/bin/env bash
# Cursor Cloud Agent の「install」欄へ載せる内容の**バージョン管理された正本**。
#
# 実行実体は Cursor の環境パネル（DB 管理の personal environment）側。
# このファイルを変えたらダッシュボードの install も同じ内容へ同期すること
# （逆も。片方だけ直すと #545 と同型のドリフトになる）。
#
# 🔴 `.cursor/environment.json` はコミットしない。リポジトリの environment.json は
# ダッシュボードの personal snapshot 環境より優先され、焼き込んだベースラインが消える。
# 手順は docs/cloud-dev-environment.md §7。
#
# 制約:
#   - 終了すること（dev server / `npm run start` をここで起動しない）
#   - 冪等。lockfile が新しければ npm ci、道具が無ければ入れる
#   - e2e は port 3000 で `npm run start` するため、ここでも start でもサーバを立てない

set -euo pipefail

needs_install() {
  local prefix="${1:-}"
  local dir="${prefix:+$prefix/}node_modules"
  local lock="${prefix:+$prefix/}package-lock.json"
  local marker="${dir}/.package-lock.json"
  if [ ! -d "$dir" ]; then return 0; fi
  if [ -f "$lock" ] && { [ ! -f "$marker" ] || [ "$lock" -nt "$marker" ]; }; then
    return 0
  fi
  return 1
}

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

if needs_install; then npm ci; fi
if [ -d infra ] && needs_install infra; then npm ci --prefix infra; fi
npx playwright install --with-deps chromium
if ! command -v gitleaks >/dev/null 2>&1; then
  curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.29.0/gitleaks_8.29.0_linux_x64.tar.gz -o /tmp/gl.tgz
  as_root tar -xzf /tmp/gl.tgz -C /usr/local/bin gitleaks
fi
if ! command -v semgrep >/dev/null 2>&1; then
  as_root pip3 install --break-system-packages --ignore-installed PyJWT semgrep
fi
if ! command -v aws >/dev/null 2>&1; then
  command -v unzip >/dev/null 2>&1 || { as_root apt-get update -y; as_root apt-get install -y unzip; }
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip
  unzip -qo /tmp/awscliv2.zip -d /tmp/aws-cli-extract
  as_root /tmp/aws-cli-extract/aws/install
fi
