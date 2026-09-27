# Runbook: sparse deploy ledger の有効化（#1153 / #1179）

**実行するのは owner（Mac の端末、人間の IAM 権限）だけ。** Claude のセッションは
IAM・CloudFormation・DynamoDB に一切書き込まない。この runbook の各手順は Human Gate である。

- 設計の正本: `docs/architecture/aws-dev-deploy-broker.md` の「Sparse deploy attempt ledger (#1153)」
- 実装: `infra/broker/sparse-ledger.mjs`、`infra/lib/stacks/dev-deploy-broker-stack.ts`、
  `scripts/aws-policies/claude-boundary*.json` / `claude-cfn-exec*.json`
- 状態: ledger は **実装済み・未配線**。broker は `BROKER_NOT_ARMED` のままで、この runbook を
  すべて実行しても mutation は起きない。genesis と override（手順 5・6）は arming の作業に属する。

## 全体の順序

| # | 手順 | いつ | 可逆性 |
|---|---|---|---|
| 1 | 2 つの role を決める | いつでも | — |
| 2 | override issuer role を作る | broker stack の deploy 前 | role を消せば戻る |
| 3 | boundary / cfn-exec policy の新しい版を適用する | broker stack の deploy 前 | 前の版を default に戻せば戻る |
| 4 | broker stack を 2 つの parameter 付きで deploy する | 1〜3 の後 | table は `RETAIN`・削除保護（下記） |
| 5 | genesis を書く | **arming 時**（配線 PR の merge 後） | create-only。書き直せない |
| 6 | override を発行する（必要な日だけ） | arming 後、3 回目以降の attempt が要る日 | create-only |

## 1. 2 つの role を決める

| parameter | 何の role か | 条件 |
|---|---|---|
| `SparseLedgerOverrideIssuerRoleArn` | 人間が override と genesis を書くための role | 人間だけが引き受けられる。Claude・candidate・workload の role ではない |
| `SparseLedgerStackDeployRoleArn` | 人間が broker stack を deploy するときの CloudFormation 実行 role | 同上 |

どちらも stack の `HUMAN_ROLE_ARN_PATTERN` で、role 名（path の後ろ）が次で**始まるものは拒否される**:
`cdk-orcloud01-`、`OpenReception`、`nodi-`、`salon-loop-`、`Kiaff`。
**名前はこれらの外にする**（例: `ledger-override-issuer-human`、`ledger-stack-deploy-human`）。

🔴 誤った role を渡すと、table の resource policy が stack 自身の create / update（PITR の有効化など）を
止めることがある。復旧は手順 4 の「Rollback」を参照。

## 2. override issuer role を作る

- trust policy: owner の人間 principal（SSO の permission set、または MFA 必須の IAM user）だけ。
  `cdk-*` / `OpenReception*` / Claude の entry role は含めない。
- 権限: ledger table への `dynamodb:PutItem`（override と genesis）と `dynamodb:GetItem` だけ。
  table 名は CloudFormation が付ける（`OpenReception-DevDeployBroker-...`）ので、
  手順 4 の後で ARN を絞った inline policy にする。それまでは permission を付けない。
- 確認:

  ```bash
  aws iam get-role --role-name ledger-override-issuer-human --query 'Role.AssumeRolePolicyDocument'
  ```

## 3. boundary / cfn-exec policy の新しい版を適用する

#1179 で、`claude-boundary*.json` と `claude-cfn-exec*.json` の既存の Deny に、ledger table
（`dynamodb:*` on `table/OpenReception-DevDeployBroker-*`）と broker stack
（`cloudformation:*` on `OpenReception-DevDeployBroker`）を足した。**締める方向の変更**で、
Claude の deploy chain とその下の workload role が ledger を書いたり消したりできなくなる。

事前確認（文字数の上限 6,144。`claude-boundary-migration.json` は残り 2 文字）:

```bash
for f in claude-boundary claude-boundary-migration claude-cfn-exec claude-cfn-exec-migration; do
  node -e "const n=JSON.stringify(JSON.parse(require('fs').readFileSync('scripts/aws-policies/$f.json','utf8'))).length;console.log('$f',n,'/ 6144')"
done
aws iam list-policy-versions --policy-arn arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary --query 'length(Versions)'
aws iam list-policy-versions --policy-arn arn:aws:iam::822063948773:policy/OpenReceptionClaudeCfnExec-dev --query 'length(Versions)'
# 5 なら、default でない最古の版を delete-policy-version で消してから進む
```

適用（**通常の版**。migration 版ではない。**2 本とも**）:

```bash
aws iam create-policy-version \
  --policy-arn arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary \
  --policy-document file://scripts/aws-policies/claude-boundary.json --set-as-default
aws iam create-policy-version \
  --policy-arn arn:aws:iam::822063948773:policy/OpenReceptionClaudeCfnExec-dev \
  --policy-document file://scripts/aws-policies/claude-cfn-exec.json --set-as-default
```

確認（どちらも `explicitDeny` であること）:

```bash
EXEC=arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1
aws iam simulate-principal-policy --policy-source-arn "$EXEC" \
  --action-names dynamodb:PutItem \
  --resource-arns "arn:aws:dynamodb:ap-northeast-1:822063948773:table/OpenReception-DevDeployBroker-SparseLedgerX" \
  --query 'EvaluationResults[0].EvalDecision' --output text     # explicitDeny
aws iam simulate-principal-policy --policy-source-arn "$EXEC" \
  --action-names cloudformation:UpdateStack \
  --resource-arns "arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-DevDeployBroker/x" \
  --query 'EvaluationResults[0].EvalDecision' --output text     # explicitDeny
```

加えて、通常の dev deploy の経路が壊れていないことを確かめる（`scripts/aws-cloud-deploy.sh preflight`
が green）。

**Rollback**: 直前の版を default に戻す。

```bash
aws iam list-policy-versions --policy-arn <ARN> --query 'Versions[*].[VersionId,IsDefaultVersion,CreateDate]' --output table
aws iam set-default-policy-version --policy-arn <ARN> --version-id <直前の版>
```

## 4. broker stack を deploy する（ledger table を作る）

broker stack は人間が管理する control plane であり、Claude の deploy chain では deploy しない
（手順 3 で Claude の chain からは Deny される）。owner の人間 credential で、手順 1 の
stack deploy role を CloudFormation 実行 role として使う。

```bash
cd infra
npx cdk diff  --app "npx ts-node --prefer-ts-exts bin/dev-deploy-broker.ts" OpenReception-DevDeployBroker \
  --role-arn <SparseLedgerStackDeployRoleArn> \
  --parameters SparseLedgerOverrideIssuerRoleArn=<issuer role ARN> \
  --parameters SparseLedgerStackDeployRoleArn=<stack deploy role ARN> \
  --parameters GitHubConnectionArn=<既存の値> --parameters DevAppSecretsName=open-reception/dev/app-v2 \
  --parameters DevPublicOriginOverride=<既存の値> --parameters DevProviderSecretBackend=secrets-manager
# diff を確認してから、同じ引数で deploy
npx cdk deploy --app "npx ts-node --prefer-ts-exts bin/dev-deploy-broker.ts" OpenReception-DevDeployBroker ...（同じ引数）
```

`diff` で確認すること:

- 追加されるのは DynamoDB table（PAY_PER_REQUEST、PITR、削除保護、`RETAIN`、stream なし）、
  その resource policy、broker role への `GetItem` / `PutItem` / `UpdateItem`（`dynamodb:LeadingKeys` =
  `PROJECT#open-reception`）だけ。
- Validation role に table への権限が**無い**。
- broker の buildspec は変わらない（ledger は未配線。`BROKER_NOT_ARMED` のまま）。

確認:

```bash
TABLE=$(aws cloudformation describe-stack-resources --stack-name OpenReception-DevDeployBroker \
  --query "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId" --output text)
aws dynamodb describe-table --table-name "$TABLE" \
  --query 'Table.{Billing:BillingModeSummary.BillingMode,DeletionProtection:DeletionProtectionEnabled,Stream:StreamSpecification}'
aws dynamodb describe-continuous-backups --table-name "$TABLE" \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus'   # ENABLED
aws dynamodb get-resource-policy --resource-arn "$(aws dynamodb describe-table --table-name "$TABLE" --query Table.TableArn --output text)" \
  --query Policy --output text | jq '.Statement[] | {Sid, Effect}'
```

その後、手順 2 の issuer role に、この table の ARN に限った `dynamodb:PutItem` / `dynamodb:GetItem`
の inline policy を付ける。

**Rollback**:

- stack の update が失敗して戻れない、または誤った role を渡して resource policy が stack 自身を
  止めた場合: **account の root user** は table の `DeleteResourcePolicy` を常に呼べる
  （DynamoDB は自分を締め出せないようにこの経路を残している）。resource policy を消し、
  正しい parameter で再 deploy する。resource policy は drift 検出されない。
- table は `RETAIN` と削除保護付き。stack を消しても table は残る。

## 5. genesis を書く（arming 時。今はまだ実行しない）

ledger の配線 PR（broker の buildspec から `reserveAttempt` を呼び、module を stack asset として
SHA-256 で pin する変更）が merge され、broker の設定に **ledger id** が pin された後に 1 回だけ行う。
genesis の `ledgerId` はその pin と同じ値にする。genesis は create-only で、2 回目は失敗する。

issuer role を引き受けたうえで、repo の実装（`buildGenesisPut`）を使って書く:

```bash
cd infra
TABLE=<手順 4 の table 名> LEDGER_ID=<broker に pin した ledger id> node --input-type=module -e "
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { buildGenesisPut } from './broker/sparse-ledger.mjs';
const put = buildGenesisPut({ table: process.env.TABLE, ledgerId: process.env.LEDGER_ID, now: new Date() });
await new DynamoDBClient({}).send(new PutItemCommand(put));
console.log('genesis written');
"
```

確認: `get-item` で `META#genesis` の `ledgerId` と `totalAttempts = 0` を見る。

## 6. override を発行する（arming 後、必要な日だけ）

1 日（Asia/Tokyo）に自動で許されるのは 2 attempt まで。3 回目以降には override が要る。

- 束縛: 1 つの revision（40 桁の commit id）、rule `SPARSE_DAILY_ATTEMPT_CEILING`、**その日**（Tokyo）。
- 有効期限は 24 時間以内。reason と approver が必須。create-only で、同じ revision・rule・日には 1 件だけ。
- 消費後は、同じ revision の同じ日の追加 attempt は人間でも許可できない（fail closed）。

```bash
cd infra
TABLE=<table> REVISION=<40 桁> REASON='<理由>' APPROVER='<承認者>' node --input-type=module -e "
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { buildIssueOverridePut, ledgerDay, DAILY_CEILING_RULE } from './broker/sparse-ledger.mjs';
const now = new Date();
const put = buildIssueOverridePut({ table: process.env.TABLE, revision: process.env.REVISION, rule: DAILY_CEILING_RULE,
  day: ledgerDay(now), expiresAt: Math.floor(now.getTime() / 1000) + 3600, reason: process.env.REASON, approver: process.env.APPROVER, now });
await new DynamoDBClient({}).send(new PutItemCommand(put));
console.log('override issued');
"
```

`approver` は issuer が書く値で、それ自体は認証されない。誰が書いたかの記録には
table の CloudTrail data events（arming 前ブロッカーの 1 つ）が要る。

## 7. 記録

各手順の完了時に #1153 へ残す: 実施日時、role の ARN（secret ではない）、policy の新しい VersionId、
stack の更新 ID、手順 4 の確認結果、rollback の有無。
