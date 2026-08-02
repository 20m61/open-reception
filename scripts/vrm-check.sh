#!/usr/bin/env bash
#
# scripts/vrm-check.sh — VRM 実描画検査を独立したサーバで実行する（品質ゲートの 1 ステップ）。
#
# ## なぜ専用サーバを立てるのか
#
# 検査には `KIOSK_DEFAULT_VRM_URL` が要る（未設定だと VRM を読み込まず canvas が出ない）。
# しかし **e2e サーバへこの env を足すと、全 e2e でアバターが描画され VRT ベースラインが
# 総入れ替えになる**。回帰固定という目的に対して副作用が大きすぎるので、専用ポートで
# 別プロセスを立てて検査し、終わったら落とす。
#
# ## なぜゲートに入れるのか
#
# #578 で入れた ResizeObserver の暴走ループ（DPR>1 で canvas が指数的に肥大し実機 iPad が
# 落ちる）は、**ローカルゲート 10 項目すべてが green のまま素通り**した。手動実行の検査は
# 「回すのを忘れる」ので、機械が回す側に置く。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# e2e は 3000、platform は 3001、lighthouse は 3000 を使う。衝突しない番号を取る。
PORT="${VRM_CHECK_PORT:-3102}"
BASE="http://127.0.0.1:${PORT}"
OUT="${VRM_CHECK_OUT:-${ROOT}/.vrm-check}"

SERVER_PID=""
cleanup() {
  # **必ず落とす。** 残すとポートを掴んだままになり、次回の実行が別プロセスに繋がる。
  if [[ -n "${SERVER_PID}" ]]; then kill "${SERVER_PID}" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

mkdir -p "${OUT}"

# **起動前にポートを確認する。** 前回の実行が残っていると `next start` は EADDRINUSE で
# 即死し、検査は「生き残った古いサーバ」に繋がる。古いサーバは boot 時の build manifest を
# 握ったままなので、再ビルド後は chunk が食い違い ChunkLoadError で FAIL する ——
# **コードの退行と見分けがつかない**。逆に古い build がたまたま健全なら偽 PASS になる。
# 実際にこれで「自分の変更が VRM を壊した」と誤認し、切り分けに数回のビルドを浪費した。
if lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then
  echo "  ERROR: ポート ${PORT} は既に使用中です（前回の実行が残っている可能性）。" >&2
  echo "         検査が古いサーバに繋がると、コードの退行と区別できない結果になります。" >&2
  echo "         解放してから再実行してください: lsof -ti tcp:${PORT} | xargs kill" >&2
  exit 1
fi

echo "  VRM 有効のサーバを ${PORT} で起動します（e2e/VRT へ影響させないため専用プロセス）"
(
  cd "${ROOT}" || exit 1
  KIOSK_DEFAULT_VRM_URL="${KIOSK_DEFAULT_VRM_URL:-/avatar/default.vrm}" \
  RECEPTION_DISABLE_DEV_SEED=1 \
  PORT="${PORT}" \
  npm run --silent start > "${OUT}/server.log" 2>&1
) &
SERVER_PID=$!

# 起動待ち。ビルド済み前提（ゲートは build ステップの後にここへ来る）。
ready=0
for _ in $(seq 1 60); do
  if curl -sf "${BASE}/kiosk" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if [[ "${ready}" -ne 1 ]]; then
  echo "  ⚠️ サーバが起動しませんでした（${OUT}/server.log を参照）"
  tail -20 "${OUT}/server.log" 2>/dev/null || true
  exit 1
fi

node "${ROOT}/scripts/vrm-visual-check.mjs" "${BASE}" "${OUT}"
