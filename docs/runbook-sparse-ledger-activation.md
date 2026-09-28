# Runbook: sparse deploy ledger の有効化（#1153 / #1179 / #1146）

**実行するのは owner（Mac の端末、人間の IAM 権限）だけ。** Claude のセッションは
IAM・CloudFormation・DynamoDB・SNS・CloudTrail に一切書き込まない。この runbook の各手順は Human Gate である。

- 設計の正本: `docs/architecture/aws-dev-deploy-broker.md` の「Sparse deploy attempt ledger (#1153)」と
  「Phase 2 pre-arming blockers」
- 実装: `infra/broker/sparse-ledger.mjs`、`infra/broker/ledger-runner.mjs`、`infra/broker/target-stacks.mjs`、
  `infra/lib/stacks/dev-deploy-broker-stack.ts`、`scripts/aws-policies/claude-boundary*.json` / `claude-cfn-exec*.json`
- **前提: arming 前ブロッカーの PR（#1182〜#1191）が main に merge 済みであること。** 手順 4 以降は、
  それらを含む broker stack（`SparseLedgerId` parameter、CloudTrail の data events、警報用 SNS topic を持つ版）が対象。
  merge 前の main で deploy しない。
- 状態: ledger は **実装済み・配送済み**。broker は ledger の module を SHA-256 で検証して読み込み、
  gate の deny を `ATTEMPT#` に監査記録する。**予約（`reserve`）はまだ呼ばない。** broker は
  `BROKER_NOT_ARMED` のままで、この runbook の手順 1〜7 をすべて実行しても mutation は起きない。
  genesis・override・stuck attempt の処理（手順 8〜10）は arming の作業に属する。

## owner の決定（2026-09-28、#1146 に記録）

| 項目 | 決定 | この runbook での扱い |
|---|---|---|
| issuer role / stack deploy role | 両方とも**専用 role を新規作成**する | 手順 2・4 |
| 警報の通知先 | **メール** | 手順 6 |
| override で `SPARSE_REVISION_REPEATED_FAILURE` を解除できるか | **解除不可**のまま | 手順 9 |
| override の仕様（revision・rule・日ごとに 1 件、消費後は同じ日に再許可できない） | **このまま** | 手順 9 |
| `REVIEW_IN_PROGRESS` の stack | **止める**（人間が片付けるまで `TARGET_STACK_NOT_STABLE`） | 手順 10 |
| stack deploy role を CDK の deploy role から渡す経路（bootstrap の変更） | **未決定**（Human Gate） | 手順 4 |

## 全体の順序

| # | 手順 | いつ | 可逆性 |
|---|---|---|---|
| 1 | 2 つの role の名前を決める | いつでも | — |
| 2 | override issuer role を作る | broker stack の deploy 前 | role を消せば戻る |
| 3 | boundary / cfn-exec policy の新しい版を適用する | ブロッカー 8 の merge 後、broker stack の deploy 前 | 前の版を default に戻せば戻る |
| 4 | stack deploy role を作り、渡せることを確かめる | broker stack の deploy 前 | role を消せば戻る |
| 5 | broker stack を deploy する | 1〜4 の後 | table・監査 bucket は `RETAIN`・削除保護（下記） |
| 6 | 警報の通知先（メール）を購読する | 5 の直後 | unsubscribe で戻る |
| 7 | CloudTrail の data events を確認する | 5 の後 | —（確認のみ） |
| 8 | genesis を書く | **arming 時** | create-only。書き直せない |
| 9 | override を発行する（必要な日だけ） | arming 後、3 回目以降の attempt が要る日 | create-only |
| 10 | 警報が来たら: stuck attempt を閉じる / 不安定な stack を片付ける | arming 後、警報のたび | 閉じた attempt は戻せない |
| 11 | 記録 | 各手順の後 | — |

## 1. 2 つの role の名前を決める

| parameter | 何の role か | 引き受けるのは |
|---|---|---|
| `SparseLedgerOverrideIssuerRoleArn` | 人間が genesis・override を書き、stuck attempt を閉じるための role | owner の人間 principal だけ |
| `SparseLedgerStackDeployRoleArn` | この broker stack **専用**の CloudFormation 実行 role | `cloudformation.amazonaws.com` だけ（人間が deploy するとき） |

どちらも stack の `HUMAN_ROLE_ARN_PATTERN` で、role 名（path の後ろ）が次で**始まるものは拒否される**:
`cdk-orcloud01-`、`OpenReception`、`nodi-`、`salon-loop-`、`Kiaff`。
**名前はこれらの外にする**（例: `ledger-override-issuer-human`、`ledger-stack-deploy-human`）。
既存の CDK bootstrap の cfn-exec role を流用しない（手順 4 の理由）。

🔴 誤った role を渡すと、table の resource policy が stack 自身の create / update（PITR の有効化など）を
止めることがある。復旧は手順 5 の「Rollback」を参照。

## 2. override issuer role を作る

- trust policy: owner の人間 principal（SSO の permission set、または MFA 必須の IAM user）だけ。
  `cdk-*` / `OpenReception*` / Claude の entry role は含めない。
- 権限: 手順 5 の後で、ledger table の ARN に限った inline policy を付ける。それまでは permission を付けない。
  table 名は CloudFormation が付ける（`OpenReception-DevDeployBroker-...`）ので、先に書けない。

  | action | 使う手順 |
  |---|---|
  | `dynamodb:PutItem` | 8 genesis、9 override |
  | `dynamodb:GetItem` | 8・9・10 の確認 |
  | `dynamodb:UpdateItem` | 10 stuck attempt を閉じる（`TransactWriteItems` の中の Update は `UpdateItem` として認可される） |
  | `dynamodb:Query` | 10 `in_progress` の attempt を探す（読み取りのみ） |

  `DeleteItem`・`BatchWriteItem`・`PartiQL*`・table 管理（`UpdateTable` 等）は付けない。

  🔴 table の resource policy は、issuer をすべての書き込みと管理操作の Deny から外している。
  そのため `PutItem` / `UpdateItem` を持つ issuer は、技術的には genesis・`DAY#`・`REV#` の item も書き換えられる。
  たとえば `unsettledCount` を戻して `SPARSE_REVISION_REPEATED_FAILURE` を外す、attempt を `succeeded` で閉じる、などである。
  「override はこの rule を解除しない」（owner 決定）は、ledger のコードでは守られているが、issuer の手作業に対しては
  **運用の約束でしか守られない**。この runbook の builder（`buildGenesisPut` / `buildIssueOverridePut` / `buildOutcomeTransaction`）以外で
  書かないこと。誰が何を書いたかは手順 7 の CloudTrail に残る。
  さらに絞る場合は、inline policy に `dynamodb:Attributes`（`ForAllValues:StringEquals`）の条件を付ける。
  - `PutItem`: genesis と override の属性だけ
  - `UpdateItem`: attempt を閉じる属性だけ、かつ `dynamodb:EnclosingOperation = TransactWriteItems`

  ただし、この条件は live で動作を確かめていない。手順 8 の genesis が拒否されないことを確かめてから使う。

- 確認:

  ```bash
  aws iam get-role --role-name <issuer role 名> --query 'Role.AssumeRolePolicyDocument'
  ```

## 3. boundary / cfn-exec policy の新しい版を適用する

🔴 **arming 前ブロッカー 8 の PR（broker の log group・警報・SNS topic・bucket・role を Claude の chain から Deny する変更）が
merge されてから行う。** それまでの版は、Claude の deploy chain とその下の workload role に次を許したままにしている。
- `logs:*` / `cloudwatch:*` / `sns:*` / `s3:*` on `*`
- broker の log（監査の証拠）を消す
- 警報を止める
- メール購読を外す

policy の版を 2 回に分けて適用しないよう、この手順はブロッカー 8 と一緒に 1 回で行う。

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
# ブロッカー 8: broker の log・警報・通知・bucket
for pair in \
  "logs:DeleteLogGroup arn:aws:logs:ap-northeast-1:822063948773:log-group:OpenReception-DevDeployBroker-BrokerLogsX-x" \
  "cloudwatch:DisableAlarmActions arn:aws:cloudwatch:ap-northeast-1:822063948773:alarm:OpenReception-DevDeployBroker-LedgerAttentionAlarmX-x" \
  "sns:SetTopicAttributes arn:aws:sns:ap-northeast-1:822063948773:OpenReception-DevDeployBroker-BrokerAlertsX-x" \
  "s3:DeleteObjectVersion arn:aws:s3:::openreception-devdeployb-pipelineartifactsx-x/k" \
  "iam:DeleteRolePolicy arn:aws:iam::822063948773:role/OpenReceptionTrustedDevDeployBrokerRole"; do
  set -- $pair
  aws iam simulate-principal-policy --policy-source-arn "$EXEC" --action-names "$1" --resource-arns "$2" \
    --query 'EvaluationResults[0].EvalDecision' --output text   # すべて explicitDeny
done
```

加えて、通常の dev deploy の経路が壊れていないことを確かめる（`scripts/aws-cloud-deploy.sh preflight`
が green）。

**Rollback**: 直前の版を default に戻す。

```bash
aws iam list-policy-versions --policy-arn <ARN> --query 'Versions[*].[VersionId,IsDefaultVersion,CreateDate]' --output table
aws iam set-default-policy-version --policy-arn <ARN> --version-id <直前の版>
```

## 4. stack deploy role を作り、渡せることを確かめる

この role は 2 つの resource policy で**例外扱い**になる。

- ledger table の管理操作（`UpdateTable`・`DeleteTable`・`PutResourcePolicy`・PITR の変更など）
- 監査 bucket の履歴削除と保護の変更（version の削除、versioning / lifecycle / policy の変更、`DeleteBucket` など）

そのため、**この stack 以外の deploy に使ってはいけない。** 候補コード由来の stack（Web / WebMonitoring / CfMon など）を
この role で deploy すると、その template から ledger や監査ログを消せてしまう。

- 名前: 手順 1 で決めたもの（`HUMAN_ROLE_ARN_PATTERN` の外）。
- trust policy: `cloudformation.amazonaws.com` だけ。人間・Claude・CodeBuild は含めない。
- 権限: broker stack が作るものだけにする。`cdk synth`（credential 不要）で数えた resource は次のとおり。

  | resource type | 数 |
  |---|---|
  | `AWS::IAM::Role` / `AWS::IAM::Policy` | 6 / 6 |
  | `AWS::CodeBuild::Project` | 2 |
  | `AWS::CodePipeline::Pipeline` | 1 |
  | `AWS::S3::Bucket` / `AWS::S3::BucketPolicy` | 2 / 2（artifact bucket と監査 bucket） |
  | `AWS::DynamoDB::Table` | 1（resource policy・PITR・削除保護つき） |
  | `AWS::CloudTrail::Trail` | 1（`OpenReceptionSparseLedgerAudit`） |
  | `AWS::Logs::LogGroup` / `AWS::Logs::MetricFilter` | 2 / 1 |
  | `AWS::SNS::Topic` / `AWS::SNS::TopicPolicy` | 1 / 1 |
  | `AWS::CloudWatch::Alarm` | 1 |
  | `AWS::Events::Rule` | 2 |

  CDK の custom resource（Lambda）は無い。policy の本文は owner が書く。
  次の点を守り、`aws iam simulate-custom-policy` か最初の change set 作成で確かめる。

  - IAM は、この stack が作る role（`OpenReceptionDevDeployValidationRole`・`OpenReceptionTrustedDevDeployBrokerRole`・
    生成名の `OpenReception-DevDeployBr*`）に限る。role 名は 64 文字で stack 名ごと切られ、
    `OpenReception-DevDeployBr-...` になる。
  - `iam:PassRole` は、pipeline role を CodePipeline に、2 つの build role を CodeBuild に渡す分だけ
    （`iam:PassedToService` で絞る）。EventBridge の rule は SNS へ直接送り、role を使わない。
  - 名前で絞る:
    - CodeBuild project: `OpenReceptionDevDeployValidation`・`OpenReceptionTrustedDevDeployBroker`
    - pipeline: `OpenReceptionSparseDevDeploy`
    - trail: `OpenReceptionSparseLedgerAudit`
  - CloudFormation が付ける物理名は、接頭辞で絞る:
    - DynamoDB・log group・alarm・SNS: `OpenReception-DevDeployBroker-*`
    - Events rule（上限 64 文字）: `OpenReception-DevDeployBr*`
    - S3 bucket（上限 63 文字・小文字。stack 名ごと切られる）: `openreception-devdeploy*`
  - pipeline の作成には、GitHub 接続（`GitHubConnectionArn`）への `codestar-connections:PassConnection`
    （または `codeconnections:PassConnection`）が要る。
  - `Resource: "*"` が要る read 系（`Describe*` 等）以外で、他の stack の resource に届かないこと。

- **渡せることの確認（deploy 前に必須）**: `cdk deploy --role-arn` は、CDK bootstrap の deploy role
  （`cdk.json` の qualifier は `hnb659fds`）を引き受けてから、CloudFormation にこの role を渡す。
  **既定の bootstrap template では、deploy role の `iam:PassRole` は bootstrap 自身の cfn-exec role に限られる。**
  bootstrap を変えていなければ、下の確認は `implicitDeny` になる。

  ```bash
  DEPLOY=arn:aws:iam::822063948773:role/cdk-hnb659fds-deploy-role-822063948773-ap-northeast-1
  aws iam get-role --role-name cdk-hnb659fds-deploy-role-822063948773-ap-northeast-1 --query 'Role.RoleName'
  aws iam simulate-principal-policy --policy-source-arn "$DEPLOY" \
    --action-names iam:PassRole --resource-arns <stack deploy role ARN> \
    --query 'EvaluationResults[0].EvalDecision' --output text    # allowed であること
  ```

  deploy role が無い、または `allowed` でない場合は**ここで止める**。bootstrap を変えるのは別の Human Gate である。
  owner が決め、#1146 に記録する。

  🔴 **共有の `hnb659fds` deploy role の PassRole を単純に広げない。** その deploy role は account 全体から引き受けられる
  （Claude の role は boundary の `DenySharedBootstrapRoles` で拒否されるが、他の project や人間は引き受けられる）。
  PassRole を広げると、誰でも任意の template をこの role で実行できるようになる。
  この role は、監査 bucket の履歴削除、bucket policy の変更、ledger の resource policy と table の変更・削除ができる。

  選択肢（owner が決める）:
  - (a) この stack 専用の bootstrap qualifier を作り、その deploy role の trust を owner の人間 principal だけにする。
  - (b) 既存の deploy role に、次の 2 つをあわせて付ける:
    - この role への PassRole（`iam:PassedToService = cloudformation.amazonaws.com`）
    - `cloudformation:RoleArn` がこの role で、対象が `stack/OpenReception-DevDeployBroker/*` 以外の
      `CreateStack` / `UpdateStack` / `CreateChangeSet` を拒否する Deny

  broker stack をほかの経路で deploy する方法は、この runbook では扱わない。

## 5. broker stack を deploy する

broker stack は人間が管理する control plane であり、Claude の deploy chain では deploy しない
（手順 3 で Claude の chain からは Deny される）。owner の人間 credential で、手順 4 の
stack deploy role を CloudFormation 実行 role として使う。

`SparseLedgerId` は owner が決める。これは ledger の識別子で、secret ではない。

- 形式: `^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$`（8〜128 文字）。
- broker はこの値を pin する。手順 8 の genesis も同じ値で書く。
- 一度 genesis を書いたら変えない。変えると broker は `SPARSE_LEDGER_CORRUPT` で止まる。

`cdk diff` は `--parameters` を受け付けない（黙って無視し、template だけの diff に落ちる）。そのため、
parameter を含めた変更は、**実行しない change set** を作って確かめる:

```bash
cd infra
ARGS=(--app "npx ts-node --prefer-ts-exts bin/dev-deploy-broker.ts" OpenReception-DevDeployBroker
  --role-arn <stack deploy role ARN>
  --parameters SparseLedgerOverrideIssuerRoleArn=<issuer role ARN>
  --parameters SparseLedgerStackDeployRoleArn=<stack deploy role ARN>
  --parameters SparseLedgerId=<owner が決めた ledger id>
  --parameters GitHubConnectionArn=<既存の値> --parameters DevAppSecretsName=open-reception/dev/app-v2
  --parameters DevPublicOriginOverride=<既存の値> --parameters DevProviderSecretBackend=secrets-manager
  --change-set-name ledger-activation)
npx cdk deploy "${ARGS[@]}" --method=prepare-change-set          # 作るだけ。実行しない
aws cloudformation describe-change-set --stack-name OpenReception-DevDeployBroker --change-set-name ledger-activation \
  --query 'Changes[].ResourceChange.{Action:Action,Id:LogicalResourceId,Type:ResourceType,Replace:Replacement}' --output table
# 確認してから実行する
npx cdk deploy "${ARGS[@]}" --method=execute-change-set
```

- 既存の table・bucket に `Remove` や `Replacement: True` が無いこと。あれば実行せず、change set を消して止める。
- 初回（stack が無い）なら、すべて `Add` になる。

change set で確認すること:

- **ledger table**: PAY_PER_REQUEST、PITR、削除保護、`RETAIN`、stream なし。
  resource policy は、書き込みを broker role と issuer role に、管理操作を issuer role と stack deploy role に限る。
  broker role への `GetItem` / `PutItem` / `UpdateItem` は `dynamodb:LeadingKeys` = `PROJECT#open-reception`。
- **監査 bucket**: versioning、400 日保持、`RETAIN`。bucket policy も `RETAIN` で、次を含む。
  - trail 以外の `PutObject` を拒否する Deny
  - stack deploy role 以外の履歴削除・保護変更・`DeleteBucket` を拒否する Deny
- **trail**: `OpenReceptionSparseLedgerAudit`。single-region、log file validation あり。
  selector は ledger table の書き込み data events だけ。
- **警報**: SNS topic 1 つ（購読は無し）、broker log の metric filter と alarm、EventBridge rule 2 つ
  （build の `STOPPED` / `TIMED_OUT` / `FAULT`）。
- **権限の範囲**: Validation role には table・trail・監査 bucket への権限が**無い**。
  broker role に `cloudformation:` として付くのは、3 stack の `DescribeStacks` だけ。
- **buildspec**: broker は、trusted policy・provenance module・ledger module・runner・target-stacks module の SHA-256 を検証してから使う。
  そのうえで `BROKER_NOT_ARMED`（exit 42）で止まる。`reserve` は呼ばない。

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
aws cloudformation describe-stacks --stack-name OpenReception-DevDeployBroker \
  --query "Stacks[0].Parameters[?ParameterKey=='SparseLedgerId'].ParameterValue" --output text   # 決めた ledger id
```

その後、手順 2 の issuer role に、この table の ARN に限った inline policy（手順 2 の表の 4 action）を付ける。

**Rollback**:

- stack の update が失敗して戻れない、または誤った role を渡して resource policy が stack 自身を止めた場合:
  - **account の root user** は、table の `DeleteResourcePolicy` を常に呼べる
    （DynamoDB は自分を締め出せないようにこの経路を残している）。
  - resource policy を消し、正しい parameter で再 deploy する。
  - resource policy は drift 検出されない。
- 監査 bucket の policy は、stack deploy role 以外による保護の変更（versioning・lifecycle・policy・暗号化・
  public access block・ownership）を拒否する。違う `--role-arn` で deploy すると、stack 自身の bucket 更新も止まる。
  復旧: **account の root user** は S3 の bucket policy を常に消せる（S3 の締め出し防止の例外）。
  消している間は監査の保護が外れるので、実施日時と理由を #1153 に記録し、すぐ正しい role で再 deploy する。
- stack deploy role を**変える**とき: 新しい role で deploy すると、上の Deny に止められる。
  1 回目は **古い role を `--role-arn` に**、新しい role を `SparseLedgerStackDeployRoleArn` に渡して update し、
  2 回目以降は新しい role を使う。
- table・監査 bucket・bucket policy・log group は `RETAIN`。stack を消しても残る。
  table には削除保護も付いている。

## 6. 警報の通知先（メール）を購読する

stack は SNS topic に購読を付けない。owner のメールアドレスを、owner 自身が購読する。
アドレスは個人情報なので、Issue や repo には書かない。

```bash
TOPIC=$(aws cloudformation describe-stack-resources --stack-name OpenReception-DevDeployBroker \
  --query "StackResources[?ResourceType=='AWS::SNS::Topic'].PhysicalResourceId" --output text)
aws sns subscribe --topic-arn "$TOPIC" --protocol email --notification-endpoint <owner の受信アドレス>
# 届いたメールの確認リンクは開かない。リンクの URL にある Token= の値を使い、
# 認証なしでは購読解除できない形で確認する（転送されたメールの unsubscribe リンクで警報が止まらないように）
aws sns confirm-subscription --topic-arn "$TOPIC" --token <Token の値> --authenticate-on-unsubscribe true
aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" \
  --query 'Subscriptions[].SubscriptionArn' --output text     # PendingConfirmation でないこと
```

届くことの確認（任意。alarm の状態を一時的に変えるだけで、ledger には触れない）:

```bash
ALARM=$(aws cloudformation describe-stack-resources --stack-name OpenReception-DevDeployBroker \
  --query "StackResources[?ResourceType=='AWS::CloudWatch::Alarm'].PhysicalResourceId" --output text)
aws cloudwatch set-alarm-state --alarm-name "$ALARM" --state-value ALARM --state-reason 'runbook: notification test'
# メールが届いたら、次の評価で OK に戻る（手動で戻すなら --state-value OK）
```

未確認のまま残る点（live で確かめる）:

- CodeBuild の停止・timeout が、実際にどちらの EventBridge event で届くか。
- alarm から topic へ publish できるか（topic policy は alarm の ARN に束縛してある）。

## 7. CloudTrail の data events を確認する

```bash
aws cloudtrail get-trail-status --name OpenReceptionSparseLedgerAudit --query IsLogging          # true
aws cloudtrail get-event-selectors --trail-name OpenReceptionSparseLedgerAudit \
  --query 'AdvancedEventSelectors[].FieldSelectors'      # Data / AWS::DynamoDB::Table / table ARN / readOnly=false
```

最初の書き込み（手順 8 の genesis）の後、15 分ほどで監査 bucket の `AWSLogs/822063948773/` の下に
log file が届くことを見る。

live で確かめる点:

- `PutItem` / `TransactWriteItems` の event に item の key（`SK`。例: `META#genesis`・`OVERRIDE#...`）が載るか。
- 条件で拒否された書き込みも記録されるか。

残余リスク: trail 自体の停止（`StopLogging` / `DeleteTrail`）を防ぐのは、`cloudtrail:` 権限を誰が持つかだけ。
account の management event trail が、その操作を記録している前提である（この repo からは確認していない）。

## 8. genesis を書く（arming 時。今はまだ実行しない）

arming の PR（`reserve` / `outcome` を mutation の前後に呼ぶ変更）の merge 時に、1 回だけ書く。
`ledgerId` は手順 5 の `SparseLedgerId` と同じ値にする。genesis は create-only で、2 回目は失敗する。
genesis が無いか値が違う間は、broker は `SPARSE_LEDGER_CORRUPT` で止まる（fail closed）。

repo の root で `npm ci` 済みであること（`@aws-sdk/client-dynamodb` は root の依存）。
issuer role を引き受けた credential（profile）で、repo の実装（`buildGenesisPut`）を使って書く。
`AWS_PROFILE` が issuer role を指していることを `aws sts get-caller-identity` で先に確かめる:

```bash
cd infra
TABLE=<手順 5 の table 名> LEDGER_ID=<SparseLedgerId の値> node --input-type=module -e "
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { buildGenesisPut } from './broker/sparse-ledger.mjs';
const put = buildGenesisPut({ table: process.env.TABLE, ledgerId: process.env.LEDGER_ID, now: new Date() });
await new DynamoDBClient({ region: 'ap-northeast-1' }).send(new PutItemCommand(put));
console.log('genesis written');
"
```

確認: `get-item` で `META#genesis` を読み、`ledgerId` が `SparseLedgerId` と同じで、`totalAttempts = 0` であることを見る。

## 9. override を発行する（arming 後、必要な日だけ）

1 日（Asia/Tokyo）に自動で許されるのは 2 attempt まで。3 回目以降には override が要る。

- 束縛: 1 つの revision（40 桁の commit id）、rule `SPARSE_DAILY_ATTEMPT_CEILING`、**その日**（Tokyo）。
- 有効期限は 24 時間以内。reason と approver が必須。
- create-only で、同じ revision・rule・日には 1 件だけ。消費後は、同じ revision の同じ日の追加 attempt を
  人間でも許可できない（fail closed。owner 決定で、このまま）。
- **override は `SPARSE_REVISION_REPEATED_FAILURE` を解除しない**（owner 決定）。
  同じ revision の未成功の attempt が 2 件になったら、直すのは新しい revision であり、override ではない。
  この rule は daily ceiling より先に報告され、警報が鳴る。

```bash
cd infra
TABLE=<table> REVISION=<40 桁> REASON='<理由>' APPROVER='<承認者>' node --input-type=module -e "
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { buildIssueOverridePut, ledgerDay, DAILY_CEILING_RULE } from './broker/sparse-ledger.mjs';
const now = new Date();
const put = buildIssueOverridePut({ table: process.env.TABLE, revision: process.env.REVISION, rule: DAILY_CEILING_RULE,
  day: ledgerDay(now), expiresAt: Math.floor(now.getTime() / 1000) + 3600, reason: process.env.REASON, approver: process.env.APPROVER, now });
await new DynamoDBClient({ region: 'ap-northeast-1' }).send(new PutItemCommand(put));
console.log('override issued');
"
```

`approver` は issuer が書く値で、それ自体は認証されない。誰が書いたかは、手順 7 の CloudTrail data events で記録される。

## 10. 警報が来たら（arming 後）

警報メールの原因は broker の log group（CloudWatch Logs）の JSON 行で見る。
`event`（`ledger.reserve_ambiguous` / `ledger.outcome_failed` / `ledger.runner_error` / `ledger.usage_error` /
`ledger.denial_audit_failed`）、`audited: false`、または `rule` を見る。
EventBridge 経由の警報は、broker build の停止・timeout・fault である。

### 10a. `in_progress` のまま残った attempt を閉じる

予約された attempt は、成功か失敗が記録されるまで `in_progress` のまま予算を持ち続ける。
自動では閉じない（仕様）。

1. 対象を探す（issuer role、読み取りのみ）:

   ```bash
   aws dynamodb query --table-name "$TABLE" \
     --key-condition-expression 'PK = :pk AND begins_with(SK, :a)' \
     --filter-expression '#s = :ip' --expression-attribute-names '{"#s":"status"}' \
     --expression-attribute-values '{":pk":{"S":"PROJECT#open-reception"},":a":{"S":"ATTEMPT#"},":ip":{"S":"in_progress"}}' \
     --query 'Items[].{attemptId:attemptId.S,day:day.S,revision:revision.S,reservedAt:reservedAt.S}'
   ```

2. その attempt の build が終わっていることを確かめる。attempt id は CodeBuild の build id そのもの。

   ```bash
   aws codebuild batch-get-builds --ids <attemptId> --query 'builds[0].buildStatus'    # IN_PROGRESS でないこと
   aws cloudformation describe-stacks --stack-name OpenReception-Web-dev --query 'Stacks[0].StackStatus'
   aws cloudformation describe-stacks --stack-name OpenReception-WebMonitoring-dev --query 'Stacks[0].StackStatus'
   aws cloudformation describe-stacks --stack-name OpenReception-CfMon-dev --region us-east-1 --query 'Stacks[0].StackStatus'
   # どれも *_IN_PROGRESS でないこと
   ```

   **終わっていなければ閉じない。**
3. `failed` として閉じる（`succeeded` にはしない）。`attemptId`・`day`・`revision` は 1. で読んだ item の値を使う:

   ```bash
   cd infra
   TABLE=<table> ATTEMPT_ID=<attemptId> DAY=<day> REVISION=<revision> node --input-type=module -e "
   import { DynamoDBClient, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
   import { buildOutcomeTransaction } from './broker/sparse-ledger.mjs';
   const tx = buildOutcomeTransaction({ table: process.env.TABLE, attemptId: process.env.ATTEMPT_ID, day: process.env.DAY,
     outcome: 'failed', now: new Date(), revision: process.env.REVISION });
   await new DynamoDBClient({ region: 'ap-northeast-1' }).send(new TransactWriteItemsCommand(tx));
   console.log('attempt closed as failed');
   "
   ```

   閉じるのは**記録のため**で、予算は戻らない。
   - その日の attempt 数（`attemptCount`）は変わらない。
   - revision の `unsettledCount` も変わらない。未成功の 1 件として残り、2 件目で `SPARSE_REVISION_REPEATED_FAILURE` になる。
   - preflight は `ATTEMPT#` の status を読まない。
   - ledger 上では、人間が閉じたものと broker が記録したものの区別はつかない。
     誰が閉じたかは CloudTrail（手順 7）と #1153 の記録で残す。

### 10b. `TARGET_STACK_NOT_STABLE`

target stack（`OpenReception-Web-dev` / `OpenReception-WebMonitoring-dev` / `OpenReception-CfMon-dev`（us-east-1））の
どれかが、操作中・失敗・`ROLLBACK_COMPLETE`・`REVIEW_IN_PROGRESS` などにある。broker は人間が片付けるまで止まり続ける
（owner 決定）。

- 状態は `describe-stacks` で見る。
- 片付け（失敗した change set や空の stack の削除など）は owner の判断で行う。
  - 削除してよいのは、`ROLLBACK_COMPLETE` の stack と、resource を持たない `REVIEW_IN_PROGRESS` の stack だけ。
  - 🔴 `UPDATE_ROLLBACK_FAILED` の stack は**消さない**（稼働中の resource を持つ）。
    `aws cloudformation continue-update-rollback` で戻す。
- 片付けは通常の dev deploy の手順（`docs/runbook-cloud-aws-deploy.md`）に従う。

### 10c. `TARGET_STACK_UNVERIFIABLE` / `TARGET_STACK_INPUT_INVALID`

broker が target stack の状態を読めなかった（権限・throttling・timeout・想定外の応答）。
fail closed で止まっている。

- 原因は broker の log で見る。
- broker role の `cloudformation:DescribeStacks`（3 stack の ARN に限定）が変わっていないかを確かめる。

## 11. 記録

各手順の完了時に #1153 へ残す:

- 実施日時
- role の ARN（secret ではない）
- `SparseLedgerId` の値
- policy の新しい VersionId
- stack の更新 ID
- 手順 5・7 の確認結果
- 通知先を購読した事実（アドレスは書かない）
- 閉じた attempt の id と理由
- rollback の有無
