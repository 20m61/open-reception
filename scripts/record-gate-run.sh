#!/usr/bin/env bash
#
# scripts/record-gate-run.sh — 定期実行用: quality-gate --full --strict を実行し、
# 結果を docs/gate-runs.md に追記する（#318）。
#
# 週次以上の定期実行（Claude Code の Routine もしくは cron/launchd）から呼ぶことを
# 想定している。手動実行も可。docs/quality-gate.md の「定期運用」節を参照。
#
# 記録行のフォーマットは docs/gate-runs.md のヘッダーと一致させること:
#   | 日時 (UTC) | コミット SHA | tier | 結果 | SKIP 項目 | 起票 Issue / 備考 |
#
# 終了コード: quality-gate.sh --full --strict の終了コードをそのまま返す。
#            FAIL 時は docs/quality-gate.md の FAIL 時ハンドリングに従い issue を起票すること
#            （本スクリプトは issue 起票までは行わない）。
#
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2
ROOT="$(pwd)"
GATE_RUNS="${ROOT}/docs/gate-runs.md"

TS="$(date -u +"%Y-%m-%dT%H:%MZ")"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

OUTPUT_FILE="$(mktemp)"
trap 'rm -f "${OUTPUT_FILE}"' EXIT

echo "▶ record-gate-run: ./scripts/quality-gate.sh --full --strict を実行します"
"${ROOT}/scripts/quality-gate.sh" --full --strict 2>&1 | tee "${OUTPUT_FILE}"
STATUS="${PIPESTATUS[0]}"

if [[ "${STATUS}" -eq 0 ]]; then
  RESULT="PASS"
else
  RESULT="FAIL"
fi

# SKIP 項目を抽出（--strict では SKIP=FAIL 扱いになるため通常は空。念のため拾う）
SKIP_ITEMS="$(grep -oE '^  SKIP  .*' "${OUTPUT_FILE}" | sed -E 's/^  SKIP  //' | paste -sd ';' - || true)"
if [[ -z "${SKIP_ITEMS}" ]]; then
  SKIP_ITEMS="なし"
fi

NOTE="自動記録（record-gate-run.sh）"
if [[ "${RESULT}" == "FAIL" ]]; then
  NOTE="要 issue 起票（docs/quality-gate.md の FAIL 時ハンドリング参照）"
fi

ROW="| ${TS} | \`${SHA}\` | full | ${RESULT} | ${SKIP_ITEMS} | ${NOTE} |"

if [[ -f "${GATE_RUNS}" ]]; then
  echo "${ROW}" >> "${GATE_RUNS}"
  echo ""
  echo "↳ ${GATE_RUNS} に追記しました:"
  echo "  ${ROW}"
else
  echo "⚠️  ${GATE_RUNS} が見つかりません。手動で以下を追記してください:" >&2
  echo "  ${ROW}" >&2
fi

if [[ "${RESULT}" == "FAIL" ]]; then
  echo ""
  echo "❌ quality-gate --full --strict FAILED"
  echo "   docs/quality-gate.md の「FAIL 時のハンドリング」に従い、重大度に応じて issue を起票してください。"
  exit "${STATUS}"
fi

echo ""
echo "✅ quality-gate --full --strict PASSED"
