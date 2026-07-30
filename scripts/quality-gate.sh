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
#   --pr     fast + build                        （PR 作成前の必須ゲート）
#   --full   pr + secrets + sast + audit + e2e + lighthouse （マージ前/定期の重ゲート）
#
# 個別トグル（tier に追加・除外）:
#   --no-build       build を省く
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
RUN_E2E=0 RUN_SECRETS=0 RUN_SAST=0 RUN_AUDIT=0 RUN_LH=0
STRICT=0
BOOTSTRAP=1
SKIP_BY_SCOPE=1
TIER="fast"

if [[ $# -eq 0 ]]; then set -- --fast; fi
for arg in "$@"; do
  case "$arg" in
    --fast) TIER="fast"; RUN_BUILD=0 ;;
    --pr)   TIER="pr";   RUN_BUILD=1 ;;
    --full) TIER="full"; RUN_BUILD=1; RUN_SECRETS=1; RUN_SAST=1; RUN_AUDIT=1; RUN_E2E=1; RUN_LH=1 ;;
    --no-build)   RUN_BUILD=0 ;;
    --e2e)        RUN_E2E=1 ;;
    --secrets)    RUN_SECRETS=1 ;;
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

# ---- 実行ヘルパ -----------------------------------------------------------
declare -a SUMMARY
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
  done < <(npx --no-install tsx "${ROOT}/scripts/change-scope.ts" 2>/dev/null || echo "scope=code")
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

# ---- 必須ステップ ---------------------------------------------------------
[[ "$RUN_TYPECHECK" -eq 1 ]] && step "typecheck (tsc)"      npm run --silent typecheck
[[ "$RUN_LINT"      -eq 1 ]] && step "lint (eslint)"        npm run --silent lint
[[ "$RUN_UNIT"      -eq 1 ]] && step "unit (vitest)"        npm run --silent test
if [[ "$RUN_BUILD" -eq 1 ]]; then
  if scope_skips build; then scope_skip "build (next build)"
  else step "build (next build)" npm run --silent build; fi
fi

# ---- 任意ステップ ---------------------------------------------------------
if [[ "$RUN_E2E" -eq 1 ]]; then
  if scope_skips e2e; then scope_skip "e2e (playwright)"
  else step "e2e (playwright)" npm run --silent test:e2e; fi
fi

if [[ "$RUN_SECRETS" -eq 1 ]]; then
  if command -v gitleaks >/dev/null 2>&1; then
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
  step "audit (npm audit)" npm audit --omit=dev
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
echo "================================================================"
echo " summary (tier=${TIER})"
echo "----------------------------------------------------------------"
for line in "${SUMMARY[@]}"; do echo "  ${line}"; done
echo "================================================================"

if [[ "$FAILED" -eq 1 ]]; then
  echo "❌ quality-gate FAILED"
  exit 1
fi

gate_write_stamp "${TIER}" "${GATE_FINGERPRINT}" "${GATE_SCOPE}"
echo "✅ quality-gate PASSED  (tier=${TIER} を green として記録しました)"
