#!/usr/bin/env bash
# =============================================================================
# 実環境（稼働中の任意 URL）に対する品質ゲート。
#
# 用途: デプロイ済み URL やローカル本番ビルドに対して、外形からの品質チェックを回す。
#   - smoke      : 主要ルートが 200 を返すか（到達性）
#   - lighthouse : 性能/アクセシビリティ/ベストプラクティス（lighthouserc.json の閾値）
#   - zap        : OWASP ZAP baseline（受動スキャン・既知の警告を棚卸し）
#
# 使い方:
#   scripts/url-quality-gate.sh <BASE_URL> [--no-zap] [--no-lighthouse] [--strict]
# 例:
#   scripts/url-quality-gate.sh http://localhost:3000
#   scripts/url-quality-gate.sh https://d342uosvp8649l.cloudfront.net
#
# 前提: curl / docker（ZAP 用・colima 起動済み）/ npx（lighthouse 用）。
# 注意: ローカル(localhost)を ZAP(docker) からスキャンする場合、サーバを 0.0.0.0 で
#       起動し、URL は host.docker.internal に読み替える（本スクリプトが自動置換）。
#
# ## 任意ツールの扱い（SKIP 規約・2026-09-04 / クラウド実行で判明）
#
# `scripts/quality-gate.sh` と同じ規約に揃えた ―― **未導入の任意ツールは SKIP**、
# `--strict` のときだけ FAIL。以前は無条件 FAIL だったため、docker デーモンの無い
# クラウドサンドボックスでは **dev が健全でも smoke が必ず赤くなり**、
# runbook ステップ 10 が原理的に完走しなかった。
#
# 🔴 **SKIP は green ではない。** RESULT 行に必ず SKIP を併記する（#640 と同型 ――
# 「落ちなかった」を「通った」と読ませない）。
#
# ## lighthouse 用の Chrome
#
# lhci は `CHROME_PATH` を尊重する。クラウドサンドボックスには Playwright 同梱の
# chromium があるので、それを指せば実際に走る。例:
#   CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
# 解決できないときは SKIP（無いものを FAIL にしない）。
#
# 判定ロジックはこのファイルに書かない（bash はテストしづらい）。観測を集めて
# scripts/url-gate-tooling.ts → src/domain/governance/url-gate-tooling.ts へ渡す。
# =============================================================================
set -uo pipefail

BASE="${1:-}"
if [[ -z "$BASE" || "$BASE" == --* ]]; then
  echo "Usage: $0 <BASE_URL> [--no-zap] [--no-lighthouse] [--strict]" >&2
  exit 2
fi
shift || true
RUN_ZAP=1; RUN_LH=1; STRICT=0
for a in "$@"; do
  case "$a" in
    --no-zap) RUN_ZAP=0 ;;
    --no-lighthouse) RUN_LH=0 ;;
    --strict) STRICT=1 ;;
  esac
done
BASE="${BASE%/}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.url-quality-gate"
mkdir -p "$OUT"
FAILED=()
SKIPPED=()
PATHS=(/ /kiosk /admin/login)

echo "════════════════════════════════════════════════"
echo " URL quality gate: $BASE"
echo "════════════════════════════════════════════════"

# ---- 0. 道具の観測 -----------------------------------------------------------
# 🔴 **CLI の有無だけでは足りない。** クラウドサンドボックスには docker CLI があるが
# デーモンが無い（`/var/run/docker.sock` が存在しない）。CLI だけを見て実行すると
# `docker run` が exit 1 で落ち、それが zap の「高リスク検出」と同じコードなので
# **インフラ障害がセキュリティ指摘として報告される**（下の zap 節を参照）。
obs_docker_cli=false; obs_docker_daemon=false
command -v docker >/dev/null 2>&1 && obs_docker_cli=true
[[ "$obs_docker_cli" == true ]] && docker info >/dev/null 2>&1 && obs_docker_daemon=true

PLAN_ZAP="run"; PLAN_ZAP_REASON=""
if plan_out="$(npx --no-install tsx "$ROOT/scripts/url-gate-tooling.ts" plan \
    "--strict=${STRICT}" \
    "dockerCli=${obs_docker_cli}" \
    "dockerDaemon=${obs_docker_daemon}" 2>/dev/null)"; then
  while IFS=$'\t' read -r kv reason; do
    case "$kv" in
      zap=*) PLAN_ZAP="${kv#zap=}"; PLAN_ZAP_REASON="$reason" ;;
    esac
  done <<< "$plan_out"
else
  # 🔴 判定器が動かないことを「道具は揃っている」に倒さない。走らせずに FAIL する
  # （`quality-gate.sh` の skip_unverified と同じで、検査できなかったものを green にしない）。
  echo "  ⛔ 判定器（scripts/url-gate-tooling.ts）を実行できませんでした" >&2
  FAILED+=("url-gate-tooling(判定不能)")
  PLAN_ZAP="fail"; PLAN_ZAP_REASON="判定器が実行できません"
fi

# ---- 1. smoke（到達性） -------------------------------------------------------
echo "── smoke（主要ルート 200）"
for p in "${PATHS[@]}"; do
  # 🔴 **`|| echo 000` を付けない。** curl は接続失敗時も `-w '%{http_code}'` で `000` を
  # 出力し、**かつ非ゼロで終了する**。`||` を付けると 2 つ目の `000` が連結され、
  # 出力が `000000` になる（実測。長さ 6）。運用者には HTTP コードとして読めない値が出る。
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE$p")"
  printf '  %-16s HTTP %s\n' "$p" "$code"
  if [[ "$code" == "000" ]]; then
    # 接続そのものが成立していない（DNS / TLS / プロキシ拒否）。HTTP エラーとは別物なので
    # そう書く ―― 「503 を返した」と「一度も届かなかった」を同じ文言にしない。
    FAILED+=("smoke $p (接続不成立)")
  elif [[ "$code" != "200" ]]; then
    FAILED+=("smoke $p ($code)")
  fi
done

# ---- 2. lighthouse ----------------------------------------------------------
if [[ "$RUN_LH" == 1 ]]; then
  echo "── lighthouse（性能/a11y/best-practices）"
  # 🔴 **Chrome の探索を自前でやらない（2026-09-05 の退行）。** 以前ここには
  # `command -v google-chrome` 等の事前判定があったが、**Linux のコマンド名だけ**を見て
  # いたため、macOS の Chrome（`/Applications/...app/Contents/MacOS/...`）を見つけられず
  # **Chrome が入っている Mac でも必ず SKIP** していた ―― runbook が「ローカル macOS で
  # 回せ」と言っている当の環境で、走っていた検査を黙って止めていた。
  # lhci は chrome-launcher で OS ごとの探索を持っている。写せば必ずドリフトするので、
  # **探索は lhci に任せ、結果を解釈する**（ZAP と同じ形）。
  {
      cat > "$OUT/lhci.json" <<JSON
{
  "ci": {
    "collect": {
      "url": ["$BASE/", "$BASE/kiosk", "$BASE/admin/login"],
      "numberOfRuns": 1,
      "settings": { "chromeFlags": "--no-sandbox --headless=new --disable-gpu", "onlyCategories": ["performance","accessibility","best-practices"] }
    },
    "assert": { "assertions": {
      "categories:accessibility": ["error", { "minScore": 0.9 }],
      "categories:best-practices": ["error", { "minScore": 0.9 }],
      "categories:performance": ["warn", { "minScore": 0.7 }]
    } },
    "upload": { "target": "filesystem", "outputDir": "$OUT/lighthouse" }
  }
}
JSON
      # 🔴 **前回のレポートを消してから走らせる。** 残っていると「測れた」証拠に化け、
      # Chrome 不在や到達不能を「閾値未達」と誤読する。
      rm -rf "$OUT/lighthouse"
      lh_rc=0
      npx --yes @lhci/cli@0.15.x autorun --config="$OUT/lhci.json" \
        > "$OUT/lighthouse.log" 2>&1 || lh_rc=$?
      lh_report=false
      # lhci は収集できたときだけ outputDir へ結果を書く。healthcheck や収集段で落ちれば空。
      [[ -d "$OUT/lighthouse" ]] && [[ -n "$(ls -A "$OUT/lighthouse" 2>/dev/null)" ]] \
        && lh_report=true
      lh_outcome="$(npx --no-install tsx "$ROOT/scripts/url-gate-tooling.ts" \
        lighthouse-exit "$lh_rc" "$lh_report" 2>/dev/null || echo unverified)"
      case "$lh_outcome" in
        pass)
          echo "  lighthouse: PASS（詳細 $OUT/lighthouse）" ;;
        threshold)
          echo "  lighthouse: 閾値未達（$OUT/lighthouse.log 参照）"
          FAILED+=("lighthouse") ;;
        *)
          # 測れなかった。Chrome が無い / 対象へ到達できない等。green にも red にもしない
          # ―― 対象サイトの品質については何も言えていない。
          echo "  lighthouse: 測れませんでした（exit ${lh_rc}・レポート無し。$OUT/lighthouse.log 参照）"
          SKIPPED+=("lighthouse(未実行)")
          if [[ "$STRICT" -eq 1 ]]; then
            FAILED+=("lighthouse(未実行; --strict)")
          fi ;;
      esac
  }
fi

# ---- 3. OWASP ZAP baseline --------------------------------------------------
if [[ "$RUN_ZAP" == 1 ]]; then
  echo "── OWASP ZAP baseline（受動スキャン）"
  case "$PLAN_ZAP" in
    skip)
      echo "  ZAP: SKIP（${PLAN_ZAP_REASON}）"
      SKIPPED+=("zap")
      ;;
    fail)
      echo "  ZAP: FAIL（${PLAN_ZAP_REASON}）"
      FAILED+=("zap(${PLAN_ZAP_REASON})")
      ;;
    *)
      ZAP_TARGET="$BASE"
      # localhost をコンテナから見えるホスト名へ置換。
      ZAP_TARGET="${ZAP_TARGET/http:\/\/localhost/http://host.docker.internal}"
      ZAP_TARGET="${ZAP_TARGET/http:\/\/127.0.0.1/http://host.docker.internal}"
      # 🔴 **前回のレポートを消してから走らせる。** 残っていると「zap が走った」証拠に
      # 化け、docker 側の失敗を high-risk と誤読する（下の判定はレポートの有無を見る）。
      rm -f "$OUT/zap-report.html"
      rc=0
      docker run --rm -t -v "$OUT:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable \
        zap-baseline.py -t "$ZAP_TARGET/kiosk" -m 2 -r zap-report.html -I \
        > "$OUT/zap.log" 2>&1 || rc=$?
      report_written=false
      [[ -s "$OUT/zap-report.html" ]] && report_written=true
      # 🔴 **終了コードだけで判定しない。** `zap-baseline.py` は 1=高リスク / 2=WARN だが、
      # `docker run` 自体の失敗（デーモン停止・pull 失敗）も 1 を返す。実測で確認済み。
      # レポートが書かれていなければ zap は一度も走っていないので unverified。
      outcome="$(npx --no-install tsx "$ROOT/scripts/url-gate-tooling.ts" \
        zap-exit "$rc" "$report_written" 2>/dev/null || echo unverified)"
      case "$outcome" in
        pass)
          echo "  ZAP: 完了（警告なし or 既知のみ）。レポート: $OUT/zap-report.html" ;;
        warn)
          echo "  ZAP: WARN のみ（-I で無視）。レポート: $OUT/zap-report.html" ;;
        high-risk)
          echo "  ZAP: 高リスク検出（$OUT/zap.log / $OUT/zap-report.html を確認）"
          FAILED+=("zap(high-risk)") ;;
        *)
          # 走らなかった／読めなかった。green にも red にもしない ―― SKIP として記録し、
          # 「高リスクが出た」とは**言わない**（それが今回直している誤ラベル）。
          echo "  ZAP: 実行できませんでした（exit ${rc}・レポート無し。$OUT/zap.log 参照）"
          SKIPPED+=("zap(未実行)")
          if [[ "$STRICT" -eq 1 ]]; then
            FAILED+=("zap(未実行; --strict)")
          fi ;;
      esac
      ;;
  esac
fi

# ---- 結果 -------------------------------------------------------------------
echo "════════════════════════════════════════════════"
# 🔴 **SKIP を必ず併記する。** SKIP があるのに素の `PASS` と出すと、#640（45 件 SKIP の
# まま tier=full を green 記録）と同じ誤読を生む。赤ではないが green でもない。
SKIP_NOTE=""
[[ ${#SKIPPED[@]} -gt 0 ]] && SKIP_NOTE=" — SKIP: ${SKIPPED[*]}"
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo " RESULT: PASS${SKIP_NOTE}"
  exit 0
else
  echo " RESULT: FAIL — ${FAILED[*]}${SKIP_NOTE}"
  exit 1
fi
