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
# 🔴 **`--toolkit-stack-name` を明示する。** bootstrap は
# `--toolkit-stack-name CDKToolkit-orcloud01` で行った（既定の `CDKToolkit` ではない）。
# これを渡さずに `cdk deploy` すると、CDK の toolkit 参照（staging bucket 名の解決等）が
# 既定の `CDKToolkit` を探しにいき、`claude-deploy-role-restriction.json` の
# allowlist（`CDKToolkit-orcloud01` のみ）に無い名前なので Deny に当たる。
# これらの参照は try/catch で握りつぶされ致命的にはならない（レビューで確認済み）が、
# 握りつぶされた権限エラーに依存する状態を放置しない。渡せば
# `CDKToolkit-orcloud01` を正しく参照し、allowlist の当該エントリも実際に使われる。
TOOLKIT_STACK_NAME="CDKToolkit-${QUALIFIER}"
# 🔴 **Permissions Boundary をアプリ側にも適用する（層 4 / Critical 2）。**
# `cdk bootstrap --custom-permissions-boundary` が boundary を付けるのは cfn-exec role
# **1 つだけ**（`infra/node_modules/aws-cdk/lib/api/bootstrap/bootstrap-template.yaml:738-744`）。
# CDK アプリが作る `AWS::IAM::Role` には何も付かない。一方 `claude-cfn-exec.json` は
# boundary 無しの `iam:CreateRole` / `PutRolePolicy` / `AttachRolePolicy` を Deny するので、
# これを渡さないと**初回 CREATE で必ず AccessDenied になる**
# （`OpenReception-CfMon-dev` は `crossRegionReferences: true` の custom resource
# Lambda ＋ `AWS::IAM::Role` を含む CREATE）。
#
# 値は「ポリシー**名**」の素の文字列。CDK CLI は `-c key=value` の value を JSON へ
# パースせず生の文字列のまま渡すため、`-c @aws-cdk/core:permissionsBoundary={"name":...}`
# は**無言で no-op になる**（`Stack.permissionsBoundaryArn` が `context.name` を
# プロパティとして読むため）。`infra/bin/open-reception.ts` がこの名前を受け取り、
# CDK が内部で使うのと同じ `{ name }` 形へ変換して App の context に据える。
BOUNDARY_POLICY_NAME="OpenReceptionClaudeBoundary"
DEPLOY_ENV="${OR_DEPLOY_ENV:-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
# 🔴 **スタックごとにリージョンを持つ。** `OpenReception-CfMon-*` は
# cross-region 参照の都合で us-east-1 固定（`infra/bin/open-reception.ts`）。他の 2 つは
# 既定リージョン（ap-northeast-1）。`<name>:<region>` の形で 1 つの配列にまとめ、
# `${entry%%:*}` / `${entry##*:}` で分解する（Important D）。
STACKS=(
  "OpenReception-Web-${DEPLOY_ENV}:${REGION}"
  "OpenReception-WebMonitoring-${DEPLOY_ENV}:${REGION}"
  "OpenReception-CfMon-${DEPLOY_ENV}:us-east-1"
)
STACK_NAMES=()
for _entry in "${STACKS[@]}"; do
  STACK_NAMES+=("${_entry%%:*}")
done

usage() {
  echo "Usage: $0 <preflight|verify|diff|deploy|smoke> [--only <stack>[,<stack>...]]" >&2
  echo "  --only: 対象スタックを絞る。許可リストの部分集合のみ。" >&2
  echo "          新規の消費側スタックは生産側がデプロイされるまで gate できないため" >&2
  echo "          （cross-region の SSM export）、順序を運用者が決められるようにしてある。" >&2
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

# 🔴 **`--only` は許可リストの部分集合に限る（#680 / 2026-08-15）。**
#
# 新規の消費側スタック（cross-region の SSM export を読む側）は、生産側がデプロイ
# されるまで change set を作れない。3 スタックを一括で gate する作りだと、消費側の
# gate 失敗で生産側のデプロイにも到達しない ―― `OpenReception-CfMon-dev` の新規作成で
# 実際に踏んだ。「gate できないものを黙って通す」のではなく、**順序を運用者が決められる**
# ようにする。
#
# 任意の名前を渡せると層 1（スタック ARN allowlist）を引数で迂回できるので、
# 判定は `src/domain/governance/deploy-stack-selection.ts`（純関数）へ委ね、
# 許可リスト外は**拒否**する。
ONLY=""
if [ "${1:-}" = "--only" ]; then
  ONLY="${2:-}"
  shift 2 || true
fi
if [ -n "${ONLY}" ]; then
  if ! _selected="$(npx tsx "${ROOT}/scripts/aws-stack-selection.ts" "${ONLY}" "${STACK_NAMES[@]}")"; then
    echo "  ⛔ --only の指定が不正なため中止します（上の診断を参照）" >&2
    exit 2
  fi
  _filtered=()
  while IFS= read -r _name; do
    [ -z "${_name}" ] && continue
    for _entry in "${STACKS[@]}"; do
      [ "${_entry%%:*}" = "${_name}" ] && _filtered+=("${_entry}")
    done
  done <<< "${_selected}"
  if [ "${#_filtered[@]}" -eq 0 ]; then
    echo "  ⛔ --only の解決結果が空でした（判定不能なので止めます）" >&2
    exit 2
  fi
  STACKS=("${_filtered[@]}")
  STACK_NAMES=()
  for _entry in "${STACKS[@]}"; do
    STACK_NAMES+=("${_entry%%:*}")
  done
  echo "  ℹ 対象スタックを絞りました: ${STACK_NAMES[*]}"
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
  local identity account arn expiry remaining porcelain clean remote_refs pushed stamp neg

  # 🔴 **VITEST 実行中は絶対に AWS へ到達しない。** `tests/hooks/aws-cloud-deploy.test.ts` は
  # この wrapper を実際に起動して振る舞いを確認する（`tests/hooks/guard-destructive.test.ts`
  # と同じ方針）。テストは意図的に壊れた資格情報を渡しているが、クラウド box の
  # デプロイウィンドウ中に `npm test` が走った場合、周囲の環境変数には**本物の**資格情報が
  # 残っている可能性がある。「1 つの文字列アサーションだけがネットワークとの間に立つ」
  # 状態を避けるため、テストランタイムであること自体をここで検知して先に止める。
  if [ -n "${VITEST:-}" ]; then
    echo "VITEST 実行中のため collect_observation は AWS を呼びません（テストの安全装置）" >&2
    return 1
  fi

  # 🔴 **依存コマンドの有無を、AWS へ触れる前に確認する (#680)。** `aws` が cloud
  # sandbox に入っていないと、直後の `aws sts get-caller-identity` はシェルの
  # 「command not found」で失敗する。それをそのまま資格情報エラーとして扱うと
  # 「AWS 認証情報を解決できません」という**誤った層**を報告してしまう ―― 実際に
  # 2026-08 の初回試行でこれが起きた（`docs/cloud-dev-environment.md` §1）。
  # 判定ロジックは src/domain/governance/command-preflight.ts（純関数）に置き、
  # ここは `command -v` で存在を集めて渡すだけの I/O 層にとどめる。
  local cmd cmd_args=()
  for cmd in aws; do
    if command -v "${cmd}" >/dev/null 2>&1; then
      cmd_args+=("${cmd}=true")
    else
      cmd_args+=("${cmd}=false")
    fi
  done
  if ! npx tsx "${ROOT}/scripts/aws-command-preflight.ts" "${cmd_args[@]}"; then
    return 1
  fi

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
    # 🔴 **明示的な `process.exit(0)` を置かない。** stdout はコマンド置換
    # （パイプ）で捕捉されるため非同期で書き出される。`console.log` の直後に
    # `process.exit()` を呼ぶと、書き込みが完了する前にプロセスが終了して出力が
    # 欠ける可能性がある（Node の既知の落とし穴）。ここでは 1 行の三項演算子に
    # まとめ、node の自然終了に任せる。
    remaining="$(node -e '
      const ms = Date.parse(process.argv[1]);
      console.log(Number.isNaN(ms) ? "null" : Math.floor((ms - Date.now()) / 1000));
    ' "${expiry}")"
  else
    remaining="null"
  fi

  # 🔴 **workingTreeClean は fail-closed でなければならない。** `git status` 自体が
  # 失敗した場合（壊れた worktree・権限エラー等）、`[ -z "$(git status ...)" ]` は
  # 標準出力が空という理由で `clean=true` を返してしまう ―― 「判定できない」が
  # 「問題なし」に化ける（Important 2）。`git status` の終了コードを明示的に見る。
  if ! porcelain="$(git -C "${ROOT}" status --porcelain -uall)"; then
    echo "git status を実行できませんでした（判定不能）" >&2
    return 1
  fi
  if [ -z "${porcelain}" ]; then clean=true; else clean=false; fi

  # 🔴 **デプロイした commit が後から復元できること**（spec §5 の「branch / commit」行。
  # 従来この行は表にあるだけで実装が無かった ―― Minor 9）。
  # `workingTreeClean` は「ツリーとコミットが一致している」ことしか言わず、gate スタンプは
  # ツリーの**指紋**に紐づくのでコミットを特定しない。両方 green でも、ローカルにしか無い
  # commit をデプロイしたら、サンドボックスが消えた時点で dev に何が載っているか分からなくなる。
  #
  # **ネットワークへは出ない。** ローカルの remote-tracking ref だけで判定する
  # （`git fetch` は preflight に外部依存と新しい失敗モードを持ち込む）。ref が古い場合の
  # 誤りは「push 済みなのに未 push と言う」方向＝fail-closed で、対処は `git push` だけ。
  if ! remote_refs="$(git -C "${ROOT}" branch -r --contains HEAD --format='%(refname)')"; then
    echo "git branch -r --contains HEAD を実行できませんでした（判定不能）" >&2
    return 1
  fi
  if [ -n "${remote_refs}" ]; then pushed=true; else pushed=false; fi

  # 品質ゲートのスタンプ（既存の scripts/lib/gate-stamp.sh を使う）。
  # shellcheck source=lib/gate-stamp.sh
  . "${ROOT}/scripts/lib/gate-stamp.sh"
  # 🔴 **cwd を ROOT に固定してから呼ぶ。** `gate_stamp_satisfies` → `gate_tree_fingerprint`
  # は `git ls-files` をプロセスの cwd に対して実行する。他のすべての git 呼び出しは
  # `git -C "${ROOT}"` で明示しているのに、ここだけ暗黙の cwd に依存すると、
  # `infra/` などから起動されたときに `quality-gate.sh`（cd ROOT 後にスタンプを書く）
  # と指紋が食い違い、スタンプがあるのに偽の FAIL になる（Important 3。本リポジトリに
  # 同種の罠の既知インシデントあり）。
  if ( cd "${ROOT}" && gate_stamp_satisfies "pr" ); then stamp=true; else stamp=false; fi

  # --live-only: S 系（SimulatePrincipalPolicy）はここでは実行しない。
  # OpenReceptionClaudeDeploy-dev は iam:SimulatePrincipalPolicy を持たない前提であり、
  # S 系は人間が Admin 環境の runbook で別途実施する（Important 5b）。
  if npx tsx "${ROOT}/scripts/aws-negative-tests.ts" --live-only; then neg=true; else neg=false; fi

  cat > "${out}" <<EOF
{
  "callerArn": "${arn}",
  "accountId": "${account}",
  "region": "${REGION}",
  "qualifier": "${QUALIFIER}",
  "environment": "${DEPLOY_ENV}",
  "credentialSecondsRemaining": ${remaining},
  "workingTreeClean": ${clean},
  "headCommitPushed": ${pushed},
  "gateStampSatisfied": ${stamp},
  "negativeTestsPassed": ${neg}
}
EOF
  npx tsx "${ROOT}/scripts/aws-preflight.ts" "${out}" "${min_seconds}"
}

# 🔴 **diff と deploy で同じ change set 名を使う。ただし「gate が承認した change set が
# そのまま実行される」わけではない ―― CDK のソースで確認済み。**
#
# `infra/node_modules/aws-cdk/lib/index.js` の `createChangeSetAndCleanup()` は、
# 指定した名前の change set が既に存在すれば `cleanupOldChangeset()` →
# `cfn.deleteChangeSet()` で**無条件に削除してから**、`cfn.createChangeSet()` で
# 新しく作り直す（`options.exists` が true のときの分岐。CDK は「既存の named change
# set を再利用する」という API を公開していない）。つまり `deploy` の `cdk deploy
# --change-set-name X` は、`diff` が承認したのと同じ名前 `X` の change set を
# **必ず削除して作り直す**。gate が見た内容と実際に実行される内容は、
# ワーキングツリーが gate 通過後に一切変わっていなければ同一のはずだが、
# 「同じ change set オブジェクトを承認して実行している」という保証はどこにも無い。
#
# **それでも同じ名前を使う理由は別にある。** changeSet ARN は stack 名を埋め込まないため
# （`arn:...:changeSet/<name>/<id>`）、IAM 側は名前でしかスコープできない。
# `claude-deploy-entry.json` / `claude-deploy-role-restriction.json` はどちらも
# `changeSet/claude-gate-*/*` という名前パターンで Allow / NotResource を絞っている
# （Important A）。名前を固定していなければ、この IAM スコープ自体が機能しない。
# **「実行される change set を gate が承認したものに固定する」という保証は、この
# 仕組みには無い。**
changeset_name() {
  echo "claude-gate-$(git -C "${ROOT}" rev-parse --short HEAD)"
}

# 🔴 **デプロイに必須の CDK context を解決する（#680 / 2026-08-15 のインシデント）。**
#
# `appSecretsName` / `originVerifySecret` / `publicOriginOverride` は **未指定でも
# synth が通る**。通るが、出来上がるのは別構成のスタックで、Secrets Manager 連携も
# QR の基底オリジンも落ちる。2026-08-15 にこの wrapper がこれらを渡していなかったため、
# dev の ServerFn から `secretsmanager:GetSecretValue` の付与が消え、起動時に secret を
# 読めず fail-closed で中断して **dev が 500** になった。
#
# **diff gate では止められない。** `describe-change-set` は「どの property が変わったか」の
# 名前しか返さず、消えた IAM 文や環境変数を**値として見せない**ので、差分は
# 「26 件の変更」にしか見えなかった。防波堤はここに置く ―― 未指定なら始めさせない。
#
# 判定は `src/domain/governance/deploy-context.ts`（純関数）に持つ。ここは受け取るだけ。
#
# ⚠️ `originVerifySecret` は秘密の値そのものであり、`cdk` の argv に載る＝プロセステーブルに
# 見える。CDK context の仕組み上避けられない（`originVerifySecretName` へ移行するのが
# 本筋。#612）。**ログには出さない**。
DEPLOY_CONTEXT_ARGS=()
resolve_deploy_context() {
  local out
  if ! out="$(npx tsx "${ROOT}/scripts/aws-deploy-context.ts")"; then
    echo "  ⛔ 必須 context が揃っていないため中止します（上の診断を参照）" >&2
    return 1
  fi
  DEPLOY_CONTEXT_ARGS=()
  while IFS= read -r line; do
    [ -n "${line}" ] && DEPLOY_CONTEXT_ARGS+=("${line}")
  done <<< "${out}"
  if [ "${#DEPLOY_CONTEXT_ARGS[@]}" -eq 0 ]; then
    echo "  ⛔ context 解決の出力が空でした（判定不能なので止めます）" >&2
    return 1
  fi
}

# 第 3 引数は gate のモード（`diff` / `deploy`）。
# 🔴 **既定は `diff`**（＝ `OR_APPROVED_DIFF` による人間の承認を無視する）。
# 渡し忘れが「承認が効く」側へ倒れると、gate の停止が黙って無効化されうる。
run_diff_gate() {
  local stack="$1" region="$2" mode="${3:-diff}" cs_name cs_json
  cs_name="$(changeset_name)"
  cs_json="$(mktemp)"

  # cdk が change set を作る。--no-execute で実行しない。
  # スタックがまだ存在しない場合（初回デプロイ）、CDK は自動的に CREATE 型の change set を
  # 作る。全リソースが Add として現れるだけで、以降の判定ロジックは通常の diff と同じに
  # 扱われる（Important D の「初回デプロイの挙動」）。
  if ! ( cd "${ROOT}/infra" && npx cdk deploy "${stack}" \
      -c env="${DEPLOY_ENV}" \
      -c "@aws-cdk/core:bootstrapQualifier=${QUALIFIER}" \
      -c "claudeBoundary=${BOUNDARY_POLICY_NAME}" \
      "${DEPLOY_CONTEXT_ARGS[@]}" \
      --toolkit-stack-name "${TOOLKIT_STACK_NAME}" \
      --change-set-name "${cs_name}" --no-execute \
      --require-approval never ); then
    echo "  ⛔ ${stack}（${region}）の change set 作成（cdk deploy --no-execute）に失敗しました" >&2
    echo "     （直前の cdk 出力を参照。cdk 側のエラーメッセージがそのまま上に表示されているはずです）" >&2
    return 1
  fi

  # 🔴 **--region を明示する。** `OpenReception-CfMon-dev` は us-east-1
  # （`infra/bin/open-reception.ts`）だが、AWS CLI の既定リージョンは `${REGION}`
  # （通常 ap-northeast-1）。`--region` を渡さないと `describe-change-set` が
  # 誤ったリージョンへ飛び、「スタックが存在しない」という不可解な ValidationError で
  # `set -e` によりループごと落ちる（Important D）。
  if ! aws cloudformation describe-change-set \
      --stack-name "${stack}" --change-set-name "${cs_name}" --region "${region}" \
      --output json > "${cs_json}"; then
    echo "  ⛔ ${stack}（${region}）の change set を取得できませんでした（describe-change-set 失敗）" >&2
    echo "     （直前の aws 出力を参照。region 指定・change set 名・権限を確認してください）" >&2
    return 1
  fi

  # 🔴 **synth テンプレートも渡す (#680 R10)。**
  # `describe-change-set` は「どの property が変わったか」の名前しか返さず、値を返さない。
  # carve-out の名前空間に入るロール・Function URL・`Principal:"*"` の invoke 許可は
  # **値を見ないと判定できない**ので、`cdk deploy --no-execute` が書いた
  # `cdk.out/<stack>.template.json` を gate へ渡す。無ければ gate は非ゼロで終わる
  # （読めなかったを問題なしに落とさない）。
  npx tsx "${ROOT}/scripts/aws-diff-gate.ts" "${cs_json}" "${stack}" \
    "${ROOT}/infra/cdk.out/${stack}.template.json" "${mode}"
}

case "${SUB}" in
  preflight)
    collect_observation "$(mktemp)" 1200
    ;;
  verify)
    # 🔴 **`build:open-next` を `quality-gate.sh --pr` より先に走らせる (#680)。**
    # フレッシュな clone には `.open-next/` が無く、旧順序（gate → build）だと
    # `set -euo pipefail` の下で次のように必ずデッドロックする:
    #   1) `quality-gate.sh --pr` が「infra WebStack synth」等を検査できず
    #      SKIP を報告し、green スタンプを書かずに非ゼロで終わる（#640。検査できなかった
    #      ステップを green として記録しない設計そのもの）。
    #   2) `set -e` がここで `verify` を打ち切る。
    #   3) `.open-next/` を作る唯一の手段である `npm run build:open-next` が
    #      **一度も実行されない**。
    #   4) 次に `verify` を再実行しても `.open-next/` は相変わらず無いので 1) から
    #      繰り返す ―― 何回リトライしても green スタンプが書けない。
    # ゲートは「検査できないものを green にしない」設計なので、ゲートへの入力を
    # **作る**ステップは必ずゲートより前に置く。また、クラウドセッションへの委譲
    # プロンプトは元々 `build:open-next` → `quality-gate.sh` の順で書いてきており
    # （運用側が実際に踏んでいる手順）、この wrapper だけが逆順だった。
    ( cd "${ROOT}" && npm run build:open-next )
    "${ROOT}/scripts/quality-gate.sh" --pr
    ;;
  diff)
    # 🔴 **観測より先に context を解決する。** 揃っていないまま diff を回すと、
    # 別構成の synth と実スタックを比べた「差分」を人間へ見せることになる。
    resolve_deploy_context
    collect_observation "$(mktemp)" 1200
    # 🔴 **全スタックを評価してから終える。** かつてはここも `deploy` と同じ「裸の
    # 呼び出し」で、`run_diff_gate` が非ゼロを返した瞬間 `set -e` がループごと打ち切って
    # いた。`OpenReception-CfMon-dev`（us-east-1・初回 CREATE）のような
    # 3 番目のスタックは、1・2 番目のどちらかがブロックされると**一度も評価されない**。
    # 運用者は「1 つ直して再実行 → 次のブロックで初めて気づく」を人数ぶん繰り返す羽目になる。
    #
    # `if ! run_diff_gate; then …; fi` で呼ぶと、bash は `if` の条件式として評価される
    # コマンド（および関数内のすべてのコマンド）に対して `errexit` を適用しない
    # （bash(1) の `set -e` の項）。そのため `run_diff_gate` が失敗しても即座には
    # 終了せず、`diff_failed` に記録してから次のスタックへ進める。全スタックぶんの
    # findings を出し切ったあと、1 つでもブロックがあれば非ゼロで終える。
    #
    # `deploy` は**逆に**最初のブロックで即座に止める（下記、裸の呼び出しのまま）。
    # gate を通っていない変更を後続スタックへ適用させない安全弁であり、意図的な
    # 非対称性なので、ここを真似て `deploy` 側まで「全部見てから」に弱めない。
    diff_failed=0
    for entry in "${STACKS[@]}"; do
      if ! run_diff_gate "${entry%%:*}" "${entry##*:}" diff; then
        diff_failed=1
      fi
    done
    exit "${diff_failed}"
    ;;
  deploy)
    resolve_deploy_context
    collect_observation "$(mktemp)" 2400
    # diff と違い、ここは最初のブロックで即座に止める（unwrap しない。上のコメント参照）。
    for entry in "${STACKS[@]}"; do run_diff_gate "${entry%%:*}" "${entry##*:}" deploy; done
    cs_name="$(changeset_name)"
    # 🔴 **`--require-approval never` は「承認を捨てた」のではない（Important 6 / ADR 決定 5）。**
    # 直前の `run_diff_gate` ループが承認機構であり、CDK の対話プロンプトより**厳しい**。
    # CDK 側の既定（`broadening`）のままだと、TTY の無いクラウドサンドボックスでは
    # 権限が広がる差分に当たった瞬間 `TtyNotAttached` を投げる。しかも投げる前に
    # `cleanupChangeSet()` を呼んで **gate が見た change set を削除する**
    # （`infra/node_modules/aws-cdk/lib/index.js` の approval ブロックの catch）。
    # ADR 決定 4 は Lambda 権限変更のたびに IAM の Add/Modify が出ることを前提にしており、
    # つまり broadening は例外ではなく**通常運用**である。
    ( cd "${ROOT}/infra" && npx cdk deploy "${STACK_NAMES[@]}" \
        -c env="${DEPLOY_ENV}" \
        -c "@aws-cdk/core:bootstrapQualifier=${QUALIFIER}" \
        -c "claudeBoundary=${BOUNDARY_POLICY_NAME}" \
        "${DEPLOY_CONTEXT_ARGS[@]}" \
        --toolkit-stack-name "${TOOLKIT_STACK_NAME}" \
        --change-set-name "${cs_name}" \
        --require-approval never )
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
