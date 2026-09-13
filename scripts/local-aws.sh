#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export AWS_REGION="${AWS_REGION:-ap-northeast-1}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_EC2_METADATA_DISABLED=true
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost.localstack.cloud:4566}"
export DATA_BACKEND=dynamodb
export TABLE_NAME="${TABLE_NAME:-open-reception-local}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[local-aws] missing command: $1" >&2
    exit 1
  }
}

preflight() {
  require_cmd docker
  require_cmd lstk
  require_cmd npm
  docker info >/dev/null 2>&1 || {
    echo "[local-aws] Docker daemon is not available." >&2
    exit 1
  }
}

start_localstack() {
  if lstk status >/dev/null 2>&1; then
    echo "[local-aws] LocalStack already running."
  else
    echo "[local-aws] Starting LocalStack..."
    if ! lstk --non-interactive start; then
      echo "[local-aws] start failed. In Claude Code Web, configure LOCALSTACK_AUTH_TOKEN as an environment secret." >&2
      exit 1
    fi
  fi
}

bootstrap_table() {
  if ! lstk aws dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
    echo "[local-aws] Creating DynamoDB table: $TABLE_NAME"
    lstk aws dynamodb create-table \
      --table-name "$TABLE_NAME" \
      --attribute-definitions \
        AttributeName=PK,AttributeType=S \
        AttributeName=SK,AttributeType=S \
        AttributeName=GSI1PK,AttributeType=S \
        AttributeName=GSI1SK,AttributeType=S \
      --key-schema \
        AttributeName=PK,KeyType=HASH \
        AttributeName=SK,KeyType=RANGE \
      --global-secondary-indexes \
        'IndexName=GSI1,KeySchema=[{AttributeName=GSI1PK,KeyType=HASH},{AttributeName=GSI1SK,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
      --billing-mode PAY_PER_REQUEST >/dev/null
    lstk aws dynamodb wait table-exists --table-name "$TABLE_NAME"
  fi

  local ttl_status
  ttl_status="$(lstk aws dynamodb describe-time-to-live \
    --table-name "$TABLE_NAME" \
    --query 'TimeToLiveDescription.TimeToLiveStatus' \
    --output text 2>/dev/null || true)"
  if [[ "$ttl_status" != "ENABLED" && "$ttl_status" != "ENABLING" ]]; then
    echo "[local-aws] Enabling DynamoDB TTL on ttl."
    lstk aws dynamodb update-time-to-live \
      --table-name "$TABLE_NAME" \
      --time-to-live-specification 'Enabled=true,AttributeName=ttl' >/dev/null
  fi
}

seed() {
  echo "[local-aws] Seeding deterministic reception demo data."
  npm run seed:dynamodb -- --with-mock
}

up() {
  preflight
  start_localstack
  bootstrap_table
  seed
  echo "[local-aws] ready: endpoint=$AWS_ENDPOINT_URL table=$TABLE_NAME"
}

smoke() {
  up
  npm run local:aws:smoke
}

reset() {
  preflight
  start_localstack
  echo "[local-aws] Resetting disposable AWS state."
  lstk --non-interactive reset --force
  bootstrap_table
  seed
  echo "[local-aws] reset complete."
}

status() {
  preflight
  lstk status
  echo "[local-aws] endpoint=$AWS_ENDPOINT_URL table=$TABLE_NAME"
}

down() {
  preflight
  lstk --non-interactive stop
}

case "${1:-up}" in
  up) up ;;
  test|smoke) smoke ;;
  seed)
    preflight
    start_localstack
    bootstrap_table
    seed
    ;;
  reset) reset ;;
  status) status ;;
  down|stop) down ;;
  *)
    echo "usage: $0 {up|test|seed|reset|status|down}" >&2
    exit 2
    ;;
esac
