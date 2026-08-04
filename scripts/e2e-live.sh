#!/bin/bash
# 実デプロイに対する iPad エミュレーション e2e。
#
# 品質ゲート（scripts/quality-gate.sh）には**含めない**。実 URL と管理者資格情報が要り、
# 失敗が「コードの欠陥」とは限らないため（環境未整備・トークン失効など）。ゲートに混ぜると
# 赤の意味が薄れて無視されるようになる。
#
# 使い方:
#   LIVE_BASE_URL=https://xxxx.cloudfront.net \
#   LIVE_ADMIN_USER=admin LIVE_ADMIN_PASSWORD=... \
#   ./scripts/e2e-live.sh
set -uo pipefail

missing=()
[ -z "${LIVE_BASE_URL:-}" ] && missing+=(LIVE_BASE_URL)
[ -z "${LIVE_ADMIN_USER:-}" ] && missing+=(LIVE_ADMIN_USER)
[ -z "${LIVE_ADMIN_PASSWORD:-}" ] && missing+=(LIVE_ADMIN_PASSWORD)
if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: 次の環境変数が要ります: ${missing[*]}" >&2
  echo "  例: LIVE_BASE_URL=https://xxxx.cloudfront.net LIVE_ADMIN_USER=admin LIVE_ADMIN_PASSWORD=... $0" >&2
  exit 1
fi

# 資格情報はログへ出さない（URL だけ出す）。
echo "対象: ${LIVE_BASE_URL}"
exec npx playwright test --config playwright.live.config.ts "$@"
