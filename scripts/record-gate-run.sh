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
# 使い方:
#   ./scripts/record-gate-run.sh              # ゲート実行 + 記録の追記まで（push も PR も行わない）
#   ./scripts/record-gate-run.sh --publish    # 上記 + ブランチ/commit/push/PR 作成まで（週次運用はこれ）
#   ./scripts/record-gate-run.sh --publish --dry-run
#                                             # ゲートも副作用も実行せず、公開手順だけを表示する
#
# 終了コード: quality-gate.sh --full --strict の終了コードをそのまま返す。
#            FAIL 時は docs/quality-gate.md の FAIL 時ハンドリングに従い issue を起票すること
#            （本スクリプトは issue 起票までは行わない）。
#            記録の健全性の点検（#656）は報告のみで、終了コードには混ぜない。
#            ただし **`--publish` で PR まで到達できなかった場合は非ゼロで落ちる**（下記）。
#
# --- なぜ公開までスクリプトが持つのか (#656) ---
#
# 2026-08-03 の週次ゲートは記録を commit・push したのに **PR を作らずに終わり**、FAIL が
# 5 日間 main に載らなかった。当時この手順は routine の**指示文（散文）**に書かれており、
# 抜けても誰も気づかなかった。`docs/ai-development-loop.md` の「規律で守るものを機械検証へ
# 移す」に従い、保証を version 管理されたコードへ移す。
#
# **作成の終了コードだけを信じない。** 「ブランチが出来たこと＝PR が出来たことではない」が
# #656 そのものなので、作成後に**そのブランチを head に持つ PR を REST で引き直して実在を確認**
# する。確認できなければ非ゼロで落ちる（サイレントに終わらせない）。
#
# **PR 作成にも確認にも `gh pr ...` を使わない (#678)。** クラウドのサンドボックスは GitHub
# GraphQL を絞っており、`gh pr list` / `gh pr view` だけでなく **`gh pr create` も** repo info
# preamble の GraphQL で 403 になる（2026-08-10 の週次ゲートで実測）。作成・確認とも
# `scripts/create-pull-request.ts` 経由の REST（`gh api repos/{owner}/{repo}/pulls`）で行う。
#
set -uo pipefail

PUBLISH=0
DRY_RUN=0
for arg in "${@:-}"; do
  case "${arg}" in
    --publish) PUBLISH=1 ;;
    --dry-run) DRY_RUN=1 ;;
    "") ;;
    *) echo "不明な引数: ${arg}" >&2; exit 2 ;;
  esac
done

# dry-run は副作用を出さないための表示専用。実行の代わりにコマンドを印字する。
run_or_echo() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "  [dry-run] $*"
    return 0
  fi
  "$@"
}

cd "$(dirname "$0")/.." || exit 2
ROOT="$(pwd)"
GATE_RUNS="${ROOT}/docs/gate-runs.md"

TS="$(date -u +"%Y-%m-%dT%H:%MZ")"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

OUTPUT_FILE="$(mktemp)"
trap 'rm -f "${OUTPUT_FILE}"' EXIT

if [[ "${DRY_RUN}" -eq 1 ]]; then
  # **ゲートは回さない。** 25 分かかるうえ、公開手順の確認には要らない。
  echo "▶ [dry-run] ゲートは実行しません。公開手順だけを表示します。"
  STATUS=0
else
  echo "▶ record-gate-run: ./scripts/quality-gate.sh --full --strict を実行します"
  "${ROOT}/scripts/quality-gate.sh" --full --strict 2>&1 | tee "${OUTPUT_FILE}"
  STATUS="${PIPESTATUS[0]}"
fi

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

# 🔴 **「測れなかった」実行を後から数えられるようにする** (#717)。
# クラウド（`--pr` / `--full` の既定実行環境）は浅い clone なので、変更範囲を測れずに
# 全ステップを走らせる状態が**恒常的に起きていても気づけない**。その場で出る ⚠ は
# 流れて消えるので、コミットされる記録（`docs/gate-runs.md`）に印を残す。
# 列は増やさない（`gate-run-evaluation.ts` は位置で読む）。備考へ足す。
UNMEASURED="$(grep -oE '^  NOTE  change-scope  .*' "${OUTPUT_FILE}" | sed -E 's/^  NOTE  change-scope  //' | paste -sd ';' - || true)"
if [[ -n "${UNMEASURED}" ]]; then
  NOTE="${NOTE} / 未測定: ${UNMEASURED}"
fi

ROW="| ${TS} | \`${SHA}\` | full | ${RESULT} | ${SKIP_ITEMS} | ${NOTE} |"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo ""
  echo "  [dry-run] ${GATE_RUNS} へ追記する行: ${ROW}"
elif [[ -f "${GATE_RUNS}" ]]; then
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

# --- 記録を PR まで届ける (#656 AC1 / AC2) ---
#
# 🔴 **FAIL 分岐より前に置く。** FAIL のときこそ記録が main に載る必要があり、
# 2026-08-03 に失われたのもまさに FAIL の記録だった。
if [[ "${PUBLISH}" -eq 1 ]]; then
  BRANCH="chore/gate-run-$(date -u +%Y%m%d)"
  echo ""
  echo "▶ 記録を PR まで届けます（ブランチ: ${BRANCH}）"

  run_or_echo git checkout -b "${BRANCH}" || {
    echo "❌ ブランチ ${BRANCH} を作成できませんでした（同名が既にある可能性）。" >&2
    exit 3
  }
  run_or_echo git add "${GATE_RUNS}" || { echo "❌ git add に失敗しました。" >&2; exit 3; }
  run_or_echo git commit -m "docs(gate-runs): 週次定期ゲート実行結果を記録する（#318）" || {
    echo "❌ commit に失敗しました（記録に差分が無い可能性）。" >&2
    exit 3
  }
  run_or_echo git push -u origin "${BRANCH}" || { echo "❌ push に失敗しました。" >&2; exit 3; }

  # 🔴 **`gh pr create` は使わない (#678)。** クラウド Routine セッションの `gh` は
  # PR レビュー用の pinned な操作セットしか GraphQL を通さず、`gh pr create` が本体の
  # POST の前に撃つ repo info preamble（`RepositoryInfo`）が 403 で拒否される。
  # 2026-08-10 の週次ゲートが実際にここで落ち、記録は push 済みなのに PR が無い
  # ―― まさに #656 の形 ―― になった。作成・実在確認とも REST に寄せる。
  PR_BODY="週次の \`--full --strict\` の結果を \`docs/gate-runs.md\` へ記録します（結果: ${RESULT}）。

\`scripts/record-gate-run.sh --publish\` による自動作成です（#656 / #678）。

Refs #318 #656"

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "  [dry-run] npx tsx scripts/create-pull-request.ts --head ${BRANCH} --base main --title ... --body ..."
    echo "  [dry-run] 作成後、ブランチを head に持つ PR を REST で引き直して実在を確認（gh pr create は使わない）"
  else
    PR_URL="$(npx --no-install tsx "${ROOT}/scripts/create-pull-request.ts" \
      --head "${BRANCH}" --base main \
      --title "docs(gate-runs): 週次定期ゲート実行結果を記録する（#318）" \
      --body "${PR_BODY}")" || {
      echo "   **記録は push 済みですが main には載っていません。** これが #656 の形です。" >&2
      exit 4
    }
    echo "${PR_URL}"
  fi
else
  # **黙って終わらせない。** 公開していないこと自体を出す（#656 AC1）。
  echo ""
  echo "⚠️  記録は追記しましたが、push も PR 作成も行っていません（--publish 未指定）。" >&2
  echo "   週次運用では ./scripts/record-gate-run.sh --publish を使ってください。" >&2
  echo "   このまま終わると、記録は手元にあるだけで main には載りません（#656 の形）。" >&2
fi

if [[ "${RESULT}" == "FAIL" ]]; then
  echo ""
  echo "❌ quality-gate --full --strict FAILED"
  echo "   docs/quality-gate.md の「FAIL 時のハンドリング」に従い、重大度に応じて issue を起票してください。"
  exit "${STATUS}"
fi

echo ""
echo "✅ quality-gate --full --strict PASSED"
