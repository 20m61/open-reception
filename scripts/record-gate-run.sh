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
#            記録の健全性の点検（#656）は報告のみで、終了コードには混ぜない。
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

# --- 記録が健全かを、記録した直後に点検する (#656) ---
#
# **この呼び出しが無いと、検査は誰も走らせないまま腐る。** `record_gap`（週次記録の穴）も
# `orphan_branch`（PR にならなかった push）も `latest_failed` も、実装しただけでは
# 何も見ていない。2026-08-08 時点で `evaluate-gate-runs.ts` を呼ぶものは**リポジトリ内に
# 1 つも無かった** — #656 は「FAIL が誰にも見えないまま消える」issue なので、
# 誰も走らせない検出器では閉じない。
#
# **`quality-gate.sh` 側には入れない。** あちらはコード品質の門で、こちらは「運用が
# 回っているか」の点検。混ぜると Routine が止まっている間ずっと開発者のローカルゲートが
# 赤くなり override が習慣化する（`evaluate-gate-runs.ts` の docblock が正本）。
# 週次運用の入口である本スクリプトなら、その判断を壊さずに配線できる。
#
# **`--report`（exit 0）で呼び、終了コードは変えない。** 本スクリプトの終了コードは
# ゲートの結果という契約で、そこへ記録の健全性を混ぜると意味が二重になる。加えて
# 「解決手段のない指摘で永久に赤くなる」罠を FAIL / SKIP / orphan で既に 3 度踏んでいる。
echo ""
echo "▶ 記録の健全性を点検します（報告のみ・終了コードは変えません）"
npm run --silent evaluate:gate-runs -- --report
EVAL_STATUS=$?
if [[ "${EVAL_STATUS}" -ne 0 ]]; then
  # `--report` は指摘があっても 0 で返す。0 以外は**検査自体が実行できなかった**印。
  echo "⚠️  記録の健全性を点検できませんでした（exit ${EVAL_STATUS}）。指摘の有無は不明です。" >&2
fi

if [[ "${RESULT}" == "FAIL" ]]; then
  echo ""
  echo "❌ quality-gate --full --strict FAILED"
  echo "   docs/quality-gate.md の「FAIL 時のハンドリング」に従い、重大度に応じて issue を起票してください。"
  exit "${STATUS}"
fi

echo ""
echo "✅ quality-gate --full --strict PASSED"
