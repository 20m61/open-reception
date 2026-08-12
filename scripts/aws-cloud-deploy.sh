#!/usr/bin/env bash
# =============================================================================
# Claude Code on the cloud から AWS dev へデプロイするための wrapper (spec §5)。
#
#   scripts/aws-cloud-deploy.sh <preflight|verify|diff|deploy|smoke>
#
# クラウドから素の `cdk deploy` を打たないための唯一の入口。迂回しても既定 qualifier の
# ロールを assume できず失敗する（fail-closed）が、迂回を前提にしない。
#
# 判定ロジックはこのファイルに書かない（bash はテストしづらい）。観測を集めて
# scripts/aws-preflight.ts と scripts/aws-diff-gate.ts へ渡す。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUALIFIER="orcloud01"
DEPLOY_ENV="${OR_DEPLOY_ENV:-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
STACKS=(
  "OpenReception-Web-${DEPLOY_ENV}"
  "OpenReception-WebMonitoring-${DEPLOY_ENV}"
  "OpenReception-CfMonitoring-${DEPLOY_ENV}"
)

usage() {
  echo "Usage: $0 <preflight|verify|diff|deploy|smoke>" >&2
}

if [ $# -lt 1 ]; then
  usage
  exit 2
fi
SUB="$1"
shift || true

case "${SUB}" in
  preflight|verify|diff|deploy|smoke) ;;
  *)
    echo "未知のサブコマンド: ${SUB}" >&2
    usage
    exit 2
    ;;
esac

# 環境の固定。dev 以外はここで止める（脅威 T13）。
if [ "${DEPLOY_ENV}" != "dev" ]; then
  echo "OR_DEPLOY_ENV=${DEPLOY_ENV} は許可されていません（dev のみ）" >&2
  exit 2
fi

# --help はサブコマンド判定だけして抜ける（テストが AWS に触れずに済むように）。
if [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

# `identity` (JSON 文字列) から 1 フィールドを取り出す。
#
# 🔴 **欠落を「問題なし」に落とさない。** `JSON.parse(s).Account` が `undefined` を
# 返しても素朴には例外にならず `console.log(undefined)` が "undefined" という文字列を
# 印字して exit 0 してしまう ―― それだと後続の JSON に一見もっともらしいがおかしな値が
# 静かに混ざる。ここでは値が欠けていたら明示的に非ゼロで落とし、`set -e` に拾わせる。
json_field() {
  local json="$1" field="$2"
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(s);
      } catch (e) {
        console.error("JSON parse に失敗しました: " + e.message);
        process.exit(1);
      }
      const value = parsed[process.argv[1]];
      if (typeof value !== "string" || value === "") {
        console.error("フィールド " + process.argv[1] + " が見つかりません");
        process.exit(1);
      }
      console.log(value);
    });
  ' "${field}" <<< "${json}"
}

collect_observation() {
  local out="$1" min_seconds="$2"
  local identity account arn expiry remaining clean stamp neg

  if ! identity="$(aws sts get-caller-identity --output json 2>&1)"; then
    echo "AWS 認証情報を解決できません: ${identity}" >&2
    return 1
  fi
  # json_field は失敗時に非ゼロで終わる（`set -e` により collect_observation ごと
  # 打ち切られる）。「取得できないので undefined 文字列を JSON に埋め込む」は許さない。
  account="$(json_field "${identity}" Account)"
  arn="$(json_field "${identity}" Arn)"

  # credential の残時間。取得できなければ null（判定不能を PASS にしない）。
  #
  # 🔴 **NaN を JSON に生で埋め込まない。** `AWS_CREDENTIAL_EXPIRATION` が不正な形式
  # （空でないがパース不能）だと `Date.parse` は例外を投げず `NaN` を返す。
  # `console.log(NaN)` は "NaN" という文字列を出力して exit 0 するため、
  # 素朴な実装では `set -euo pipefail` に捕まらず、後段のヒアドキュメントへ
  # `"credentialSecondsRemaining": NaN,` という**不正な JSON**をそのまま書き込んでしまう
  # （node -e 自体は成功して見えるが、下流の `JSON.parse` で初めて壊れて分かる ―
  # 診断としては不親切）。ここでは NaN を検出したら明示的に "null" 文字列を出力し、
  # 既存の「取得できなければ null」経路へ合流させる。
  expiry="${AWS_CREDENTIAL_EXPIRATION:-}"
  if [ -n "${expiry}" ]; then
    remaining="$(node -e '
      const ms = Date.parse(process.argv[1]);
      if (Number.isNaN(ms)) {
        console.log("null");
        process.exit(0);
      }
      console.log(Math.floor((ms - Date.now()) / 1000));
    ' "${expiry}")"
  else
    remaining="null"
  fi

  if [ -z "$(git -C "${ROOT}" status --porcelain -uall)" ]; then clean=true; else clean=false; fi

  # 品質ゲートのスタンプ（既存の scripts/lib/gate-stamp.sh を使う）。
  # shellcheck source=lib/gate-stamp.sh
  . "${ROOT}/scripts/lib/gate-stamp.sh"
  if gate_stamp_satisfies "pr"; then stamp=true; else stamp=false; fi

  if npx tsx "${ROOT}/scripts/aws-negative-tests.ts"; then neg=true; else neg=false; fi

  cat > "${out}" <<EOF
{
  "callerArn": "${arn}",
  "accountId": "${account}",
  "region": "${REGION}",
  "qualifier": "${QUALIFIER}",
  "environment": "${DEPLOY_ENV}",
  "credentialSecondsRemaining": ${remaining},
  "workingTreeClean": ${clean},
  "gateStampSatisfied": ${stamp},
  "negativeTestsPassed": ${neg}
}
EOF
  npx tsx "${ROOT}/scripts/aws-preflight.ts" "${out}" "${min_seconds}"
}

run_diff_gate() {
  local stack="$1" cs_name cs_json
  cs_name="claude-gate-$(git -C "${ROOT}" rev-parse --short HEAD)"
  cs_json="$(mktemp)"

  # cdk が change set を作る。--no-execute で実行しない。
  ( cd "${ROOT}/infra" && npx cdk deploy "${stack}" \
      -c env="${DEPLOY_ENV}" \
      -c "@aws-cdk/core:bootstrapQualifier=${QUALIFIER}" \
      --change-set-name "${cs_name}" --no-execute )

  aws cloudformation describe-change-set \
    --stack-name "${stack}" --change-set-name "${cs_name}" --output json > "${cs_json}"

  npx tsx "${ROOT}/scripts/aws-diff-gate.ts" "${cs_json}" "${stack}"
}

case "${SUB}" in
  preflight)
    collect_observation "$(mktemp)" 1200
    ;;
  verify)
    "${ROOT}/scripts/quality-gate.sh" --pr
    ( cd "${ROOT}" && npm run build:open-next )
    ;;
  diff)
    collect_observation "$(mktemp)" 1200
    for stack in "${STACKS[@]}"; do run_diff_gate "${stack}"; done
    ;;
  deploy)
    collect_observation "$(mktemp)" 2400
    for stack in "${STACKS[@]}"; do run_diff_gate "${stack}"; done
    ( cd "${ROOT}/infra" && npx cdk deploy "${STACKS[@]}" \
        -c env="${DEPLOY_ENV}" \
        -c "@aws-cdk/core:bootstrapQualifier=${QUALIFIER}" \
        --require-approval broadening )
    ;;
  smoke)
    if [ -z "${OR_SMOKE_URL:-}" ]; then
      echo "OR_SMOKE_URL が未設定です（デプロイ済み URL を渡してください）" >&2
      exit 2
    fi
    "${ROOT}/scripts/url-quality-gate.sh" "${OR_SMOKE_URL}"
    ( cd "${ROOT}" && E2E_BASE_URL="${OR_SMOKE_URL}" npm run test:e2e:live )
    ;;
esac
