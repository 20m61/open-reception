#!/usr/bin/env bash
#
# scripts/lib/gate-stamp.sh — 品質ゲートの「green 記録（スタンプ）」の共有実装。
#
# 本リポジトリは GitHub Actions を使わないため `scripts/quality-gate.sh` が唯一のゲート
# だが、「PR 前に --pr / マージ前に --full」は規約上の自己申告に過ぎなかった。
# quality-gate.sh は PASS 時にここでスタンプを書き、scripts/hooks/pr-gate-guard.sh が
# `gh pr create` / `gh pr merge` の直前にそれを検証する。
#
# スタンプの置き場所は `.git`（正確には `git rev-parse --absolute-git-dir`）配下。
#   - コミットされない（作業成果物を汚さない）
#   - **worktree ごとに別**（並列トラックが互いのゲート結果を流用できない）
#
# 記録行のフォーマット（tab 区切り、append-only・末尾 MAX_STAMP_LINES 行のみ保持）:
#   <tier>\t<tree-fingerprint>\t<UTC timestamp>
#
# tree-fingerprint は「そのゲートが実際に検査したツリーの**内容**」を表す:
#   追跡ファイル + 未追跡（非 ignore）ファイルの、パスと中身のハッシュ。
#
# HEAD の SHA やコミット差分は**含めない**。ループの実際の順序は
#   ゲート green → コミット → gh pr create
# であり、HEAD に依存させるとコミットしただけで（中身は変わっていないのに）記録が
# stale になり、無意味な再実行を強いてしまうため。
#
# 逆に、ゲート後に 1 文字でも編集すれば指紋は変わり、記録は stale として無効になる。
# .gitignore 済み（node_modules・.next 等）は指紋に含めない。

MAX_STAMP_LINES=20

# 現在の作業ツリーに対応するスタンプファイルのパスを出力する。
# git リポジトリ外なら 1 を返す（呼び出し側で「判定不能」として扱う）。
gate_stamp_file() {
  local git_dir
  git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  [ -n "${git_dir}" ] || return 1
  printf '%s/open-reception-gate-stamp\n' "${git_dir}"
}

# 内部: 利用可能な SHA-256 実装で標準入力をハッシュする。
_gate_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256
  else
    sha256sum
  fi
}

# 現在の作業ツリーの指紋を出力する。git リポジトリ外なら 1 を返す。
#
# 対象は「git が中身を管理し得るファイル」＝ 追跡ファイル + 未追跡かつ非 ignore。
# パスでソートして順序の揺れを消し、各ファイルの内容ハッシュを連結して 1 つに畳む。
# 削除済み（index にあるが実体が無い）ファイルは missing として記録する。
#
# 内容ハッシュは `git hash-object --stdin-paths` に**一括**で採らせる。ファイルごとに
# shasum を起動すると本リポジトリ規模（約 1,200 ファイル）で 60 秒以上かかり、ゲートと
# フックの両方が実用に耐えなくなる（一括なら 0.2 秒）。何らかの理由で一括版が失敗した
# ときだけ、低速だが確実なファイル単位のフォールバックに落ちる。
gate_tree_fingerprint() {
  git rev-parse --git-dir >/dev/null 2>&1 || return 1

  local list existing missing hashes f
  list="$(mktemp)"; existing="$(mktemp)"; missing="$(mktemp)"; hashes="$(mktemp)"

  # core.quotePath=false が必須。既定では非 ASCII パスが "\350\250\255..." 形式に
  # エスケープされて出力され、実体が見つからず「削除済み」に分類されてしまう。
  # 結果としてそのファイルの**中身の変更を検出できない**（＝ stale なゲートを通す）。
  # 日本語ドキュメントを常用するリポジトリなので実際に踏み得る穴だった。
  {
    git -c core.quotePath=false ls-files 2>/dev/null
    git -c core.quotePath=false ls-files --others --exclude-standard 2>/dev/null
  } | sort -u > "${list}"

  while IFS= read -r f; do
    if [ -f "${f}" ]; then
      printf '%s\n' "${f}" >> "${existing}"
    else
      printf 'missing %s\n' "${f}" >> "${missing}"
    fi
  done < "${list}"

  if git hash-object --stdin-paths < "${existing}" > "${hashes}" 2>/dev/null &&
     [ "$(wc -l < "${hashes}")" -eq "$(wc -l < "${existing}")" ]; then
    { paste -d' ' "${hashes}" "${existing}"; cat "${missing}"; } | _gate_sha256 | awk '{print $1}'
  else
    # フォールバック: 一括ハッシュが使えない場合（特殊文字を含むパス等）。
    {
      while IFS= read -r f; do
        printf '%s %s\n' "$(_gate_sha256 < "${f}" | awk '{print $1}')" "${f}"
      done < "${existing}"
      cat "${missing}"
    } | _gate_sha256 | awk '{print $1}'
  fi

  rm -f "${list}" "${existing}" "${missing}" "${hashes}"
}

# tier を数値化する（比較用）。未知の tier は 0。
gate_tier_rank() {
  case "${1:-}" in
    fast) printf '1\n' ;;
    pr)   printf '2\n' ;;
    full) printf '3\n' ;;
    *)    printf '0\n' ;;
  esac
}

# ゲート PASS を記録する。gate_write_stamp <tier> [fingerprint] [scope]
#
# fingerprint は省略可だが、**ゲート開始時に採取した値を渡すこと**を推奨する。
# 実行中に作業ツリーが編集された場合、終了時に採り直すと「検査していないツリー」を
# green として記録してしまうため。
#
# scope（任意・4 列目）は「変更範囲によるステップ省略」の記録。**有効性の担保は指紋側**で、
# 省略はそのツリーに対してのみ成立する（コードを 1 文字でも触れば指紋が変わり記録は無効）。
# scope は「なぜ e2e が走っていないのか」を後から追えるようにするための情報。
# 読み取り側（gate_stamp_satisfies）は 4 列目以降を `_rest` で読み捨てるので後方互換。
gate_write_stamp() {
  local tier="$1" stamp fp scope
  stamp="$(gate_stamp_file)" || return 0   # git 外では黙って何もしない
  fp="${2:-$(gate_tree_fingerprint)}"
  scope="${3:-code}"
  [ -n "${fp}" ] || return 0
  printf '%s\t%s\t%s\t%s\n' "${tier}" "${fp}" "$(date -u +"%Y-%m-%dT%H:%MZ")" "${scope}" >> "${stamp}"
  # 無制限に伸びないよう末尾のみ残す。
  if [ "$(wc -l < "${stamp}")" -gt "${MAX_STAMP_LINES}" ]; then
    tail -n "${MAX_STAMP_LINES}" "${stamp}" > "${stamp}.tmp" && mv "${stamp}.tmp" "${stamp}"
  fi
}

# 現ツリーに対し要求 tier 以上の green 記録があるか。
# gate_stamp_satisfies <required-tier> → 0=満たす / 1=満たさない / 2=判定不能(git 外)
gate_stamp_satisfies() {
  local required="$1" stamp fp required_rank tier recorded_fp
  stamp="$(gate_stamp_file)" || return 2
  fp="$(gate_tree_fingerprint)" || return 2
  [ -f "${stamp}" ] || return 1
  required_rank="$(gate_tier_rank "${required}")"
  while IFS=$'\t' read -r tier recorded_fp _rest; do
    [ "${recorded_fp}" = "${fp}" ] || continue
    [ "$(gate_tier_rank "${tier}")" -ge "${required_rank}" ] && return 0
  done < "${stamp}"
  return 1
}
