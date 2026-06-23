#!/usr/bin/env bash
# =============================================================================
# 実環境（稼働中の任意 URL）に対する品質ゲート。
#
# 用途: デプロイ済み URL やローカル本番ビルドに対して、外形からの品質チェックを回す。
#   - smoke      : 主要ルートが 200 を返すか（到達性）
#   - lighthouse : 性能/アクセシビリティ/ベストプラクティス（lighthouserc.json の閾値）
#   - zap        : OWASP ZAP baseline（受動スキャン・既知の警告を棚卸し）
#
# 使い方:
#   scripts/url-quality-gate.sh <BASE_URL> [--no-zap] [--no-lighthouse]
# 例:
#   scripts/url-quality-gate.sh http://localhost:3000
#   scripts/url-quality-gate.sh https://d342uosvp8649l.cloudfront.net
#
# 前提: curl / docker（ZAP 用・colima 起動済み）/ npx（lighthouse 用）。
# 注意: ローカル(localhost)を ZAP(docker) からスキャンする場合、サーバを 0.0.0.0 で
#       起動し、URL は host.docker.internal に読み替える（本スクリプトが自動置換）。
# =============================================================================
set -uo pipefail

BASE="${1:-}"
if [[ -z "$BASE" || "$BASE" == --* ]]; then
  echo "Usage: $0 <BASE_URL> [--no-zap] [--no-lighthouse]" >&2
  exit 2
fi
shift || true
RUN_ZAP=1; RUN_LH=1
for a in "$@"; do
  case "$a" in
    --no-zap) RUN_ZAP=0 ;;
    --no-lighthouse) RUN_LH=0 ;;
  esac
done
BASE="${BASE%/}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.url-quality-gate"
mkdir -p "$OUT"
FAILED=()
PATHS=(/ /kiosk /admin/login)

echo "════════════════════════════════════════════════"
echo " URL quality gate: $BASE"
echo "════════════════════════════════════════════════"

# ---- 1. smoke（到達性） -------------------------------------------------------
echo "── smoke（主要ルート 200）"
for p in "${PATHS[@]}"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE$p" || echo 000)"
  printf '  %-16s HTTP %s\n' "$p" "$code"
  [[ "$code" == "200" ]] || FAILED+=("smoke $p ($code)")
done

# ---- 2. lighthouse ----------------------------------------------------------
if [[ "$RUN_LH" == 1 ]]; then
  echo "── lighthouse（性能/a11y/best-practices）"
  cat > "$OUT/lhci.json" <<JSON
{
  "ci": {
    "collect": {
      "url": ["$BASE/", "$BASE/kiosk", "$BASE/admin/login"],
      "numberOfRuns": 1,
      "settings": { "chromeFlags": "--no-sandbox --headless=new --disable-gpu", "onlyCategories": ["performance","accessibility","best-practices"] }
    },
    "assert": { "assertions": {
      "categories:accessibility": ["error", { "minScore": 0.9 }],
      "categories:best-practices": ["error", { "minScore": 0.9 }],
      "categories:performance": ["warn", { "minScore": 0.7 }]
    } },
    "upload": { "target": "filesystem", "outputDir": "$OUT/lighthouse" }
  }
}
JSON
  if npx --yes @lhci/cli@0.15.x autorun --config="$OUT/lhci.json" > "$OUT/lighthouse.log" 2>&1; then
    echo "  lighthouse: PASS（詳細 $OUT/lighthouse）"
  else
    echo "  lighthouse: 閾値未達/失敗（$OUT/lighthouse.log 参照）"
    FAILED+=("lighthouse")
  fi
fi

# ---- 3. OWASP ZAP baseline --------------------------------------------------
if [[ "$RUN_ZAP" == 1 ]]; then
  echo "── OWASP ZAP baseline（受動スキャン）"
  ZAP_TARGET="$BASE"
  # localhost をコンテナから見えるホスト名へ置換。
  ZAP_TARGET="${ZAP_TARGET/http:\/\/localhost/http://host.docker.internal}"
  ZAP_TARGET="${ZAP_TARGET/http:\/\/127.0.0.1/http://host.docker.internal}"
  if docker run --rm -t -v "$OUT:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable \
      zap-baseline.py -t "$ZAP_TARGET/kiosk" -m 2 -r zap-report.html -I > "$OUT/zap.log" 2>&1; then
    echo "  ZAP: 完了（警告なし or 既知のみ）。レポート: $OUT/zap-report.html"
  else
    rc=$?
    # zap-baseline.py: 終了コード 1=FAIL(高リスク) / 2=WARN。-I で WARN は無視するが念のため記録。
    echo "  ZAP: 終了コード $rc（$OUT/zap.log / $OUT/zap-report.html を確認）"
    [[ "$rc" == 1 ]] && FAILED+=("zap(high-risk)")
  fi
fi

# ---- 結果 -------------------------------------------------------------------
echo "════════════════════════════════════════════════"
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo " RESULT: PASS"
  exit 0
else
  echo " RESULT: FAIL — ${FAILED[*]}"
  exit 1
fi
