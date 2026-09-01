#!/usr/bin/env bash
# Cursor Cloud Agent の「start」欄へ載せる内容の**バージョン管理された正本**。
#
# 実行実体は Cursor の環境パネル側。このファイルを変えたらダッシュボードの start も
# 同期すること。手順は docs/cloud-dev-environment.md §7。
#
# 環境ビルドは install をベースライン作成時だけ走らせ、新しい pod では再実行しない。
# ここは lockfile ドリフト時の npm ci だけ。サーバは立てない（e2e が port 3000 を使う）。

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

if needs_install; then npm ci; fi
if [ -d infra ] && needs_install infra; then npm ci --prefix infra; fi
