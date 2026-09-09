#!/usr/bin/env bash
# =============================================================================
# 管理者 Cognito ユーザーを対話で用意する（#1051）。
#
#   bash scripts/admin-user-provision.sh [--user-pool-id <id>] [--region <region>]
#                                        [--group <name>] [--username <name>]
#
# メールアドレスとパスワードを**対話で聞き取り**、Cognito のユーザーを作る／既存なら整える。
# 何度流しても同じ状態になる（冪等）。
#
# 🔴 **クラウドセッションからは実行できない。** `claude-deploy-entry.json` の
# `DenyEverythingElseOutsideTheChain` が、デプロイ用の資格情報に
# `sts:AssumeRole` / `sts:GetCallerIdentity` / `cloudformation:Describe{Stacks,ChangeSet}` の
# 4 つ以外を明示的に Deny している。Cognito は読み取りすら通らない（設計どおり。
# CLAUDE.md の停止境界「Cognito・認可の境界変更」の機械強制）。
# **これは Admin 資格情報を持つ人が手元で流すスクリプトである。**
#
# 判定ロジックはここに書かない（bash はテストしづらい）。観測を集めて
# scripts/admin-user-credentials.ts → src/domain/auth/admin-user-provisioning.ts へ渡す。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

USER_POOL_ID="${OR_ADMIN_USER_POOL_ID:-}"
REGION="${AWS_REGION:-ap-northeast-1}"
GROUP_NAME="Admin"
USERNAME=""

usage() {
  cat >&2 <<'EOS'
Usage: bash scripts/admin-user-provision.sh [options]
  --user-pool-id <id>  Admin User Pool ID（既定: $OR_ADMIN_USER_POOL_ID、無ければ対話で聞く）
  --region <region>    既定: $AWS_REGION or ap-northeast-1
  --group <name>       付与するグループ（既定: Admin。SiteManager / Viewer も可）
  --username <name>    username を明示する（既定: メールアドレスから導出）
EOS
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user-pool-id) USER_POOL_ID="${2:-}"; shift 2 ;;
    --region)       REGION="${2:-}"; shift 2 ;;
    --group)        GROUP_NAME="${2:-}"; shift 2 ;;
    --username)     USERNAME="${2:-}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

command -v aws >/dev/null || { echo "aws CLI がありません" >&2; exit 2; }

# --- 聞き取り -----------------------------------------------------------------

if [[ -z "${USER_POOL_ID}" ]]; then
  # スタック出力から拾えるなら候補として見せる（describe-stacks は Admin なら通る）。
  suggested="$(aws cloudformation describe-stacks \
      --stack-name "OpenReception-Web-${OR_DEPLOY_ENV:-dev}" --region "${REGION}" \
      --query "Stacks[0].Outputs[?OutputKey=='AdminUserPoolId'].OutputValue|[0]" \
      --output text 2>/dev/null || true)"
  if [[ -n "${suggested}" && "${suggested}" != "None" ]]; then
    read -r -p "Admin User Pool ID [${suggested}]: " USER_POOL_ID
    USER_POOL_ID="${USER_POOL_ID:-${suggested}}"
  else
    read -r -p "Admin User Pool ID: " USER_POOL_ID
  fi
fi
[[ -n "${USER_POOL_ID}" ]] || { echo "User Pool ID が空です" >&2; exit 2; }

read -r -p "メールアドレス: " EMAIL
[[ -n "${EMAIL}" ]] || { echo "メールアドレスが空です" >&2; exit 2; }

if [[ -z "${USERNAME}" ]]; then
  # 🔴 username をメール形式にできない（プールが email をエイリアスに使うため）。
  #    導出は純関数側に置いてあり、出力が必ず妥当であることをテストで縛ってある。
  derived="$(EMAIL="${EMAIL}" npx --yes tsx -e '
    import { deriveUsernameFromEmail } from "./src/domain/auth/admin-user-provisioning";
    process.stdout.write(deriveUsernameFromEmail(process.env.EMAIL ?? ""));
  ')"
  read -r -p "username（メール形式は不可）[${derived}]: " USERNAME
  USERNAME="${USERNAME:-${derived}}"
fi

# 🔴 パスワードはエコーせず、2 回聞いて一致を確かめる。
read -r -s -p "パスワード: " PASSWORD; echo
read -r -s -p "パスワード（確認）: " PASSWORD_CONFIRM; echo
if [[ "${PASSWORD}" != "${PASSWORD_CONFIRM}" ]]; then
  echo "パスワードが一致しません" >&2
  exit 1
fi
unset PASSWORD_CONFIRM

# --- 検査（純関数側）＋ payload 生成 ------------------------------------------
# パスワードは argv にもディスクにも出さない。stdin で渡し、stdout の payload を
# そのまま aws へパイプする。
SET_PASSWORD_PAYLOAD="$(
  USERNAME="${USERNAME}" EMAIL="${EMAIL}" PASSWORD="${PASSWORD}" USER_POOL_ID="${USER_POOL_ID}" \
  node -e '
    process.stdout.write(JSON.stringify({
      username: process.env.USERNAME,
      email: process.env.EMAIL,
      password: process.env.PASSWORD,
      userPoolId: process.env.USER_POOL_ID,
    }));
  ' | npx --yes tsx "${ROOT}/scripts/admin-user-credentials.ts"
)"

echo
echo "▶ 対象: pool=${USER_POOL_ID} region=${REGION} username=${USERNAME} email=${EMAIL} group=${GROUP_NAME}"

# --- グループ -----------------------------------------------------------------
if aws cognito-idp get-group --user-pool-id "${USER_POOL_ID}" --region "${REGION}" \
     --group-name "${GROUP_NAME}" >/dev/null 2>&1; then
  echo "  グループ ${GROUP_NAME}: 既にある"
else
  aws cognito-idp create-group --user-pool-id "${USER_POOL_ID}" --region "${REGION}" \
    --group-name "${GROUP_NAME}" >/dev/null
  echo "  グループ ${GROUP_NAME}: 作成した"
fi

# --- ユーザー（作成 or 属性更新） ----------------------------------------------
if aws cognito-idp admin-get-user --user-pool-id "${USER_POOL_ID}" --region "${REGION}" \
     --username "${USERNAME}" >/dev/null 2>&1; then
  aws cognito-idp admin-update-user-attributes \
    --user-pool-id "${USER_POOL_ID}" --region "${REGION}" --username "${USERNAME}" \
    --user-attributes "Name=email,Value=${EMAIL}" 'Name=email_verified,Value=true' >/dev/null
  echo "  ユーザー ${USERNAME}: 既にあるので email 属性を更新した"
else
  aws cognito-idp admin-create-user \
    --user-pool-id "${USER_POOL_ID}" --region "${REGION}" --username "${USERNAME}" \
    --user-attributes "Name=email,Value=${EMAIL}" 'Name=email_verified,Value=true' \
    --message-action SUPPRESS >/dev/null
  echo "  ユーザー ${USERNAME}: 作成した"
fi

# --- パスワード（argv に載せない） ---------------------------------------------
printf '%s' "${SET_PASSWORD_PAYLOAD}" \
  | aws cognito-idp admin-set-user-password --region "${REGION}" \
      --cli-input-json file:///dev/stdin >/dev/null
unset PASSWORD SET_PASSWORD_PAYLOAD
echo "  パスワード: 恒久パスワードとして設定した（FORCE_CHANGE_PASSWORD も解消）"

# --- グループ付与 ---------------------------------------------------------------
aws cognito-idp admin-add-user-to-group --user-pool-id "${USER_POOL_ID}" --region "${REGION}" \
  --username "${USERNAME}" --group-name "${GROUP_NAME}" >/dev/null
echo "  グループ付与: ${GROUP_NAME}"

# --- 検証（散文で「できたはず」と言わない） --------------------------------------
echo
echo "▶ 検証"
status="$(aws cognito-idp admin-get-user --user-pool-id "${USER_POOL_ID}" --region "${REGION}" \
  --username "${USERNAME}" --query 'UserStatus' --output text)"
verified="$(aws cognito-idp admin-get-user --user-pool-id "${USER_POOL_ID}" --region "${REGION}" \
  --username "${USERNAME}" \
  --query "UserAttributes[?Name=='email_verified'].Value|[0]" --output text)"
groups="$(aws cognito-idp admin-list-groups-for-user --user-pool-id "${USER_POOL_ID}" \
  --region "${REGION}" --username "${USERNAME}" --query 'Groups[].GroupName' --output text)"

echo "  UserStatus:     ${status}"
echo "  email_verified: ${verified}"
echo "  groups:         ${groups}"

fail=0
[[ "${status}" == "CONFIRMED" ]] || { echo "  ❌ UserStatus が CONFIRMED ではありません" >&2; fail=1; }
[[ "${verified}" == "true" ]] || { echo "  ❌ email_verified が true ではありません（メールでログインできません）" >&2; fail=1; }
# 🔴 グループが無いと Cognito 認証は通るのに管理 API が全部 401 になる
#    （dev の OPEN_RECEPTION_ENTRA_UNREGISTERED=env_roles は roles claim＝グループから Actor を作る）。
case " ${groups} " in *" ${GROUP_NAME} "*) ;; *) echo "  ❌ ${GROUP_NAME} グループに入っていません" >&2; fail=1 ;; esac

if [[ "${fail}" -ne 0 ]]; then
  echo "❌ 未完了の項目があります" >&2
  exit 1
fi

echo
echo "✅ 完了。${EMAIL} または ${USERNAME} でログインできます。"
