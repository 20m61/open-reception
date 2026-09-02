#!/bin/bash
# SessionStart フック: クラウドセッションでのみ依存をインストールする。
#
# セットアップスクリプト（環境ダイアログ側）は **VM の素材**（gh / gitleaks / semgrep /
# ブラウザ）を入れる担当で、環境キャッシュに焼かれて以後は再実行されない。
# 対してリポジトリの依存は**クローンのたびに要る**のでこちら側で入れる。
# 区分の根拠は docs/cloud-dev-environment.md。
#
# ローカルでは何もしない（`CLAUDE_CODE_REMOTE` はクラウド VM でのみ "true"）。
# ローカルの node_modules をこのフックが勝手に触ると、作業中の依存状態を壊しうる。

set -u

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# 既に入っていれば何もしない（SessionStart は resume でも毎回走るので、
# 無条件 install は起動のたびに数十秒を足す）。判定は quality-gate.sh の
# bootstrap と同じ考え方: lockfile が node_modules より新しければドリフト。
needs_install() {
  local dir="${1:+$1/}node_modules"
  local lock="${1:+$1/}package-lock.json"
  [ ! -d "$dir" ] && return 0
  [ "$lock" -nt "$dir/.package-lock.json" ] && return 0
  return 1
}

if needs_install ""; then
  npm ci || true
fi

if [ -f infra/package-lock.json ] && needs_install "infra"; then
  npm ci --prefix infra || true
fi

# 品質ゲート任意ツールの欠落を SessionStart で名指しする (#838)。
# 欠けていてもここでは落とさない（報告だけ。ゲート側の SKIP / skip_unverified が本丸）。
# shellcheck source=lib/gate-tooling.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/gate-tooling.sh"
gate_tool_report "$(cd "${CLAUDE_PROJECT_DIR:-.}" && pwd)"

exit 0
