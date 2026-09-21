#!/usr/bin/env bash
# ローカル AWS エミュレータのライフサイクル（ADR 0010 / #1103）。
#
# ## 何のためにあるか
#
# 「ローカルで AWS を検証できるか」が**単一ベンダのライセンス状態に従属していた**
# （LocalStack freemium は Cognito と AutoScaling を拒否する。2026-09-14 実測）。
# ここはエミュレータを**交換可能な設定**として扱い、アプリのコードから製品名を消す。
#
#   ministack  … 既定。Docker 不要 (pure Python)。🔴 Cognito は素通りする（docs/local-aws.md）
#   moto       … 高速 fallback。Polly を持つ唯一の実行系
#   localstack … compatibility layer（Docker が要る。scripts/local-aws.sh へ委譲）
#
# 🔴 **このスクリプトは実 AWS を相手にしない。** `AWS_RUNTIME=aws` は拒否する。
# 実 AWS を叩く経路をここに作ると、誤って本番へ向く面が増えるだけで得が無い。
set -euo pipefail

# 🔴 進捗メッセージ（`[aws-local] ...`）は **stderr** へ出す。stdout は
# `env` / `status` / `capability --json` の**データ専用**である ―― 混ぜると
# `npm run aws:local:capability -- --json` の出力が JSON として読めなくなる
# （#1110 のレビューで実測。#1113 はこの出力を機械で読む前提）。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---------------------------------------------------------------------------
# 実行系の選択
# ---------------------------------------------------------------------------
AWS_RUNTIME="${AWS_RUNTIME:-}"
[ -z "$AWS_RUNTIME" ] && AWS_RUNTIME=ministack
# 🔴 **export する。** しないと子プロセス（npx tsx など）が実行系を見られず、
# `resolveAwsRuntimeConfig` が `aws` として解決してしまい、エミュレータ側の
# 誤接続 guard（real_credentials / endpoint_is_real_aws）が**評価されない**
# （レビュー round2 MINOR-2 で実測）。他のレーン変数と揃える。
export AWS_RUNTIME

case "$AWS_RUNTIME" in
  ministack) DEFAULT_PORT=4566 ;;
  moto)      DEFAULT_PORT=5000 ;;
  localstack) DEFAULT_PORT=4566 ;;
  aws)
    echo "[aws-local] AWS_RUNTIME=aws はこのレーンでは使えません。" >&2
    echo "[aws-local] ここはローカルエミュレータ専用です（実 AWS は最終検証で。現状の実環境は dev）。" >&2
    exit 2
    ;;
  *)
    echo "[aws-local] 知らない AWS_RUNTIME です: ${AWS_RUNTIME}" >&2
    echo "[aws-local] 使えるのは: ministack | moto | localstack" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# 資格情報の隔離
#
# 🔴 無条件に dummy へ置き換える（`:-` を使わない）。`:-` は「未設定なら」なので、
# デプロイ窓が開いているセッションでは**実 STS 資格情報をそのまま引き継ぐ**。
# `AWS_CREDENTIAL_EXPIRATION` は値ではなく**存在**が効く（残っていると SDK/CLI が
# dummy まで「失効済み」と判定する。2026-09-14 実測）。
# ---------------------------------------------------------------------------
export AWS_REGION="${AWS_REGION:-ap-northeast-1}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
unset AWS_SESSION_TOKEN
unset AWS_PROFILE
unset AWS_CREDENTIAL_EXPIRATION
unset AWS_ROLE_ARN
unset AWS_WEB_IDENTITY_TOKEN_FILE
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
unset AWS_CONTAINER_CREDENTIALS_FULL_URI
unset AWS_CONTAINER_AUTHORIZATION_TOKEN
unset AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
export AWS_EC2_METADATA_DISABLED=true

export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://127.0.0.1:${DEFAULT_PORT}}"

# 🔴 呼び出し側が実 AWS の endpoint を渡してきたら拒否する。
# env は上書きできるので、「上書きされたら従う」設計だと guard が意味を失う。
case "$AWS_ENDPOINT_URL" in
  *amazonaws.com*)
    echo "[aws-local] AWS_ENDPOINT_URL が実 AWS を向いています: ${AWS_ENDPOINT_URL}" >&2
    echo "[aws-local] ローカルレーンから実 AWS は叩きません。" >&2
    exit 2
    ;;
esac

export DATA_BACKEND="${DATA_BACKEND:-dynamodb}"
export TABLE_NAME="${TABLE_NAME:-open-reception-local}"

# ---------------------------------------------------------------------------
# エミュレータの導入（Docker 不要。pip で固定版を入れる）
#
# 🔴 **venv を実行系ごとに分ける。** ministack は `botocore==1.43.63` を厳密 pin する
# 一方 moto[server] は別版を要求するので、同居させると片方が壊れる（2026-09-14 実測）。
# ---------------------------------------------------------------------------
AWS_LOCAL_HOME="${AWS_LOCAL_HOME:-$ROOT/.aws-local}"
# 委譲先を差し替え可能にする（テストから「戻ってくること」を確かめるための seam）。
LOCAL_AWS_SCRIPT="${LOCAL_AWS_SCRIPT:-$ROOT/scripts/local-aws.sh}"
MINISTACK_VERSION="${MINISTACK_VERSION:-1.5.11}"
MOTO_VERSION="${MOTO_VERSION:-5.2.3}"
READY_SECONDS="${AWS_LOCAL_READY_SECONDS:-120}"

venv_dir() { echo "${AWS_LOCAL_HOME}/venv-${AWS_RUNTIME}"; }
venv_bin() { echo "$(venv_dir)/bin"; }

python_bin() {
  command -v python3 >/dev/null 2>&1 || {
    echo "[aws-local] python3 が必要です（エミュレータは pure Python です）。" >&2
    exit 1
  }
  echo python3
}

ensure_venv() {
  local dir bin pkg
  dir="$(venv_dir)"; bin="$(venv_bin)"
  case "$AWS_RUNTIME" in
    ministack) pkg="ministack==${MINISTACK_VERSION}" ;;
    moto)      pkg="moto[server]==${MOTO_VERSION}" ;;
  esac
  if [ ! -x "${bin}/python" ]; then
    echo "[aws-local] creating venv: ${dir}" >&2
    "$(python_bin)" -m venv "$dir"
    "${bin}/pip" install -q --upgrade pip
  fi
  # 固定版が入っているかだけ見る（毎回 install しない）。
  if ! "${bin}/pip" show "${pkg%%[<=>[]*}" >/dev/null 2>&1; then
    echo "[aws-local] installing ${pkg}" >&2
    "${bin}/pip" install -q "$pkg"
  fi
}

emulator_healthy() {
  curl -fsS --noproxy '*' --max-time 3 "${AWS_ENDPOINT_URL}/_localstack/health" >/dev/null 2>&1 ||
    curl -fsS --noproxy '*' --max-time 3 -o /dev/null "${AWS_ENDPOINT_URL}/" >/dev/null 2>&1
}

wait_ready() {
  local i
  for ((i = 1; i <= READY_SECONDS; i++)); do
    if emulator_healthy; then
      echo "[aws-local] ${AWS_RUNTIME} ready (${i}s) at ${AWS_ENDPOINT_URL}" >&2
      return 0
    fi
    sleep 1
  done
  echo "[aws-local] ${AWS_RUNTIME} did not become ready within ${READY_SECONDS}s" >&2
  [ -f "${AWS_LOCAL_HOME}/${AWS_RUNTIME}.log" ] && tail -30 "${AWS_LOCAL_HOME}/${AWS_RUNTIME}.log" >&2
  exit 1
}

port_of_endpoint() { echo "${AWS_ENDPOINT_URL##*:}"; }

start_emulator() {
  if [ "$AWS_RUNTIME" = "localstack" ]; then
    # compatibility layer: 既存の Docker ベースのレーンへ委譲する。
    #
    # 🔴 **`exec` にしない。** `exec` はこのシェルを置き換えるので、`test` や `up` の
    # 後段（bootstrap / seed / テスト実行）へ**二度と戻ってこない**。委譲した時点で
    # 成功したように見えるが、テストは 1 本も走らない。呼んで戻る。
    bash "$LOCAL_AWS_SCRIPT" up
    return 0
  fi
  if emulator_healthy; then
    echo "[aws-local] ${AWS_RUNTIME} already running at ${AWS_ENDPOINT_URL}" >&2
    return 0
  fi
  ensure_venv
  mkdir -p "$AWS_LOCAL_HOME"
  local bin port log
  bin="$(venv_bin)"; port="$(port_of_endpoint)"; log="${AWS_LOCAL_HOME}/${AWS_RUNTIME}.log"
  echo "[aws-local] starting ${AWS_RUNTIME} on port ${port} (no Docker)" >&2
  case "$AWS_RUNTIME" in
    ministack) GATEWAY_PORT="$port" nohup "${bin}/ministack" -d >"$log" 2>&1 || true ;;
    moto)      nohup "${bin}/moto_server" -p "$port" -H 127.0.0.1 >"$log" 2>&1 & ;;
  esac
  wait_ready
}

stop_emulator() {
  if [ "$AWS_RUNTIME" = "localstack" ]; then
    bash "$LOCAL_AWS_SCRIPT" down
    return 0
  fi
  local bin; bin="$(venv_bin)"
  case "$AWS_RUNTIME" in
    ministack) [ -x "${bin}/ministack" ] && "${bin}/ministack" --stop >/dev/null 2>&1 || true ;;
    moto)      pkill -f "moto_server -p $(port_of_endpoint)" >/dev/null 2>&1 || true ;;
  esac
  echo "[aws-local] ${AWS_RUNTIME} stopped" >&2
}

# ---------------------------------------------------------------------------
# 初期リソース
#
# 🔴 **素の AWS CLI で作る。** `lstk aws` のようなベンダ CLI を使うと、そのベンダが
# 居ないと bootstrap できなくなる ―― 交換可能にする目的と正面から衝突する。
# ---------------------------------------------------------------------------
aws_cli() { aws --endpoint-url "$AWS_ENDPOINT_URL" "$@"; }

bootstrap() {
  command -v aws >/dev/null 2>&1 || {
    echo "[aws-local] aws CLI が必要です（bootstrap はベンダ CLI に依存しません）。" >&2
    exit 1
  }
  if ! aws_cli dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
    echo "[aws-local] creating DynamoDB table: ${TABLE_NAME}" >&2
    aws_cli dynamodb create-table \
      --table-name "$TABLE_NAME" \
      --attribute-definitions \
        AttributeName=PK,AttributeType=S \
        AttributeName=SK,AttributeType=S \
        AttributeName=GSI1PK,AttributeType=S \
        AttributeName=GSI1SK,AttributeType=S \
      --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
      --global-secondary-indexes \
        'IndexName=GSI1,KeySchema=[{AttributeName=GSI1PK,KeyType=HASH},{AttributeName=GSI1SK,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
      --billing-mode PAY_PER_REQUEST >/dev/null
    aws_cli dynamodb wait table-exists --table-name "$TABLE_NAME"
  fi

  # TTL。状態の読み取りは**値だけ**を取り出す（CLI が案内行を混ぜることがある）。
  local ttl
  ttl="$(aws_cli dynamodb describe-time-to-live --table-name "$TABLE_NAME" \
    --query 'TimeToLiveDescription.TimeToLiveStatus' --output text 2>/dev/null |
    grep -v '^>' | awk 'NF' | tail -n 1 || true)"
  if [ "$ttl" != "ENABLED" ] && [ "$ttl" != "ENABLING" ]; then
    echo "[aws-local] enabling DynamoDB TTL on 'ttl'" >&2
    aws_cli dynamodb update-time-to-live --table-name "$TABLE_NAME" \
      --time-to-live-specification 'Enabled=true,AttributeName=ttl' >/dev/null
  fi
  echo "[aws-local] bootstrap complete (endpoint=${AWS_ENDPOINT_URL} table=${TABLE_NAME})" >&2
}

# 🔴 seed は合成データのみ。dev/staging/production のデータを複製しない。
seed() {
  echo "[aws-local] seeding deterministic synthetic data" >&2
  npm run seed:dynamodb -- --with-mock
}

run_tests() {
  npm run --silent local:aws:smoke
  LOCAL_AWS_INTEGRATION=1 npm run --silent local:aws:integration
}

capability() {
  # 能力の実測（#1103）。**負の対照つき**で測る ―― 「操作が成功した」は
  # 「その能力が使える」ではない（Cognito が誤ったパスワードを受理していた実例）。
  # 素通りが 1 件でもあれば非 0 で返るので、呼び出し側でそのまま検知できる。
  npx tsx "${ROOT}/scripts/aws-local-capability.ts" "$@"
}

reset_state() {
  # 捨てて作り直すのが最も確実（状態は必ず空から始まる）。
  stop_emulator
  start_emulator
  bootstrap
  seed
  echo "[aws-local] reset complete" >&2
}

lane_env() {
  # 🔴 前提（venv / エミュレータ本体 / aws CLI）を一切要求しない。
  # 前提が無い環境でも「どこを向き、どの資格情報で動くか」は観測できねばならない。
  echo "AWS_RUNTIME=${AWS_RUNTIME}"
  echo "AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL}"
  echo "AWS_REGION=${AWS_REGION}"
  echo "AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}"
  echo "AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}"
  echo "AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN-<unset>}"
  echo "AWS_PROFILE=${AWS_PROFILE-<unset>}"
  echo "AWS_CREDENTIAL_EXPIRATION=${AWS_CREDENTIAL_EXPIRATION-<unset>}"
  echo "DATA_BACKEND=${DATA_BACKEND}"
  echo "TABLE_NAME=${TABLE_NAME}"
  echo "DOCKER_REQUIRED=$([ "$AWS_RUNTIME" = localstack ] && echo yes || echo no)"
}

status() {
  echo "runtime=${AWS_RUNTIME} endpoint=${AWS_ENDPOINT_URL}"
  if emulator_healthy; then echo "state=running"; else echo "state=stopped"; fi
}

case "${1:-start}" in
  start)      start_emulator ;;
  stop|down)  stop_emulator ;;
  bootstrap)  bootstrap ;;
  seed)       seed ;;
  up)         start_emulator; bootstrap; seed ;;
  test)       start_emulator; bootstrap; seed; run_tests ;;
  reset)      reset_state ;;
  status)     status ;;
  env)        lane_env ;;
  capability) shift; start_emulator; bootstrap; capability "$@" ;;
  *)
    echo "usage: $0 {start|stop|bootstrap|seed|up|test|reset|status|env|capability}" >&2
    exit 2
    ;;
esac
