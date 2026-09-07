#!/usr/bin/env bash
#
# scripts/restore-gate-tools.sh — 品質ゲートの任意ツール（gitleaks / semgrep）を復旧する (#985)。
#
# ## なぜ要るか
#
# クラウドセッションの素材は**環境ダイアログの Setup script**（`scripts/cloud-setup.sh` の
# 写し）が入れることになっており、結果はファイルシステムのスナップショットへ焼かれる。
# ところが 2026-09-05 と 2026-09-06 の 2 セッション連続で、`gh` / `gitleaks` / `semgrep` が
# **入っていない状態で起動した**（`docs/cloud-dev-environment.md` §0-G）。
#
# 影響は SKIP では済まない:
#
# - `gitleaks` 不在 … `tests/hooks/push-secret-guard.test.ts` が前提検査で落ち、
#   **`--pr` が原理的に完走しない**（#986 / #988）
# - `semgrep` 不在 … `--full` の `sast` が SKIP へ落ち、**マージゲートが黙って弱くなる**
#
# 2026-09-06 のデプロイでは、この復旧が**窓を最も消費した要因**だった（#988）。
#
# ## 方針
#
# 🔴 **これは「素材を入れる」場所ではなく、欠けていたときに戻す場所である。**
# 正規の経路は環境ダイアログの Setup script で、そちらが効いていれば本スクリプトは
# `command -v` を 2 回叩いて即座に抜ける（何もしない）。
#
# 🔴 **落ちても呼び出し元を落とさない。** SessionStart が非ゼロで終わるとセッションごと
# 起動しない。取得できなかったときは**そう言って** exit 0 する ―― 黙って緑にしない
# （`gate_tool_report` が直後に欠落を名指しするので、人は気づける）。
#
# 環境変数:
#   OPEN_RECEPTION_SKIP_TOOL_RESTORE=1 … 何もしない（オフライン環境・意図的な検証用）
#   OPEN_RECEPTION_TOOL_RESTORE_DRY_RUN=1 … 実行せず、何をするかだけ出す（テスト用）

set -u

# 🔴 **版はここが正本ではない。** `scripts/cloud-setup.sh`（環境ダイアログの写し）と
# `scripts/cursor-cloud-install.sh` が同じ版を持っており、ズレると
# 「復旧したのに Setup script と違う版が入る」ことになる。
# `tests/config/gate-tooling-wiring.test.ts` が 3 者の一致を静的に縛っている。
GITLEAKS_VERSION=8.29.0

restore_note() { printf '  %s\n' "$*" >&2; }

# root でなければ sudo を挟む（クラウドは root だが、他の実行環境のため）。
as_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    return 1
  fi
}

restore_gitleaks() {
  local url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  if [ "${OPEN_RECEPTION_TOOL_RESTORE_DRY_RUN:-0}" = "1" ]; then
    restore_note "would install gitleaks ${GITLEAKS_VERSION} from ${url}"
    return 0
  fi
  curl -sSfL "${url}" -o /tmp/restore-gitleaks.tgz &&
    as_root tar -xzf /tmp/restore-gitleaks.tgz -C /usr/local/bin gitleaks
}

restore_semgrep() {
  # ⚠️ `--ignore-installed PyJWT` が要る。イメージの PyJWT は debian パッケージ由来で
  # RECORD を持たず、pip が uninstall できずに依存解決がそこで止まる
  # （`ERROR: Cannot uninstall PyJWT 2.7.0, RECORD file not found.`）。
  # 握り潰すと「セッションは起動するのに semgrep だけ黙って入っていない」状態になる。
  if [ "${OPEN_RECEPTION_TOOL_RESTORE_DRY_RUN:-0}" = "1" ]; then
    restore_note "would install semgrep via pip (--break-system-packages --ignore-installed PyJWT)"
    return 0
  fi
  # pip の進捗は長い。失敗したときだけ見えればよいので、成功時は捨てる。
  as_root pip install --break-system-packages --ignore-installed PyJWT semgrep >/dev/null 2>&1
}

missing=()
command -v gitleaks >/dev/null 2>&1 || missing+=(gitleaks)
command -v semgrep >/dev/null 2>&1 || missing+=(semgrep)

if [ "${#missing[@]}" -eq 0 ]; then
  exit 0
fi

if [ "${OPEN_RECEPTION_SKIP_TOOL_RESTORE:-0}" = "1" ]; then
  restore_note "gate-tooling: restore skipped by OPEN_RECEPTION_SKIP_TOOL_RESTORE (missing: ${missing[*]})"
  exit 0
fi

printf '🔧 gate-tooling: restoring %s (#985)\n' "${missing[*]}" >&2
for tool in "${missing[@]}"; do
  case "${tool}" in
    gitleaks) restore_gitleaks || restore_note "gitleaks: restore FAILED（後続の gate-tooling 報告を見ること）" ;;
    semgrep) restore_semgrep || restore_note "semgrep: restore FAILED（後続の gate-tooling 報告を見ること）" ;;
  esac
done

exit 0
