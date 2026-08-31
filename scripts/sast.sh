#!/usr/bin/env bash
#
# scripts/sast.sh — SAST（semgrep）を**リポジトリ内のルールセット**で実行する (#841)。
#
# ## なぜレジストリを使わないのか
#
# 以前は `--config p/default` で、実行のたびに `semgrep.dev` を引いていた。これには 2 つ問題がある。
#
# 1. **遮断環境で恒久的に実行できない。** `CLAUDE.md` は `--pr` / `--full` をクラウド既定と
#    しているが、クラウドコンテナからは `semgrep.dev` へ CONNECT できない（実測 403）。
#    semgrep が導入済みでも sast が走らない ——「入っている」は「動く」ではない
# 2. **決定性が無い。** レジストリのルールは外側で更新されるので、同じツリーに対する結果が
#    日によって変わる。ゲートが何を保証しているのかが不定になる
#
# ## 終了コードの契約
#
#   0  … 検査を実施して指摘ゼロ
#   3  … **検査できなかった**（ルールセットが無い / ルールの自己テストが走らなかった）
#   他 … 指摘あり、または semgrep 自体の失敗
#
# 3 を分けているのは `quality-gate.sh` の `skip_unverified` へ倒すため。「ルールを引けなかった」を
# 「指摘ゼロ」と同じ緑として記録すると #640（infra synth が 45 件 SKIP のまま tier=full を記録）と
# 同じ被害になる。**赤ではないが green でもない**を正しく表す。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RULES="${ROOT}/semgrep-rules"

if ! command -v semgrep >/dev/null 2>&1; then
  echo "  semgrep が見つかりません（検査できませんでした）" >&2
  exit 3
fi

# 🔴 **ディレクトリの存在だけで判定しない。** 中身が消えても存在は残るので、
# 「ルール 0 件で 0 findings」＝ green という最悪の素通りになる。
if [[ ! -d "${RULES}" ]]; then
  echo "  ルールセット ${RULES} がありません（検査できませんでした）" >&2
  exit 3
fi
rule_count="$(find "${RULES}" -maxdepth 1 -name '*.yaml' -type f | wc -l | tr -d ' ')"
if [[ "${rule_count}" -eq 0 ]]; then
  echo "  ${RULES} に *.yaml のルールが 1 つもありません（検査できませんでした）" >&2
  exit 3
fi

# ---- 1. ルール自身の自己テスト -------------------------------------------
#
# 🔴 **`semgrep --test` は「テストが 1 つも見つからなかった」ときも exit 0 を返す。**
# そのまま信じると、ルールが空虚（何にも当たらない）になっても緑のままになる。実際に踏んだ罠が 2 つある:
#
#   - ルールファイルの拡張子が `.yml` だと**探索対象にならない**（`.yaml` のみ）
#   - **ドット始まりのディレクトリは丸ごと除外される**（当初 `.semgrep/` に置いていて気づいた）
#
# どちらも「静かに何も検査しない」に倒れる。だから終了コードではなく**出力を読んで**判定する。
test_out="$(semgrep --test "${RULES}" --metrics=off 2>&1)"
test_status=$?
echo "${test_out}"
if [[ "${test_status}" -ne 0 ]]; then
  echo "  ルールの自己テストが失敗しました（ルール側の退行）" >&2
  exit 1
fi
if ! grep -qE '[0-9]+/[0-9]+: .*All tests passed' <<<"${test_out}"; then
  echo "  ルールの自己テストが 1 件も走っていません（フィクスチャの命名・配置を確認）" >&2
  echo "  ルールは <name>.yaml、フィクスチャは同じ basename の <name>.ts で、非隠しディレクトリに置く" >&2
  exit 3
fi

# ---- 2. リポジトリ本体の走査 ---------------------------------------------
#
# フィクスチャは**意図的に違反を含む**ので走査対象から外す（外さないと必ず赤くなる）。
exec semgrep scan \
  --config "${RULES}" \
  --error \
  --metrics=off \
  --exclude semgrep-rules \
  --exclude node_modules
