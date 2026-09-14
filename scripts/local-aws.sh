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
# 🔴 **失効時刻も落とす（2026-09-14 に踏んだ）。**
#
# AWS CLI / SDK は `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` +
# `AWS_CREDENTIAL_EXPIRATION` が揃うと「**期限付きの静的資格情報**」として解釈する。
# デプロイ窓を開いたセッションではこの 3 つ目が環境に残るので、窓が閉じたあとは
# **dummy の `test` に他人の失効時刻が貼り付いて**、レーンの全コマンドが
# `Credentials were refreshed, but the refreshed credentials are still expired.`
# で拒否される。値ではなく**存在**が効くので、上の 2 行だけでは隔離にならない。
unset AWS_CREDENTIAL_EXPIRATION

export AWS_EC2_METADATA_DISABLED=true
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost.localstack.cloud:4566}"
export DATA_BACKEND=dynamodb
export TABLE_NAME="${TABLE_NAME:-open-reception-local}"

# 🔴 **コンテナを誰が起こすか（2026-09-14 に実測して分かれた）。**
#
#   lstk … `lstk start` がコンテナを管理する。ローカル開発機の既定。
#   self … このスクリプトが `docker run` で起こし、lstk へは `--endpoint-url` で繋ぐ。
#   auto … 環境から判定する（既定）。
#
# self が要るのは **TLS を終端する loopback proxy 越しの環境**（Claude Code on the web）である。
# LocalStack コンテナは起動時に `https://api.localstack.cloud/v1` でライセンスを
# 有効化するが、
#
#   - proxy は **127.0.0.1 にしか bind していない**（実測: /proc/net/tcp）。
#     bridge ネットワークのコンテナからは届かない
#   - proxy は TLS を貼り替えるので、コンテナは **CA を信頼していない**と検証に失敗する
#
# `lstk` の config は `image` / `env` / `volumes` は持つが **`network` を持たない**ので、
# lstk 管理のままでは host ネットワークにできない。`--network host` + CA の持ち込みで
# 実際に有効化が通ることは実測済み（`freemium` として activate し `Ready` まで到達）。
#
# community イメージなら無ライセンスで済む、とはならない: `lstk` は
# `LOCALSTACK_AUTH_TOKEN` をコンテナへ転送するため、community イメージでも
# pro の有効化を試みて exit 55 で落ちる（これも実測）。
LOCAL_AWS_CONTAINER_MODE="${LOCAL_AWS_CONTAINER_MODE:-auto}"
LOCAL_AWS_CONTAINER_NAME="${LOCAL_AWS_CONTAINER_NAME:-open-reception-localstack}"
LOCAL_AWS_IMAGE="${LOCAL_AWS_IMAGE:-localstack/localstack-pro:latest}"
LOCAL_AWS_CA_BUNDLE="${LOCAL_AWS_CA_BUNDLE:-/root/.ccr/ca-bundle.crt}"
LOCAL_AWS_READY_SECONDS="${LOCAL_AWS_READY_SECONDS:-180}"
# 自前管理のときに lstk / curl が叩く実アドレス。`localhost.localstack.cloud` は
# NO_PROXY に載っていないことがあるので、ここは素の loopback を使う。
LOCAL_AWS_INTERNAL_ENDPOINT="${LOCAL_AWS_INTERNAL_ENDPOINT:-http://127.0.0.1:4566}"

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

# proxy が loopback にしか居ないか（= コンテナから届かないか）。
proxy_is_loopback_only() {
  case "${HTTPS_PROXY:-${https_proxy:-}}" in
    *://127.0.0.1:* | *://localhost:*) return 0 ;;
    *) return 1 ;;
  esac
}

container_mode() {
  case "$LOCAL_AWS_CONTAINER_MODE" in
    lstk | self) echo "$LOCAL_AWS_CONTAINER_MODE" ;;
    auto) if proxy_is_loopback_only; then echo self; else echo lstk; fi ;;
    *)
      echo "[local-aws] unknown LOCAL_AWS_CONTAINER_MODE: $LOCAL_AWS_CONTAINER_MODE" >&2
      exit 2
      ;;
  esac
}

# 🔴 **lstk のライフサイクル命令へ `AWS_ENDPOINT_URL` を見せない。**
#
# `lstk start` は「自分が管理するコンテナ」を相手にするので、外部エンドポイントの指定が
# あると **実行を拒否する**:
#
#   Error: start does not support AWS_ENDPOINT_URL: it operates on a local Docker
#   container or local filesystem state with no remote equivalent
#
# レーンは（アプリと AWS CLI のために）この変数を export するので、素で呼ぶと
# `npm run local:aws:up` は**既定設定のまま 1 度も成功しない**。2026-09-14 まで実際に
# その状態だった。`tests/hooks/local-aws-lstk-lifecycle.test.ts` が縛る。
lstk_lifecycle() {
  env -u AWS_ENDPOINT_URL lstk --non-interactive "$@"
}

# 自前管理のコンテナは「外部エミュレータ」として明示的に指す。
lstk_emulator() {
  if [ "$(container_mode)" = "self" ]; then
    env -u AWS_ENDPOINT_URL lstk --non-interactive \
      --endpoint-url "$LOCAL_AWS_INTERNAL_ENDPOINT" "$@"
  else
    lstk_lifecycle "$@"
  fi
}

# 🔴 **`lstk aws` の案内行は stdout に出る。**
#
#   > Note: No AWS profile found, run 'lstk setup aws'
#
# `--query ... --output text` の捕捉にそのまま使うと `"> Note: ...\nENABLED"` になり、
# 値との比較が**必ず外れる**。2026-09-14、これで `up` が冪等でなくなり、2 回目が
# `TimeToLive is already enabled` で落ちた。案内行を落としてから値だけを取る。
lstk_aws_value() {
  lstk_emulator aws "$@" 2>/dev/null | grep -v '^>' | awk 'NF' | tail -n 1
}

emulator_healthy() {
  curl -fsS --noproxy '*' --max-time 3 \
    "${LOCAL_AWS_INTERNAL_ENDPOINT}/_localstack/health" >/dev/null 2>&1
}

self_container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$LOCAL_AWS_CONTAINER_NAME" 2>/dev/null)" = "true" ]
}

# TLS 終端 proxy 越しの環境向けに、host ネットワーク＋CA 持ち込みで起こす。
self_start() {
  if self_container_running && emulator_healthy; then
    echo "[local-aws] LocalStack already running (self-managed)."
    return 0
  fi
  docker rm -f "$LOCAL_AWS_CONTAINER_NAME" >/dev/null 2>&1 || true

  local args=(run -d --name "$LOCAL_AWS_CONTAINER_NAME" --network host)
  args+=(-e LOCALSTACK_AUTH_TOKEN)
  if [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ]; then
    args+=(-e "HTTPS_PROXY=${HTTPS_PROXY:-${https_proxy:-}}")
    args+=(-e "https_proxy=${HTTPS_PROXY:-${https_proxy:-}}")
  fi
  if [ -n "${NO_PROXY:-${no_proxy:-}}" ]; then
    args+=(-e "NO_PROXY=${NO_PROXY:-${no_proxy:-}}")
    args+=(-e "no_proxy=${NO_PROXY:-${no_proxy:-}}")
  fi
  # CA を持ち込めるときだけ持ち込む（proxy が TLS を貼り替えない環境では不要）。
  if [ -f "$LOCAL_AWS_CA_BUNDLE" ]; then
    args+=(-v "${LOCAL_AWS_CA_BUNDLE}:/etc/local-aws-ca.crt:ro")
    args+=(-e REQUESTS_CA_BUNDLE=/etc/local-aws-ca.crt)
    args+=(-e SSL_CERT_FILE=/etc/local-aws-ca.crt)
    args+=(-e CURL_CA_BUNDLE=/etc/local-aws-ca.crt)
  fi
  # Lambda は sibling コンテナで走るので socket が要る（無いと "Docker not available"）。
  if [ -S /var/run/docker.sock ]; then
    args+=(-v /var/run/docker.sock:/var/run/docker.sock)
  fi
  args+=("$LOCAL_AWS_IMAGE")

  echo "[local-aws] Starting LocalStack (self-managed, host network)."
  docker "${args[@]}" >/dev/null

  local i
  for ((i = 1; i <= LOCAL_AWS_READY_SECONDS; i++)); do
    if emulator_healthy; then
      echo "[local-aws] LocalStack is ready (${i}s)."
      return 0
    fi
    if ! self_container_running; then
      echo "[local-aws] LocalStack container exited during startup." >&2
      docker logs --tail 40 "$LOCAL_AWS_CONTAINER_NAME" >&2 2>&1 || true
      exit 1
    fi
    sleep 1
  done

  echo "[local-aws] LocalStack did not become ready within ${LOCAL_AWS_READY_SECONDS}s." >&2
  docker logs --tail 40 "$LOCAL_AWS_CONTAINER_NAME" >&2 2>&1 || true
  exit 1
}

preflight() {
  require_cmd docker
  require_cmd lstk
  require_cmd npm
  ensure_docker_daemon
}

start_localstack() {
  if [ "$(container_mode)" = "self" ]; then
    self_start
    return 0
  fi

  if lstk_lifecycle status >/dev/null 2>&1; then
    echo "[local-aws] LocalStack already running."
  else
    echo "[local-aws] Starting LocalStack..."
    if ! lstk_lifecycle start; then
      # 🔴 原因をトークンだと言い切らない。2026-09-14 まではここが
      # 「LOCALSTACK_AUTH_TOKEN を設定せよ」とだけ言っており、実際の原因
      # （AWS_ENDPOINT_URL / ライセンスサーバへ届かない）を**隠していた**。
      echo "[local-aws] start failed. Check, in this order:" >&2
      echo "[local-aws]   1. LOCALSTACK_AUTH_TOKEN is set (Claude Code Web: environment secret)" >&2
      echo "[local-aws]   2. the container can reach https://api.localstack.cloud/v1" >&2
      echo "[local-aws]      (behind a TLS-terminating loopback proxy it cannot --" >&2
      echo "[local-aws]       use LOCAL_AWS_CONTAINER_MODE=self)" >&2
      exit 1
    fi
  fi
}

bootstrap_table() {
  if ! lstk_emulator aws dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
    echo "[local-aws] Creating DynamoDB table: $TABLE_NAME"
    lstk_emulator aws dynamodb create-table \
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
    lstk_emulator aws dynamodb wait table-exists --table-name "$TABLE_NAME"
  fi

  local ttl_status
  ttl_status="$(lstk_aws_value dynamodb describe-time-to-live \
    --table-name "$TABLE_NAME" \
    --query 'TimeToLiveDescription.TimeToLiveStatus' \
    --output text || true)"
  if [[ "$ttl_status" != "ENABLED" && "$ttl_status" != "ENABLING" ]]; then
    echo "[local-aws] Enabling DynamoDB TTL on ttl."
    lstk_emulator aws dynamodb update-time-to-live \
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
  # 本番 DynamoDB バックエンドを実 LocalStack に対して通す統合テスト（#1103 条件 4）。
  # 既定の品質ゲートでは skip される（フラグはここでだけ立てる）。
  LOCAL_AWS_INTEGRATION=1 npm run local:aws:integration
}

reset() {
  preflight
  echo "[local-aws] Resetting disposable AWS state."
  if [ "$(container_mode)" = "self" ]; then
    # 🔴 **自前管理の reset は作り直しで行う。**
    #
    # `lstk reset` は LocalStack の state-reset エンドポイントを叩くが、freemium の
    # 有効化では **404** が返る（2026-09-14 実測）。使えないと分かっている経路を
    # 叩いて失敗するより、確実に同じ結果になる方法を採る ―― コンテナを捨てて
    # 作り直せば、状態は必ず空から始まる。
    docker rm -f "$LOCAL_AWS_CONTAINER_NAME" >/dev/null 2>&1 || true
    self_start
  else
    start_localstack
    lstk_emulator reset --force
  fi
  bootstrap_table
  seed
  echo "[local-aws] reset complete."
}

status() {
  preflight
  lstk_emulator status
  echo "[local-aws] endpoint=$AWS_ENDPOINT_URL table=$TABLE_NAME"
}

down() {
  preflight
  if [ "$(container_mode)" = "self" ]; then
    docker rm -f "$LOCAL_AWS_CONTAINER_NAME" >/dev/null 2>&1 || true
    echo "[local-aws] LocalStack stopped (self-managed)."
    return 0
  fi
  lstk_lifecycle stop
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
  # 観測できないものは縛れない。隔離の 4 つ目としてここに出す。
  echo "AWS_CREDENTIAL_EXPIRATION=${AWS_CREDENTIAL_EXPIRATION-<unset>}"
  echo "AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL}"
  echo "DATA_BACKEND=${DATA_BACKEND}"
  echo "TABLE_NAME=${TABLE_NAME}"
  echo "CONTAINER_MODE=$(container_mode)"
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
