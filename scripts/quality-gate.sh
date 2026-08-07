#!/usr/bin/env bash
#
# scripts/quality-gate.sh — ローカル品質ゲート
#
# 本リポジトリは GitHub Actions を使用しない方針のため、CI に相当する品質ゲートを
# このスクリプトでローカル（または Actions 以外のランナー）から実行する。
# ループ運用では「PR を作る前に必ず ./scripts/quality-gate.sh --pr が green」を必須とする。
#
# 段階（tier）:
#   --fast   typecheck + lint + unit            （各変更ごとの高速チェック・デフォルト）
#   --pr     fast + build + infra                （PR 作成前の必須ゲート）
#   --full   pr + secrets + sast + audit + e2e + lighthouse （マージ前/定期の重ゲート）
#
# 個別トグル（tier に追加・除外）:
#   --no-build       build を省く
#   --infra          infra/test/** の CDK アサーションを含める（--pr 以上は既定で ON）
#   --no-infra       infra/test/** を省く
#   --e2e            Playwright E2E を含める
#   --secrets        gitleaks による秘密情報スキャンを含める
#   --sast           semgrep による SAST を含める
#   --audit          npm audit（本番依存）を含める
#   --lighthouse     Lighthouse CI を含める
#   --strict         任意ツールが未インストールの場合も FAIL 扱いにする
#   --no-bootstrap   依存（node_modules / infra/node_modules）の自動インストールを行わない
#   --no-skip-docs   変更範囲による省略を無効化し、tier の全ステップを実行する
#
# 変更範囲による省略（docs スコープ）:
#   build / e2e / lighthouse / sast は**ソースを入力に取る**ため、文書だけを触った周回では
#   結果が変わり得ない。`scripts/change-scope.ts` が「文書のみ」と判定した場合これらを SKIP
#   する（実測 598s → 約 152s）。判定できないときは必ず code 扱い＝省略しない。
#   typecheck / lint / unit / secrets は docs でも実行する（判定器のバグに対するトリップワイヤ
#   と、文書への鍵混入の検出）。一覧の真実源は src/domain/governance/change-scope.ts。
#
# fresh な git worktree では node_modules / infra/node_modules が無いため、既定で
# 不足を検出したら install してからゲートを実行する（並列 worktree トラックの自己修復）。
#
# 終了コード: いずれかの必須ステップが失敗したら 1。SKIP（任意ツール未導入）は
#            --strict 指定時のみ失敗扱い。
#
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2
ROOT="$(pwd)"

# ---- 引数解析 -------------------------------------------------------------
RUN_TYPECHECK=1 RUN_LINT=1 RUN_UNIT=1 RUN_BUILD=0
RUN_E2E=0 RUN_SECRETS=0 RUN_SAST=0 RUN_AUDIT=0 RUN_LH=0 RUN_VRM=0 RUN_INFRA=0
STRICT=0
BOOTSTRAP=1
SKIP_BY_SCOPE=1
TIER="fast"

if [[ $# -eq 0 ]]; then set -- --fast; fi
for arg in "$@"; do
  case "$arg" in
    --fast) TIER="fast"; RUN_BUILD=0 ;;
    --pr)   TIER="pr";   RUN_BUILD=1; RUN_INFRA=1 ;;
    --full) TIER="full"; RUN_BUILD=1; RUN_SECRETS=1; RUN_SAST=1; RUN_AUDIT=1; RUN_E2E=1; RUN_LH=1; RUN_VRM=1; RUN_INFRA=1 ;;
    --no-build)   RUN_BUILD=0 ;;
    --infra)      RUN_INFRA=1 ;;
    --no-infra)   RUN_INFRA=0 ;;
    --e2e)        RUN_E2E=1 ;;
    --secrets)    RUN_SECRETS=1 ;;
    --vrm)        RUN_VRM=1 ;;
    --sast)       RUN_SAST=1 ;;
    --audit)      RUN_AUDIT=1 ;;
    --lighthouse) RUN_LH=1 ;;
    --strict)     STRICT=1 ;;
    --no-bootstrap) BOOTSTRAP=0 ;;
    --no-skip-docs) SKIP_BY_SCOPE=0 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ---- 解決した実行計画の出力（--dry-run） ----------------------------------
# ステップを 1 つも起動せず、tier がどのステップに解決したかだけを出す。
#
# これが無いと「--pr で infra が走るか」を確かめる手段が**スクリプトを目で読むこと**
# しか無くなる。#628（infra/test が 1 度も実行されていなかった）はまさに、
# 走っていないことを機械が誰も見ていなかったために 数ヶ月 表面化しなかった。
if [[ "${QUALITY_GATE_DRY_RUN:-0}" == "1" ]]; then
  echo "tier=${TIER}"
  for pair in "typecheck:$RUN_TYPECHECK" "lint:$RUN_LINT" "unit:$RUN_UNIT" "build:$RUN_BUILD" \
              "infra:$RUN_INFRA" "e2e:$RUN_E2E" "secrets:$RUN_SECRETS" "sast:$RUN_SAST" \
              "audit:$RUN_AUDIT" "lighthouse:$RUN_LH" "vrm:$RUN_VRM"; do
    echo "${pair%%:*}=${pair##*:}"
  done
  exit 0
fi

# ---- 実行ヘルパ -----------------------------------------------------------
declare -a SUMMARY
declare -a UNVERIFIED
FAILED=0

step() { # step <label> <cmd...>
  local label="$1"; shift
  echo ""
  echo "▶ ${label}"
  echo "  \$ $*"
  local start; start=$SECONDS
  if "$@"; then
    SUMMARY+=("PASS  ${label}  ($((SECONDS-start))s)")
  else
    SUMMARY+=("FAIL  ${label}  ($((SECONDS-start))s)")
    FAILED=1
  fi
}

report() { # report <label> <cmd...>
  # ゲートの PASS/FAIL に影響しない情報表示。**止めない**のが要点で、偽陽性のある検出器で
  # ゲートを赤くすると「赤を無視する習慣」がつく方が危険（#424 増分 3）。
  local label="$1"; shift
  echo ""
  echo "▶ ${label}（報告のみ・FAIL させない）"
  "$@" || echo "  (報告に失敗しました。ゲートは続行します)"
}

skip_or_fail() { # skip_or_fail <label> <reason>
  if [[ "$STRICT" -eq 1 ]]; then
    SUMMARY+=("FAIL  $1  (${2}; --strict)")
    FAILED=1
  else
    SUMMARY+=("SKIP  $1  (${2})")
  fi
}

# skip_unverified <label> <reason>
#
# **「検査できなかった」SKIP。** skip_or_fail（任意ツール未導入）とは意味が違う。
#
# 任意ツールが無いのは「その検査を持っていない」だけで、docs/quality-gate.md の既定として
# 許容している。一方こちらは**やるはずの検査が前提の破損で走らなかった**ので、
# 「落ちなかった」だけであり「通った」の根拠が無い。
#
# 🔴 これを skip_or_fail で扱っていたために #640 が起きた — `infra WebStack synth` が
# 45 件 SKIP されたまま exit 0 で `✅ PASSED (tier=full)` と記録され、
# pr-gate-guard がそれを根拠にマージを許した。**FAILED は立てず、記録だけ拒否する**
# （赤ではないが green でもない、という状態を正しく表す）。
skip_unverified() { # skip_unverified <label> <reason>
  SUMMARY+=("SKIP  $1  (${2})")
  UNVERIFIED+=("$1")
}

echo "================================================================"
echo " quality-gate  tier=${TIER}  $(node -v 2>/dev/null)"
echo " repo: ${ROOT}"
echo "================================================================"

# ---- green 記録（スタンプ）------------------------------------------------
# PASS 時に「どのツリーを・どの tier で検査したか」を .git 配下に記録する。
# scripts/hooks/pr-gate-guard.sh が gh pr create / merge の直前にこれを検証し、
# ゲート未実施・tier 不足・実行後の編集（stale）をブロックする。
# 指紋は**実行開始時点**で採る（実行中の編集を green として記録しないため）。
# shellcheck source=lib/gate-stamp.sh
. "${ROOT}/scripts/lib/gate-stamp.sh"
GATE_FINGERPRINT="$(gate_tree_fingerprint || true)"

# ---- 終了処理（summary → 判定 → 記録）------------------------------------
# **関数にしてあるのは、判定と記録の経路を 1 本にするため。** 呼び出し口が増えても
# 「記録を書く条件」がここ以外に散らない。
finish() {
  echo "================================================================"
  echo " summary (tier=${TIER})"
  echo "----------------------------------------------------------------"
  for line in "${SUMMARY[@]}"; do echo "  ${line}"; done
  echo "================================================================"

  if [[ "$FAILED" -eq 1 ]]; then
    echo "❌ quality-gate FAILED"
    exit 1
  fi

  # 🔴 検査できなかったステップがあるなら green として記録しない (#640)。
  # ここで記録してしまうと pr-gate-guard が「検査済み」と判断してマージを通す。
  # `${#UNVERIFIED[@]}` は使わない。**bash 5.x は `set -u` 下で「宣言済みだが要素ゼロ」の
  # 配列を unbound として落とす**（3.2 は 0 を返す。新しい方が厳しいという逆転がある）。
  # 実際にこれで落として気づいた。`${arr[*]:-}` は両方で安全。
  if [[ -n "${UNVERIFIED[*]:-}" ]]; then
    echo "⚠️  quality-gate は green として記録しません（tier=${TIER}）"
    echo "    検査できなかったステップ: ${UNVERIFIED[*]}"
    echo "    落ちてはいませんが「通った」根拠がありません。前提を整えて再実行してください。"
    echo "    よくある原因: .open-next/ が src/ より古い → npm run build:open-next"
    exit 1
  fi

  gate_write_stamp "${TIER}" "${GATE_FINGERPRINT}" "${GATE_SCOPE:-code}"
  echo "✅ quality-gate PASSED  (tier=${TIER} を green として記録しました)"
  # **finish は必ず終端する。** 呼び出し口が複数あるので、戻ると呼び出し元の続きが
  # 走ってしまう（seam から呼んだときに全ステップが実行された）。
  exit 0
}

# ---- 自己テスト用の seam --------------------------------------------------
# `tests/config/quality-gate-stamp.test.ts` が「検査できなかったステップがあると
# green として記録しない」ことを**実際に起動して**確かめるための入口。
# ステップは 1 つも実行せず finish() の判定だけを通す（QUALITY_GATE_DRY_RUN と同性格）。
if [[ -n "${QUALITY_GATE_SELFTEST:-}" ]]; then
  case "${QUALITY_GATE_SELFTEST}" in
    unverified) skip_unverified "selftest step" "前提が壊れていて検査できなかった" ;;
    optional)   skip_or_fail    "selftest step" "selftest tool not installed" ;;
    pass)       SUMMARY+=("PASS  selftest step") ;;
    *) echo "unknown QUALITY_GATE_SELFTEST: ${QUALITY_GATE_SELFTEST}" >&2; exit 2 ;;
  esac
  finish
fi

# ---- 依存 bootstrap（fresh worktree の自己修復）---------------------------
install_deps() { # install_deps <dir-label> <prefix-or-empty>
  local label="$1" prefix="$2" reason="$3"
  local lock; lock="${prefix:+$prefix/}package-lock.json"
  echo "  ↳ ${label}: ${reason} → インストールします"
  if [[ -f "$lock" ]]; then
    npm ${prefix:+--prefix "$prefix"} ci
  else
    npm ${prefix:+--prefix "$prefix"} install
  fi
}

# install が必要かを判定し、必要なら理由を echo して 0 を、不要なら 1 を返す。
#   - node_modules が無い（fresh worktree）
#   - package-lock.json が node_modules/.package-lock.json より新しい
#     （依存追加 PR をマージした後の lockfile ドリフト）
needs_install() { # needs_install <prefix-or-empty>
  local prefix="$1"
  local dir="${prefix:+$prefix/}node_modules"
  local lock="${prefix:+$prefix/}package-lock.json"
  local marker="${dir}/.package-lock.json"
  if [[ ! -d "$dir" ]]; then echo "node_modules が無い"; return 0; fi
  if [[ -f "$lock" && ( ! -f "$marker" || "$lock" -nt "$marker" ) ]]; then
    echo "package-lock.json が node_modules より新しい（ドリフト）"; return 0
  fi
  return 1
}

if [[ "$BOOTSTRAP" -eq 1 ]]; then
  if reason=$(needs_install ""); then
    install_deps "root" "" "$reason" || { echo "❌ root 依存のインストールに失敗"; exit 2; }
  fi
  # root tsconfig は infra/**/*.ts を include するため、infra 依存が無い/ドリフトしていると
  # typecheck/build が失敗する。infra/ があれば同様に同期する。
  if [[ -d infra ]] && reason=$(needs_install "infra"); then
    install_deps "infra" "infra" "$reason" || { echo "❌ infra 依存のインストールに失敗"; exit 2; }
  fi
fi

# ---- 比較起点の解決（浅い clone 対策・#557）------------------------------
# 変更量・変更範囲・停止境界の 3 つは同じ `origin/main` を起点に測るのに、**走る時刻が
# 違う**。浅い clone では `origin/main` がステールで、unshallow は secrets ステップまで
# 走らないため、同一実行の中で数字が食い違っていた（#557: 47 ファイル vs 7 件）。
#
# **起点は 1 度だけここで確定し、`GATE_BASE_SHA` で全消費者へ配る。** 各自が再解決すると
# 整合が「たまたま同時刻に同じ」という時間的性質に戻る（共有実装にしただけでは閉じない）。
# 変更範囲の判定より前に置くこと — あれだけが唯一ステップを省略できる消費者なので、
# 起点がずれると docs 判定で build / e2e / sast / lighthouse が飛ぶ。
if [[ "$(git rev-parse --is-shallow-repository 2>/dev/null)" == "true" ]]; then
  echo ""
  echo "▶ 比較起点の解決（shallow clone を検出・#557）"
  # **宛先 ref を明示する。** `git fetch origin main` は、PR ブランチだけを
  # `--single-branch` で clone した環境（クラウドサンドボックス）では refspec に main が
  # 無いため **`refs/remotes/origin/main` を作らない**（FETCH_HEAD に落とすだけ）。
  # 明示しないと修正が黙って空振りし、無駄な fetch が 2 回増えるだけになる。
  #
  # `GIT_TERMINAL_PROMPT=0` … 資格情報ヘルパが無い環境で入力待ちに入らせない。
  # `http.lowSpeed*` … TCP が落ちない proxy 環境で無限に待たせない。
  # ここは kill switch より前なので、**止まらないことがゲートを止められることより優先**。
  if GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 \
       fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' 2>/dev/null; then
    echo "  origin/main を更新しました"
  else
    echo "  ⚠️ origin/main を更新できませんでした（オフライン / 認証 / 到達不能）"
  fi
  if ! git merge-base origin/main HEAD >/dev/null 2>&1; then
    # 切り詰められた履歴では共通祖先へ届かないことがある。届かないと起点が
    # ステールな `main` や「起点不明」へ落ち、今度は**過小**に報告する。
    GIT_TERMINAL_PROMPT=0 git fetch --quiet --deepen=100 origin main 2>/dev/null || true
  fi
fi
# shallow でなくても、ここで 1 度だけ解決して全消費者へ配る（起点を実行内で固定する）。
GATE_BASE_SHA="$(git merge-base origin/main HEAD 2>/dev/null || git merge-base main HEAD 2>/dev/null || true)"
export GATE_BASE_SHA
if [[ -n "$GATE_BASE_SHA" ]]; then
  echo "  起点: ${GATE_BASE_SHA:0:8}（この実行の全ステップで共有）"
else
  echo "  ⚠️ 共通祖先へ到達できません。変更量・変更範囲・停止境界は作業ツリーのみで測られます"
  echo "     手動: git fetch --unshallow"
fi

# ---- 変更範囲の判定（ステップ省略）---------------------------------------
# 判定ロジックは src/domain/governance/change-scope.ts（純関数・ユニットテスト済）。
# **省略してよいステップ名も TS 側から受け取る**（shell に同じ一覧を持たせると二重管理）。
# 判定できない場合は必ず code 扱い＝何も省略しない（楽観に倒すと未検証ツリーが green になる）。
GATE_SCOPE="code"
GATE_SKIPS=" "
if [[ "$SKIP_BY_SCOPE" -eq 1 ]] && npx --no-install tsx --version >/dev/null 2>&1; then
  while IFS= read -r line; do
    case "$line" in
      scope=*) GATE_SCOPE="${line#scope=}" ;;
      skip=*)  GATE_SKIPS="${GATE_SKIPS}${line#skip=} " ;;
    esac
  done < <(npx --no-install tsx "${ROOT}/scripts/change-scope.ts" \
    $([[ "$STRICT" -eq 1 ]] && echo --strict) 2>/dev/null || echo "scope=code")
fi

# そのステップを変更範囲の理由で省略するか。
scope_skips() { # scope_skips <step-key>
  [[ "$GATE_SKIPS" == *" $1 "* ]]
}

# 省略した理由をサマリへ残す（黙って飛ばさない。何を検査していないかが見えること）。
scope_skip() { # scope_skip <label>
  SUMMARY+=("SKIP  $1  (${GATE_SCOPE}-scope: 入力が変わらない)")
}

if [[ "$GATE_SCOPE" != "code" ]]; then
  echo ""
  echo "▶ change-scope: ${GATE_SCOPE}（--no-skip-docs で全ステップ実行）"
  echo "  省略: ${GATE_SKIPS# }"
fi

# ---- ループの停止指示と変更量 (#424 増分 4) -------------------------------
# kill switch（.loop-halt / OPEN_RECEPTION_LOOP_HALT）が立っていれば **FAIL** させる。
# 人間の明示操作なので偽陽性が無く、止めると決めた人が居る。**最初に**置くのが要点で、
# 10 分のゲートを走り切ってから止めても kill switch の意味が無い。
# 同時に 1 周回の変更量を報告する（こちらは超えても FAIL させない。理由は
# src/domain/governance/change-budget.ts の冒頭）。判定は純関数側でユニットテスト済。
# **その場で abort する**（step でサマリに FAIL を積むだけでは残りを走り切ってしまい、
# 「10 分使う前に止める」目的を果たさない）。abort すると末尾の green 記録にも到達しないので、
# 停止中のツリーが green として記録されることもない。
if npx --no-install tsx --version >/dev/null 2>&1; then
  echo ""
  echo "▶ loop halt / 変更量 (#424)"
  if ! npx --no-install tsx "${ROOT}/scripts/change-budget.ts"; then
    echo ""
    echo "❌ quality-gate ABORTED (ループ停止指示。green は記録しません)"
    exit 1
  fi
  SUMMARY+=("PASS  loop halt / 変更量 (#424)")
else
  echo ""
  echo "▶ loop halt / 変更量 (#424)"
  echo "  tsx が無いため SKIP（判定ロジック自体は unit テストで検証済み）"
  SUMMARY+=("SKIP  loop halt / 変更量 (#424)  (tsx not available)")
fi

# ---- 必須ステップ ---------------------------------------------------------
[[ "$RUN_TYPECHECK" -eq 1 ]] && step "typecheck (tsc)"      npm run --silent typecheck
[[ "$RUN_LINT"      -eq 1 ]] && step "lint (eslint)"        npm run --silent lint
[[ "$RUN_UNIT"      -eq 1 ]] && step "unit (vitest)"        npm run --silent test
if [[ "$RUN_BUILD" -eq 1 ]]; then
  if scope_skips build; then scope_skip "build (next build)"
  else step "build (next build)" npm run --silent build; fi
fi

# CDK スタックのアサーション (#628)。
#
# root の `npm test` は root vitest の include（`src/**` ほか）しか走らせないため、
# **`infra/test/**` は 1 度も実行されていなかった**。合成されるテンプレートの中身は
# `tsc --noEmit` では見えない（型は通るがリソースの中身は誰も見ない）。
#
# root vitest の include に足すのではなく別ステップにしてある: infra は別の node_modules
# （aws-cdk-lib）を要し、synth が重い（~80s）ので `--fast` に載せたくない。加えて
# **独立ステップなら summary に自分の行を持てる** — これが「黙って 0 件にしない」の実体。
if [[ "$RUN_INFRA" -eq 1 ]]; then
  if scope_skips infra; then scope_skip "infra (cdk vitest)"
  elif [[ ! -d infra ]]; then skip_or_fail "infra (cdk vitest)" "infra/ が無い"
  else
    # `.open-next/` が fresh でないと WebStack の synth suite は自分で skip する。
    # **その事実を summary へ出す**（vitest の "skipped N" だけでは理由が残らない）。
    #
    # 🔴 **判定できなかったときに黙って先へ進まないこと。** 理由が空＝fresh と解釈すると、
    # tsx が無い・import が壊れた場合に「SKIP 行が出ないまま synth テストも走らない」
    # という #628 そのものの状態へ戻る。ここは 3 分岐で扱う。
    if npx --no-install tsx --version >/dev/null 2>&1; then
      probe_err="$(mktemp)"
      artifact_reason="$(npx --no-install tsx -e '
        import { openNextArtifactState, describeArtifactState } from "./infra/lib/build-artifacts";
        process.stdout.write(describeArtifactState(openNextArtifactState(process.cwd())));
      ' 2>"$probe_err")"
      probe_status=$?
      if [[ "$probe_status" -ne 0 ]]; then
        skip_unverified "infra WebStack synth" \
          "状態を判定できなかった（tsx 失敗: $(tr '\n' ' ' < "$probe_err" | cut -c1-120)）"
      elif [[ -n "$artifact_reason" ]]; then
        skip_unverified "infra WebStack synth" "$artifact_reason"
      fi
      rm -f "$probe_err"
    else
      skip_unverified "infra WebStack synth" "tsx が無いため .open-next の状態を判定できない"
    fi
    # 🔴 **root の typecheck では infra を検査しきれない。** root tsconfig は
    # `noUnusedLocals` を持たないが `infra/tsconfig.json` は持つため、`cdk synth` /
    # `cdk deploy` が使う ts-node の方が**厳しい**。vitest は esbuild で型を落とすので
    # ここも通らない。結果、**ゲート 12 段すべて green のまま `cdk deploy` が
    # コンパイルエラーで落ちる**状態が実在した（#630 のデプロイ直前に踏んだ）。
    step "infra typecheck (tsc)" npm --prefix infra run --silent typecheck
    step "infra (cdk vitest)" npm --prefix infra test
  fi
fi

# ---- 任意ステップ ---------------------------------------------------------
if [[ "$RUN_E2E" -eq 1 ]]; then
  if scope_skips e2e; then scope_skip "e2e (playwright)"
  else step "e2e (playwright)" npm run --silent test:e2e; fi
fi

if [[ "$RUN_SECRETS" -eq 1 ]]; then
  if command -v gitleaks >/dev/null 2>&1; then
    # `gitleaks detect` は作業ツリーではなく **git 履歴** を走査し、`.gitleaksignore` の指紋は
    # `<commit>:<file>:<rule>:<line>` の **commit SHA** で受容対象を特定する。
    #
    # **shallow clone だとこの指紋が原理的に一致しない。** 切り詰められた根より古い履歴が無い
    # ため、本来 2026-07-12 のコミットで入った文字列が「grafted root で新規追加された」ものと
    # して現れ、別の SHA で報告される。結果、受容済みのはずのテストフィクスチャが毎回
    # 新規検出として上がり、**実 secret と見分けが付かない red** になる（Claude Code on the web
    # は depth 50 で clone するため必ず踏む）。
    #
    # 履歴を完全化してから走らせる。走査対象が増える方向なので検出は弱まらない。
    if [[ "$(git rev-parse --is-shallow-repository 2>/dev/null)" == "true" ]]; then
      echo "  shallow clone を検出。.gitleaksignore の指紋照合に完全な履歴が要るため unshallow します"
      git fetch --unshallow --quiet 2>/dev/null || git fetch --deepen=2147483647 --quiet 2>/dev/null || true
      if [[ "$(git rev-parse --is-shallow-repository 2>/dev/null)" == "true" ]]; then
        echo "  ⚠️ unshallow に失敗しました。既知フィクスチャが新規検出として報告される可能性があります"
        echo "     手動: git fetch --unshallow"
      fi
    fi
    step "secrets (gitleaks)" gitleaks detect --no-banner --redact
  else
    skip_or_fail "secrets (gitleaks)" "gitleaks not installed"
  fi
fi

if [[ "$RUN_SAST" -eq 1 ]] && scope_skips sast; then
  scope_skip "sast (semgrep)"
elif [[ "$RUN_SAST" -eq 1 ]]; then
  if command -v semgrep >/dev/null 2>&1; then
    step "sast (semgrep)" semgrep scan --config p/default --error
  else
    skip_or_fail "sast (semgrep)" "semgrep not installed"
  fi
fi

if [[ "$RUN_AUDIT" -eq 1 ]]; then
  # `npm audit` を直接呼ばない。**root しか見ないため infra/ が監査されない** (#634)。
  # `scripts/audit-deps.ts` が root と infra の両方を監査し、期限付き allowlist で判定する。
  step "audit (deps)" npm run --silent audit:deps
fi

if [[ "$RUN_LH" -eq 1 ]] && scope_skips lighthouse; then
  scope_skip "lighthouse (lhci)"
elif [[ "$RUN_LH" -eq 1 ]]; then
  # lhci は Chrome を自力で探すが、プリインストール済み Chromium しか無い実行環境
  # （例: Claude Code on the web の /opt/pw-browsers）では見つけられず healthcheck で落ちる。
  # playwright.config.ts が同じ理由で同じパスを自動検出しているので、ここでも合わせる
  # （env を明示し忘れて「この環境では lighthouse は動かない」と誤結論するのを防ぐ。
  # e2e で実際にその誤結論が 5 周引き継がれた前例がある）。
  if [[ -z "${CHROME_PATH:-}" && -x /opt/pw-browsers/chromium ]]; then
    export CHROME_PATH=/opt/pw-browsers/chromium
  fi
  if command -v lhci >/dev/null 2>&1 || npx --no-install lhci --version >/dev/null 2>&1; then
    step "lighthouse (lhci)" npm run --silent lighthouse
  else
    skip_or_fail "lighthouse (lhci)" "lhci not available"
  fi
fi

# ---- VRM 実描画検査 -------------------------------------------------------
# #578 で入れた ResizeObserver の暴走ループ（DPR>1 で canvas が指数的に肥大し、実機 iPad が
# 落ちる）は **ローカルゲート 10 項目すべてが green のまま素通り**した。VRM 専用の検査は
# 存在したが `deviceScaleFactor: 1` で構造的に盲目だったうえ、手動実行だった。
# **手動の検査は回すのを忘れる**ので、機械が回す側へ置く。
#
# サーバは専用ポートで別に立てる（`scripts/vrm-check.sh`）。e2e サーバへ
# `KIOSK_DEFAULT_VRM_URL` を足すと全 e2e でアバターが描画され VRT ベースラインが総入れ替えに
# なるため、そちらへは相乗りさせない。
if [[ "$RUN_VRM" -eq 1 ]] && scope_skips vrm; then
  scope_skip "vrm (real render)"
elif [[ "$RUN_VRM" -eq 1 ]]; then
  step "vrm (real render)" npm run --silent vrm:check
fi

# ---- 変更リスクの報告 (#424 増分 3) ---------------------------------------
# 停止境界（人間承認が必要な変更）に触れたかを変更パスから判定して見せる。判定ロジックは
# src/domain/governance/change-risk.ts（純関数・ユニットテスト済）で、ここは呼ぶだけ。
# **別系統のチェッカにしない**（誰も回さなくなる）ためゲートに同居させるが、報告専用。
if npx --no-install tsx --version >/dev/null 2>&1; then
  report "change-risk (停止境界)" npx --no-install tsx "${ROOT}/scripts/change-risk.ts"
else
  echo ""
  echo "▶ change-risk (停止境界)（報告のみ）"
  echo "  tsx が無いため SKIP（判定ロジック自体は unit テストで検証済み）"
fi

# ---- サマリ ---------------------------------------------------------------
echo ""
finish
