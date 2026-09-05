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
# 自分がこのポートのサーバを起動したか。起動前にガードで弾かれた場合は、他人が握っている
# ポートを勝手に殺さない（ガードの意味が消える）。
OWNS_PORT=0
# 子孫ごと落とす。`npm run start` → `sh -c next start` → `next-server` の 3 段で、
# 親を殺しても孫は孤児として生き残る（下の cleanup の注記参照）。PPID を辿れば
# **どのポートを握っているか分からなくても**確実に自分の子孫だけを殺せる。
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "${pid}" 2>/dev/null || true); do kill_tree "${child}"; done
  kill -9 "${pid}" 2>/dev/null || true
}

cleanup() {
  # **必ず落とす。** 残すとポートを掴んだままになり、次回の実行が別プロセスに繋がる。
  # 🔴 子孫ごと落とす ── 親だけ殺すと `next-server` が孤児として残り、しかも
  # 下の `lsof` はこの環境で保持者を返さないので、**誰も落とせないまま次回へ持ち越す**。
  if [[ -n "${SERVER_PID}" ]]; then kill_tree "${SERVER_PID}"; fi

  # ここまでで足りなかった。`npm run start` は `next start` を**子プロセス**として起動するので、
  # npm を殺しても `next-server` は孤児として生き残り、ポートを握り続ける。実際にこれが残り、
  # 次回の実行が古いサーバに繋がって ChunkLoadError を出し、**コードの退行と誤認した**。
  # PID を辿るのではなくポートの保持者を名指しで落とす（孤児化しても確実に届く）。
  if [[ "${OWNS_PORT}" -eq 1 ]]; then
    local holders
    holders="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
    if [[ -n "${holders}" ]]; then
      echo "${holders}" | xargs kill 2>/dev/null || true
      sleep 1
      holders="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
      if [[ -n "${holders}" ]]; then echo "${holders}" | xargs kill -9 2>/dev/null || true; fi
    fi

    # 🔴 **落とせたかを確かめる。** `lsof` が保持者を返さない環境が実在するので、
    # 「kill する対象が見つからなかった」を「片付いた」と読まない。残っていたら**次回の
    # 実行が古いサーバに繋がる**ので、ここで名指しして気づかせる（黙って終わらない）。
    sleep 1
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
      echo "  WARN: ポート ${PORT} がまだ応答しています。次回の実行が古いサーバに繋がります。" >&2
      echo "        孤児化した next-server を探して落としてください:" >&2
      echo "          ps -eo pid,lstart,cmd | grep '[n]ext-server'" >&2
    fi
  fi
}
trap cleanup EXIT INT TERM

mkdir -p "${OUT}"

# **起動前にポートを確認する。** 前回の実行が残っていると `next start` は EADDRINUSE で
# 即死し、検査は「生き残った古いサーバ」に繋がる。古いサーバは boot 時の build manifest を
# 握ったままなので、再ビルド後は chunk が食い違い ChunkLoadError で FAIL する ——
# **コードの退行と見分けがつかない**。逆に古い build がたまたま健全なら偽 PASS になる。
# 実際にこれで「自分の変更が VRM を壊した」と誤認し、切り分けに数回のビルドを浪費した。
# 🔴 **`lsof` だけでは足りない。** 2026-08-20、`lsof -ti :3102` も `ss -ltnp` も「空き」と
# 報告するのに `next start` が EADDRINUSE で死ぬ状況を踏んだ（コンテナの都合で保持者が
# 見えない）。検査は古いサーバに繋がり ChunkLoadError で FAIL し、**main との比較実験まで
# 汚染して「自分の変更が VRM を壊した」と誤断した**。
#
# よって**実際に応答するか**でも見る。「誰かが serve している」ことこそが知りたい事実で、
# それは HTTP を 1 回叩けば分かる。プロセス表からの探索も添える（診断用）。
port_in_use() {
  lsof -ti "tcp:${PORT}" >/dev/null 2>&1 && return 0
  curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null && return 0
  return 1
}

if port_in_use; then
  echo "  ERROR: ポート ${PORT} は既に使用中です（前回の実行が残っている可能性）。" >&2
  echo "         検査が古いサーバに繋がると、コードの退行と区別できない結果になります。" >&2
  echo "         解放してから再実行してください:" >&2
  echo "           lsof -ti tcp:${PORT} | xargs -r kill -9" >&2
  echo "         lsof が何も返さないのに使用中なら、孤児化した next-server を探すこと:" >&2
  echo "           ps -eo pid,lstart,cmd | grep '[n]ext-server'" >&2
  exit 1
fi

echo "  VRM 有効のサーバを ${PORT} で起動します（e2e/VRT へ影響させないため専用プロセス）"
(
  cd "${ROOT}" || exit 1
  KIOSK_DEFAULT_VRM_URL="${KIOSK_DEFAULT_VRM_URL:-/avatar/default.vrm}" \
  RECEPTION_DISABLE_DEV_SEED=1 \
  KIOSK_VRM_HARNESS=1 \
  PORT="${PORT}" \
  npm run --silent start > "${OUT}/server.log" 2>&1
) &
SERVER_PID=$!
# kill 時の job control メッセージ（"Killed ( cd ... )"）をゲート出力へ混ぜない。
# 失敗と読み違えるノイズになる（サーバの実エラーは ${OUT}/server.log に出る）。
disown "${SERVER_PID}" 2>/dev/null || true
OWNS_PORT=1

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

# 🔴 **プリインストール済み Chromium を解決してから起動する（2026-09-05）。**
#
# `vrm-visual-check.mjs` は `PW_EXECUTABLE_PATH` を読むが、`playwright.config.ts` が持つ
# **自動検出を持っていなかった**。そのため、インストール済み @playwright/test が期待する
# ビルド番号とプリインストール版がずれる環境（Claude Code on the web の /opt/pw-browsers）で
# VRM ステップだけが `Executable doesn't exist` で落ちた。e2e は config の逃げ道を通るので
# 通っており、**同じ環境で片方だけ落ちる**ため「VRM の退行」と誤読しやすい。
# 解決の正本は scripts/lib/gate-tooling.sh（写しを増やさない）。
# shellcheck source=lib/gate-tooling.sh
. "${ROOT}/scripts/lib/gate-tooling.sh"
gate_tool_export_chromium_executable

node "${ROOT}/scripts/vrm-visual-check.mjs" "${BASE}" "${OUT}"
