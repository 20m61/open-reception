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

  local list existing special missing hashes f
  list="$(mktemp)"; existing="$(mktemp)"; special="$(mktemp)"
  missing="$(mktemp)"; hashes="$(mktemp)"

  # 🔴 **`-z`（NUL 区切り）で列挙する** (#720)。`core.quotePath=false` は非 ASCII を
  # 素通しするが、**`"` / 改行 / バックスラッシュを含むパスはそれでも引用・エスケープ
  # される**（`"quo\"te.md"`）。引用された文字列は実体として見つからず「削除済み」に
  # 分類され、**そのファイルの中身の変更が指紋に入らない** —— つまりゲート実行後に
  # 書き換えても stale と判定されず、`pr-gate-guard` がマージを通す。実測で再現済み。
  #
  # 🔴 **レコード列は最後に `LC_ALL=C sort -u` で畳む。** 列挙順に依存させると、
  # 内容が 1 バイトも変わっていなくても **`git add` しただけで指紋が変わる**
  # （新規ファイルが追跡ブロック側へ移り、行の順序が変わるため）。これは
  # 「コミットしただけで stale にしない」というこのファイルの設計意図に反する。
  # 改行は `\001` へ潰してあるので**行単位ソートが安全に使え**、`sort -z` の
  # BSD 可搬性問題も避けられる。ロケール差を持ち込まないよう `LC_ALL=C`。
  #
  # `-u` も要る: コンフリクト中（merge / rebase / cherry-pick）の `git ls-files` は
  # **unmerged パスをステージ 1/2/3 の 3 行**出す。「追跡と未追跡が素集合」なのは
  # 両リスト間の話で、追跡リスト内に重複が無いという意味ではない。
  {
    git ls-files -z 2>/dev/null
    git ls-files --others --exclude-standard -z 2>/dev/null
  } > "${list}"

  while IFS= read -r -d '' f; do
    if [ ! -f "${f}" ]; then
      printf 'missing %s\n' "${f//$'\n'/$'\001'}" >> "${missing}"
    elif [ "${f}" != "${f%%$'\n'*}" ] || [ "${f#\"}" != "${f}" ]; then
      # 🔴 **一括ハッシュへ渡せないパスは 1 件ずつ叩く。**
      #
      #  - 改行を含む … `--stdin-paths` は行区切りなので渡せない
      #  - **行頭が `"`** … `git hash-object --stdin-paths` は行頭 `"` を C-quote として
      #    **復号する**。`"a.md"` という名前のファイルが `a.md` に化け、**別ファイルの
      #    ハッシュ**が記録される（exit 0 で行数も合うので `wc -l` の検査も素通りする）。
      #    引用が閉じていない `"broken.md` では `fatal: line is badly quoted` で 128 終了し、
      #    毎回フォールバック（実測 50 秒）へ落ちる。
      #
      # 記録側では改行を \001 へ潰して行を壊さない。
      local blob
      blob="$(git hash-object -- "${f}" 2>/dev/null)"
      # ハッシュを採れなかったものを黙って空にしない（#720 と同じ穴になる）。
      [ -n "${blob}" ] || { rm -f "${list}" "${existing}" "${special}" "${missing}" "${hashes}"; return 1; }
      printf '%s %s\n' "${blob}" "${f//$'\n'/$'\001'}" >> "${special}"
    else
      printf '%s\n' "${f}" >> "${existing}"
    fi
  done < "${list}"

  if git hash-object --stdin-paths < "${existing}" > "${hashes}" 2>/dev/null &&
     [ "$(wc -l < "${hashes}")" -eq "$(wc -l < "${existing}")" ]; then
    {
      paste -d' ' "${hashes}" "${existing}"
      cat "${special}"
      cat "${missing}"
    } | LC_ALL=C sort -u | _gate_sha256 | awk '{print $1}'
  else
    # フォールバック: 一括ハッシュが使えない場合。低速だが確実。
    {
      while IFS= read -r f; do
        printf '%s %s\n' "$(_gate_sha256 < "${f}" | awk '{print $1}')" "${f}"
      done < "${existing}"
      cat "${special}"
      cat "${missing}"
    } | LC_ALL=C sort -u | _gate_sha256 | awk '{print $1}'
  fi

  rm -f "${list}" "${existing}" "${special}" "${missing}" "${hashes}"
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

# ---- 証拠ファイル（#1195）---------------------------------------------------
#
# スタンプは「このツリーを green で検査した」を**このマシンの中だけ**で覚える。
# Cloud で `--full` を回しても owner からは見えないので、PR へ載せられる形の記録を
# 別に書く。読むのは `scripts/publish-gate-evidence.ts`（判定は
# `src/domain/governance/gate-evidence.ts`）。
#
# 書式（1 行 1 項目・`key=value`）:
#   version / tier / head_start / dirty_start / started_at   … 開始時に書く
#   exit / stamped / head_end / dirty_end / finished_at     … 終了時に足す
#   env.<key>=<value>                                         … 実行環境（表示用）
#   summary=<summary の 1 行>                                 … 各ステップの結果
#
# 🔴 **開始時に仮の記録で上書きする。** 終了処理を通らずに死んだ（bootstrap 失敗・kill）
# 実行の後に、**前回の PASS の記録が残って読まれる**のを防ぐ。仮の記録には `exit` が
# 無いので、判定は「完走していない」になる。
#
# 置き場所はスタンプと同じく `.git` 配下（コミットされない・worktree ごとに別）。
# tier ごとに分けるのは、後から回した `--fast` が `--full` の証拠を消さないため。

GATE_EVIDENCE_VERSION=1

# gate_evidence_file <tier> — 証拠ファイルのパス。git 外なら 1。
gate_evidence_file() {
  local git_dir
  git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  [ -n "${git_dir}" ] || return 1
  printf '%s/open-reception-gate-evidence-%s\n' "${git_dir}" "$1"
}

# 作業ツリーが dirty か。0 / 1 / unknown（git status が失敗したら unknown ＝ clean と言わない）。
# 未追跡（非 ignore）も dirty に数える ―― 指紋と同じ範囲である。
_gate_dirty_flag() {
  local out
  out="$(git status --porcelain --untracked-files=all 2>/dev/null)" || { printf 'unknown\n'; return; }
  if [ -z "${out}" ]; then printf '0\n'; else printf '1\n'; fi
}

_gate_head() {
  git rev-parse --verify -q HEAD 2>/dev/null || true
}

# 値から改行を落とす（1 行 1 項目の書式を壊させない）。
_gate_evidence_line() { # _gate_evidence_line <key> <value>
  printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\r\n' '  ')"
}

# gate_evidence_begin <tier> — 開始時の記録を書く。git 外では何もしない。
gate_evidence_begin() {
  local file
  file="$(gate_evidence_file "$1")" || return 0
  GATE_EVIDENCE_HEAD_START="$(_gate_head)"
  GATE_EVIDENCE_DIRTY_START="$(_gate_dirty_flag)"
  GATE_EVIDENCE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  {
    _gate_evidence_line version "${GATE_EVIDENCE_VERSION}"
    _gate_evidence_line tier "$1"
    _gate_evidence_line head_start "${GATE_EVIDENCE_HEAD_START}"
    _gate_evidence_line dirty_start "${GATE_EVIDENCE_DIRTY_START}"
    _gate_evidence_line started_at "${GATE_EVIDENCE_STARTED_AT}"
  } > "${file}.tmp" && mv "${file}.tmp" "${file}"
}

# gate_evidence_finish <tier> <exit> <stamped:0|1> [summary 行...] — 終了時の記録で置き換える。
gate_evidence_finish() {
  local tier="$1" code="$2" stamped="$3" file runner line
  shift 3
  file="$(gate_evidence_file "${tier}")" || return 0
  if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then runner="claude-code-remote"; else runner="local"; fi
  {
    _gate_evidence_line version "${GATE_EVIDENCE_VERSION}"
    _gate_evidence_line tier "${tier}"
    _gate_evidence_line head_start "${GATE_EVIDENCE_HEAD_START:-}"
    _gate_evidence_line dirty_start "${GATE_EVIDENCE_DIRTY_START:-unknown}"
    _gate_evidence_line started_at "${GATE_EVIDENCE_STARTED_AT:-}"
    _gate_evidence_line exit "${code}"
    _gate_evidence_line stamped "${stamped}"
    _gate_evidence_line head_end "$(_gate_head)"
    _gate_evidence_line dirty_end "$(_gate_dirty_flag)"
    _gate_evidence_line finished_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    _gate_evidence_line env.runner "${runner}"
    _gate_evidence_line env.os "$(uname -srm 2>/dev/null || echo unknown)"
    _gate_evidence_line env.node "$(node -v 2>/dev/null || echo missing)"
    # 🔴 **道具は起動しない（在否だけを見る）。** 証拠のために `semgrep --version` を叩くと、
    # 「ルールセットが無いときは semgrep を起動しない」を縛る sast のテストが落ちる（実測）。
    # 版まで要るなら、各ステップのログを見る。
    _gate_evidence_line env.gitleaks "$(command -v gitleaks >/dev/null 2>&1 && echo present || echo missing)"
    _gate_evidence_line env.semgrep "$(command -v semgrep >/dev/null 2>&1 && echo present || echo missing)"
    # 実行計画（tier と個別トグルが解決した結果）。`--full --no-build` のように tier を
    # 名乗りながらステップを落とした実行を、判定側が見分けるため。
    # seam（QUALITY_GATE_SELFTEST）で起動した実行も記録する ―― ステップを 1 つも走らせていない。
    for line in ${GATE_EVIDENCE_PLAN:-}; do _gate_evidence_line "plan.${line%%=*}" "${line#*=}"; done
    _gate_evidence_line selftest "${QUALITY_GATE_SELFTEST:-}"
    # 測る対象を差し替える環境変数。**値は書かない**（在否だけ）。在れば判定側が PASS を拒む
    # ―― 検出器の差し替え（change-risk を素通しにできる）と、e2e の向け先の差し替え
    # （HEAD 以外のサーバを測る）。独立レビュー 2 周目 MINOR 3 / 4。
    for line in QUALITY_GATE_DETECTOR_CMD PLAYWRIGHT_BASE_URL; do
      if [ -n "${!line:-}" ]; then _gate_evidence_line "override.${line}" set; fi
    done
    for line in "$@"; do _gate_evidence_line summary "${line}"; done
  } > "${file}.tmp" && mv "${file}.tmp" "${file}"
}
