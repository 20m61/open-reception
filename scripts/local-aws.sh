#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export AWS_REGION="${AWS_REGION:-ap-northeast-1}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"

# 🔴 **資格情報は無条件に dummy へ置き換える（`:-` を使わない）。**
#
# かつては `${AWS_ACCESS_KEY_ID:-test}` と書いていたが、`:-` は「**未設定なら**」なので
# **AWS のデプロイ窓が開いているセッションでは実 STS 資格情報をそのまま引き継ぐ**。
# `AWS_SESSION_TOKEN` は unset すらしておらず、短命 STS の 3 点セットが揃ってこの
# レーンへ流れ込んでいた（2026-09-14 に実際にその状態のセッションで踏んだ）。
#
# #1103 の AC1 は「実 AWS 資格情報**なしに** LocalStack を起動できること」である。
# 送り先が localhost である限り実害は小さいが、**小さいことと保証があることは別**で、
# `AWS_ENDPOINT_URL` を取り違えた瞬間に実資格情報で実 AWS を叩く。ここで断つ。
#
# `AWS_PROFILE` も落とす ―― 残っていると SDK が `~/.aws/credentials` を解決してしまい、
# 「環境変数は dummy なのに実資格情報で動く」という最も読みにくい形になる。
# `tests/hooks/local-aws-credential-isolation.test.ts` が実際に bash を起動して縛る。
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
unset AWS_SESSION_TOKEN
unset AWS_PROFILE

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

# 🔴 **停止しているデーモンは「使えない」ではない（2026-09-14 に前提が覆った）。**
#
# ここは以前 `docker info` が失敗したら即 `exit 1` していた。Claude Code on the web の
# 既定セッションはまさにその状態なので、**「この環境では Docker が使えない」と結論しかけた**。
#
# 実際は違った。`dockerd` / `containerd` / `runc` は**最初から入っており**、セッションは
# root で動く。`dockerd` を起動すると **2 秒で上がり**、proxy 経由で Docker Hub から pull でき、
# コンテナも動いた。**動かないのではなく、起動していないだけ**だった。
#
# 観測（既定で動いていない）と、そこから引いた推論（だから有効にできない）を混ぜない。
# `CLAUDE.md`「調査の作法」の「見つからなかったは無いではない」と同型で、
# **停止しているは起動できないではない**。
DOCKERD_LOG="${DOCKERD_LOG:-/tmp/local-aws-dockerd.log}"
# 🔴 **`dockerd` の解決を変数にする。** テストから「不在」を確実に作れるようにするため。
# PATH へ偽物を前置しても、実環境の /usr/bin/dockerd が `command -v` に見つかってしまい、
# 不在の経路を踏めない（2026-09-14 の変異検証で、不在チェックを削る変異が生存した理由）。
DOCKERD_BIN="${DOCKERD_BIN:-dockerd}"
DOCKERD_WAIT_SECONDS="${DOCKERD_WAIT_SECONDS:-30}"

ensure_docker_daemon() {
  # 既に動いているなら何もしない（起動を試みるのは停止しているときだけ）。
  if docker info >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v "${DOCKERD_BIN}" >/dev/null 2>&1; then
    echo "[local-aws] Docker daemon is not running and dockerd is not installed." >&2
    echo "[local-aws] Install Docker, or run this lane where a daemon is reachable." >&2
    exit 1
  fi

  echo "[local-aws] Docker daemon is not running. Starting dockerd (log: ${DOCKERD_LOG})."
  nohup "${DOCKERD_BIN}" >"${DOCKERD_LOG}" 2>&1 &

  local i
  for ((i = 1; i <= DOCKERD_WAIT_SECONDS; i++)); do
    if docker info >/dev/null 2>&1; then
      echo "[local-aws] Docker daemon is up (${i}s)."
      return 0
    fi
    sleep 1
  done

  echo "[local-aws] dockerd did not become ready within ${DOCKERD_WAIT_SECONDS}s." >&2
  echo "[local-aws] See ${DOCKERD_LOG} for the daemon's own diagnosis." >&2
  exit 1
}

preflight() {
  require_cmd docker
  require_cmd lstk
  require_cmd npm
  ensure_docker_daemon
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

# 🔴 **`env` は preflight を通さない。**
#
# docker / lstk が無い環境（Claude Code on the web の既定がまさにそれ）でも、
# 「このレーンがどこを向き、どの資格情報で動くのか」は観測できなければならない。
# preflight を通すと最初の 1 行で落ちて**何も分からないまま**になる。
#
# 出力に秘密は無い ―― 資格情報は定数 `test` であり、それが本節の主張そのものである。
lane_env() {
  echo "AWS_REGION=${AWS_REGION}"
  echo "AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}"
  echo "AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}"
  echo "AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN-<unset>}"
  echo "AWS_PROFILE=${AWS_PROFILE-<unset>}"
  echo "AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL}"
  echo "DATA_BACKEND=${DATA_BACKEND}"
  echo "TABLE_NAME=${TABLE_NAME}"
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
  env) lane_env ;;
  preflight) preflight; echo "[local-aws] preflight OK" ;;
  down|stop) down ;;
  *)
    echo "usage: $0 {up|test|seed|reset|status|env|preflight|down}" >&2
    exit 2
    ;;
esac
