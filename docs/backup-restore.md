# バックアップ / リストア・DR 手順 (issue #315)

DynamoDB PITR・S3・SSM・Secrets Manager の「戻せる設定」を、実際に「戻す手順」に落とし込む
runbook。対象読者は運用当番・開発者（`docs/runbook.md` のアラーム対応/手動受付切替と対）。

前提: prod は DynamoDB PITR・DeletionProtection が有効
（`infra/lib/config/environments.ts` の `data.pointInTimeRecovery` / `data.removalProtection`、
`infra/lib/stacks/web-stack.ts` の `DataTable`）。「有効化されている」ことと「復元できる」こと
は別物であり、本書は後者を埋める。

## 0. 対象データと現状のバックアップ機構

| データ | 保管先 | バックアップ機構 | 備考 |
| --- | --- | --- | --- |
| 業務データ（部署/担当者/受付履歴/監査ログ/端末/アセット登録/テナント・拠点/設定） | DynamoDB `DataTable`（シングルテーブル、`docs/persistence-design.md`） | **PITR**（prod/staging 有効、dev 既定は無効） | 復元手順は §2 |
| 静的アセット実体（VRM/背景/モーション画像ファイル） | S3 `AssetBucket`（`_assets` prefix、`BucketDeployment` で配布） | **なし（バージョニング未設定）**。実体は git リポジトリ `public/` 配下がソースオブトゥルース | 復元 = 再デプロイ（§3） |
| 拠点設定（`siteConfigPrefix` 配下） | SSM Parameter Store | **なし**（Parameter Store 自体に世代管理はない） | 再投入手順は §3.2 |
| アプリ機密（ADMIN_PASSWORD 等） / 拠点トークン鍵 / Vonage 接続情報 | Secrets Manager | AWS 既定でシークレット自体は保持されるが、**値の記録は運用者の責任** | 再投入手順は §3.3 |
| Cognito 管理者ユーザー | Cognito User Pool（`AdminUserPool`） | なし（バックアップ対象外。管理者再作成で復旧） | スコープ外（影響小） |

## 1. RPO / RTO 目標

受付端末は「業務時間中の稼働」が本質（来訪者対応が止まると即座に業務影響）。一方、データの
書き込みは受付・呼び出し・監査ログが中心で、書き込み頻度自体は一般的な Web サービスに比べ
小さい（拠点あたり iPad 数台、来訪者トラフィックのオーダー）。この特性から以下を目標とする。

| 指標 | 目標値 | 根拠 |
| --- | --- | --- |
| **RPO（目標復旧時点）** | **5 分以内**（業務時間中） | DynamoDB PITR の実復元粒度は秒単位だが、障害検知〜復元時点の意思決定に要する時間を保守的に見込み 5 分とする。5 分は `docs/runbook.md` の CloudWatch アラーム集計期間（5 分 period）と揃えており、アラーム発報〜対応着手のリードタイムと整合する。 |
| **RTO（サービス可用性）** | **数分以内（実質即時）** | データ復元の完了を待たずに `docs/runbook.md` §2「手動受付切替フロー」（緊急停止モード → 紙・電話の代替受付）で来訪者対応自体は継続できる。**受付端末が使えない状態の RTO は本書のデータ復元手順に依存しない**。 |
| **RTO（データ完全復旧）** | **60 分以内**（prod 想定） | `restore-table-to-point-in-time` の所要時間（テーブルサイズに依存、本システム規模なら概ね数分〜十数分）+ 検証（§2.4）+ 切替（§2.5）を合算した見積もり。dev 復元演習（§5）で実測し、乖離があれば本値を見直す。 |

> **運用原則**: 障害時は復元作業と並行して、必要なら**先に**手動受付切替（`docs/runbook.md` §2）
> を行い来訪者対応を継続する。データ復元完了を待ってから代替受付を検討するのではない。

## 2. DynamoDB PITR 復元 runbook

### 2.1 前提確認

対象テーブル名は CDK が生成するため固定名ではない。デプロイ時の Outputs、または
CloudFormation から確認する。

```bash
# 環境変数（コピペ用に置き換える）
ENV=prod                      # dev / staging / prod
REGION=ap-northeast-1

# テーブル名を CloudFormation Outputs から取得（DataTableName）
TABLE_NAME=$(aws cloudformation describe-stacks \
  --stack-name "OpenReception-Web-${ENV}" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DataTableName'].OutputValue" \
  --output text)
echo "TABLE_NAME=$TABLE_NAME"

# PITR が有効か確認（prod/staging は true、dev 既定は false）
aws dynamodb describe-continuous-backups \
  --table-name "$TABLE_NAME" --region "$REGION" \
  --query "ContinuousBackupsDescription.PointInTimeRecoveryDescription"
```

`PointInTimeRecoveryStatus` が `ENABLED` でない場合、このテーブルは PITR 復元できない
（dev の既定がこれに当たる。§5 の dev 復元演習ではまず PITR を有効化する）。

### 2.2 restore-to-new-table（新規テーブルへ復元）

**既存テーブルへの直接上書きはできない**（DynamoDB PITR の API 仕様上、常に新規テーブル名を
指定する）。CDK 管理下の `DataTable` はそのままに、復元専用の一時テーブルを作る。

```bash
RESTORE_TABLE="${TABLE_NAME}-restore-$(date +%Y%m%d%H%M)"

# 復元時点を指定する場合（インシデント直前の時刻を UTC で指定）
RESTORE_AT="2026-07-12T03:00:00Z"

aws dynamodb restore-table-to-point-in-time \
  --source-table-name "$TABLE_NAME" \
  --target-table-name "$RESTORE_TABLE" \
  --restore-date-time "$RESTORE_AT" \
  --region "$REGION"

# 最新の復元可能時点（直近の障害直前）で復元する場合は上記の代わりに:
#   aws dynamodb restore-table-to-point-in-time \
#     --source-table-name "$TABLE_NAME" \
#     --target-table-name "$RESTORE_TABLE" \
#     --use-latest-restorable-time \
#     --region "$REGION"

# 作成完了を待つ（テーブルステータスが ACTIVE になるまで）
aws dynamodb wait table-exists --table-name "$RESTORE_TABLE" --region "$REGION"
aws dynamodb describe-table --table-name "$RESTORE_TABLE" --region "$REGION" \
  --query "Table.TableStatus"
```

> **重要**: `restore-table-to-point-in-time` は主キー・GSI（`GSI1PK`/`GSI1SK`）のスキーマは
> 復元するが、**TTL 設定と PITR 設定は復元先テーブルに引き継がれない**（AWS の仕様。新規テーブル
> は両方とも無効な状態で作成される）。§2.3 で明示的に再設定する。

### 2.3 復元先テーブルの後処理（TTL / PITR の再有効化）

```bash
# TTL 属性（ttl）を再有効化（docs/persistence-design.md の受付セッション失効等が壊れないように）
aws dynamodb update-time-to-live \
  --table-name "$RESTORE_TABLE" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" \
  --region "$REGION"

# 復元先テーブル自体の PITR も有効化しておく（切替後にこのテーブルが本番運用に入る場合の保険）
aws dynamodb update-continuous-backups \
  --table-name "$RESTORE_TABLE" \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true \
  --region "$REGION"
```

### 2.4 検証

切替前に、復元先テーブルがアプリの前提（キー設計・GSI・代表的なアクセスパターン）を満たすか
確認する。`docs/persistence-design.md` §4.1 のキー設計に基づく確認例:

```bash
# スキーマ確認（GSI1 と TTL 属性が復元されているか）
aws dynamodb describe-table --table-name "$RESTORE_TABLE" --region "$REGION" \
  --query "Table.{GSIs:GlobalSecondaryIndexes[].IndexName, ItemCount:ItemCount}"
aws dynamodb describe-time-to-live --table-name "$RESTORE_TABLE" --region "$REGION"

# 代表エンティティのサンプル取得（端末一覧。PK=KIOSK）
aws dynamodb query --table-name "$RESTORE_TABLE" --region "$REGION" \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"KIOSK"}}' \
  --max-items 5

# 受付履歴が新しい順に引けるか（PK=RCPLOG, ScanIndexForward=false 相当）
aws dynamodb query --table-name "$RESTORE_TABLE" --region "$REGION" \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"RCPLOG"}}' \
  --no-scan-index-forward --max-items 5
```

アプリ整合の最終確認は、可能であれば §4 のアプリ検証（受付フローが実際に動く）まで通す。
dev 環境ではアプリの `TABLE_NAME` を復元先に切り替えて動作確認できる（§5 参照）。

### 2.5 切替（本番反映）

**現状の CDK コード制約**: `infra/lib/stacks/web-stack.ts` の server Lambda 環境変数は
`{ ...appEnv, DATA_BACKEND: 'dynamodb', TABLE_NAME: dataTable.tableName }` の順で組み立てられ、
`TABLE_NAME` は常に **CDK が生成した `DataTable` のテーブル名で上書きされる**。つまり
`-c appEnv='{"TABLE_NAME":"..."}'` で復元先テーブルを指す通常の `cdk deploy` はできない
（appEnv の値より後に固定値で上書きされるため）。切替方式は状況に応じて次のいずれかを取る。

#### 方式 A（推奨・CDK 整合を保つ）: データコピー

復元先テーブルの内容を、CDK 管理下の**既存の** `DataTable`（`$TABLE_NAME`）へコピーする。
テーブル名が変わらないため CDK ドリフトが発生せず、以後の通常デプロイに影響しない。
小〜中規模データ（本システムの想定運用規模: 部署/担当者/端末/直近ログ）向けの簡易手順。

```bash
SRC_TABLE="$RESTORE_TABLE"   # §2.2 で作った復元先
DST_TABLE="$TABLE_NAME"      # CDK 管理下の本来のテーブル（§2.1 で取得）
LEK=""

while :; do
  if [ -z "$LEK" ]; then
    OUT=$(aws dynamodb scan --table-name "$SRC_TABLE" --region "$REGION" --output json)
  else
    OUT=$(aws dynamodb scan --table-name "$SRC_TABLE" --region "$REGION" --output json \
      --exclusive-start-key "$LEK")
  fi

  # 25 件ずつ BatchWriteItem（DynamoDB の 1 リクエストあたり上限）で DST_TABLE へ書き込む
  echo "$OUT" | jq -c --arg tbl "$DST_TABLE" '
    def nwise(n): def n1: if length <= n then . else .[0:n], (.[n:] | n1) end; n1;
    (.Items | nwise(25))[]? as $chunk
    | { ($tbl): [ $chunk[] | {PutRequest: {Item: .}} ] }
  ' | while read -r BATCH; do
    aws dynamodb batch-write-item --region "$REGION" --request-items "$BATCH" >/dev/null
  done

  LEK=$(echo "$OUT" | jq -c '.LastEvaluatedKey // empty')
  [ -z "$LEK" ] && break
done

echo "コピー後の件数（概算）: $(aws dynamodb scan --table-name "$DST_TABLE" --region "$REGION" \
  --select COUNT --query Count --output text)"
```

> 大量データや `UnprocessedItems`（スロットリング）が懸念される場合は、上記ループに
> `BatchWriteItem` レスポンスの `UnprocessedItems` を再試行するロジックを追加するか、
> AWS Data Pipeline 等の専用ツールを検討する。本システムの想定データ量では簡易ループで十分。

コピー完了後、復元先の一時テーブル（`$RESTORE_TABLE`）は§2.6 の確認後に削除する
（`aws dynamodb delete-table --table-name "$RESTORE_TABLE" --region "$REGION"`）。

#### 方式 B（緊急時のみ・break-glass）: Lambda 環境変数の直接切替

データコピー（方式 A）の完了を待てないほど緊急性が高い場合、server Lambda の `TABLE_NAME`
環境変数を復元先テーブルへ直接向けて即時復旧させることもできる。

```bash
FUNCTION_NAME=$(aws cloudformation describe-stack-resources \
  --stack-name "OpenReception-Web-${ENV}" --region "$REGION" \
  --logical-resource-id ServerFn \
  --query "StackResources[0].PhysicalResourceId" --output text)

aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" --region "$REGION" \
  --environment "Variables={TABLE_NAME=$RESTORE_TABLE, ...}"  # 既存の他の環境変数も含めて渡す必要あり
```

> **必ず方式 A へ収束させる**: この方式は CDK が管理する `TABLE_NAME` を CDK の外側で書き換える
> ため、次に誰かが（気づかずに）`cdk deploy OpenReception-Web-<env>` を実行すると
> `TABLE_NAME` が元の `$TABLE_NAME` に強制的に戻され、復元前の状態に逆戻りする（サイレントな
> データ不整合）。方式 B を使ったら、インシデント対応後**速やかに**方式 A（データコピー）で
> 元テーブルへ反映し、Lambda 環境変数も `cdk deploy` で正規状態に戻す。それまでの間、他の
> 運用者が同スタックへ `cdk deploy` しないよう周知する。

### 2.6 後片付け

- 切替が完了し、アプリが正常動作することを確認したら、復元用の一時テーブル
  （`$RESTORE_TABLE`）は課金対象になるため削除する。
- 対応記録（インシデント時刻・復元時点・使用した方式・所要時間）を §6 の演習記録に準じた形式で
  残す。

## 3. アセット S3 / SSM / Secrets の再投入

### 3.1 アセット用 S3（`AssetBucket`）

- 現状 **バージョニングは有効化していない**（`infra/lib/stacks/web-stack.ts` の
  `AssetBucket` に `versioned` 指定なし）。これはリスクとして許容している設計判断であり、
  理由は次のとおり: バケットの内容（VRM/背景/モーション等の静的アセット実体）は
  `s3deploy.BucketDeployment` が `.open-next/assets`（= リポジトリ `public/` 配下の
  ビルド成果物）から都度アップロードする。**ソースオブトゥルースは git リポジトリ**であり、
  S3 バケット自体は再生成可能なキャッシュに近い。
- したがって S3 アセットの「バックアップからの復元」は、**アプリの再ビルド・再デプロイ**で
  代替する:

  ```bash
  npm run build:open-next
  cd infra && npx cdk deploy "OpenReception-Web-${ENV}" -c env="${ENV}" -c appEnv="$APP_ENV"
  ```

  （`APP_ENV` は `docs/deploy-aws.md` 手順6と同じ機密 JSON。既存デプロイの再実行と同一操作。）
- アセットの**登録メタデータ**（種別・名称・URL・有効フラグ、`Asset`/`ActiveAssetSet` エンティティ）
  は DynamoDB に保存されており（`src/lib/assets/asset-store.ts`）、§2 の DynamoDB 復元でカバーされる。
- **推奨フォローアップ**（本 Issue のスコープ外・別 Issue 化を推奨）: 将来 `/admin/assets` から
  バイナリを直接 S3 にアップロードする機能を追加する場合は、その時点で `AssetBucket` に
  `versioned: true` を追加し本書を更新する。現状はアップロード機能自体が無く
  （登録は URL 参照のみ）、バージョニングの実利は小さいため見送っている。

### 3.2 SSM 拠点設定（`siteConfigPrefix`）の再投入

`docs/deploy-aws.md`「デプロイ前に用意するもの」に基づき、拠点ごとの設定を再投入する
（Parameter Store 自体はスナップショット機構を持たないため、投入内容は運用者側で管理する
台帳・IaC 化を推奨）。

```bash
SITE_ID=site-001
SITE_CONFIG_PREFIX="/open-reception/${ENV}/sites"   # environments.ts の siteConfigPrefix と一致させる

aws ssm put-parameter \
  --name "${SITE_CONFIG_PREFIX}/${SITE_ID}" \
  --type String \
  --overwrite \
  --value '{"enabled":true,"defaultTarget":{"...":"..."},"voice":{"...":"..."}}' \
  --region "$REGION"

# 投入後の確認
aws ssm get-parameter --name "${SITE_CONFIG_PREFIX}/${SITE_ID}" --region "$REGION" \
  --query "Parameter.Value" --output text
```

> **運用推奨**: 障害復旧を速くするため、拠点設定 JSON は（機密を含まない範囲で）社内の
> 構成管理台帳やリポジトリ外の運用ドキュメントに正本を保持し、この `put-parameter` で
> 再投入できるようにしておく。本書では投入コマンドのみを定義する（値の正本管理は運用側の責務）。

### 3.3 Secrets Manager の再投入

`docs/deploy-aws.md` §5「方式 B」「通知サブシステム」で作成する 3 種類のシークレットが対象。
値自体（パスワード・HMAC 鍵・Vonage 接続情報）は Secrets Manager が保持し続ける限り消えないが、
**シークレットそのものを誤削除した場合**の再作成手順は次のとおり。

```bash
# 1) アプリ機密（方式 B, ADMIN_PASSWORD / ADMIN_SESSION_SECRET / KIOSK_SESSION_SECRET /
#    KIOSK_ENROLLMENT_SECRET 等）
aws secretsmanager create-secret --name "open-reception/${ENV}/app" \
  --secret-string '{"ADMIN_PASSWORD":"...","ADMIN_SESSION_SECRET":"...","KIOSK_SESSION_SECRET":"...","KIOSK_ENROLLMENT_SECRET":"..."}' \
  --region "$REGION"

# 2) 拠点トークン HMAC 鍵（必須。無いと通知 authorizer が全拒否）
aws secretsmanager create-secret --name "open-reception/${ENV}/site-token" \
  --secret-string '{"key":"<高エントロピーな値>"}' \
  --region "$REGION"

# 3) Vonage 接続情報（任意）
aws secretsmanager create-secret --name "open-reception/${ENV}/vonage" \
  --secret-string '{"endpoint":"...","token":"..."}' \
  --region "$REGION"
```

再作成後、`docs/deploy-aws.md` の手順で `-c appSecretsName=` /
`-c siteTokenSecretName=` / `-c vonageSecretName=` を指定して該当スタックを再デプロイし、
Lambda が新しいシークレット ARN を参照するようにする（シークレット名を変えずに再作成した場合は
再デプロイ不要なことが多いが、ARN が変わる= 新規作成のため念のため再デプロイして反映させる）。

> **KIOSK_ENROLLMENT_SECRET を忘れない**: `docs/deploy-aws.md` に明記の通り、未設定だと
> `/api/kiosk/enroll` が fail-closed で 500 になる。

## 4. 誤削除ガードの確認手順（DeletionProtection / `cdk destroy`）

本番環境の破壊的コマンドを実際に prod へ打つことはしない。**非破壊的な確認**で誤削除ガードが
有効であることを検証する。

### 4.1 設定値の確認（非破壊）

```bash
# DynamoDB の DeletionProtection が有効か（prod は true）
aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" \
  --query "Table.DeletionProtectionEnabled"

# デプロイ済み CloudFormation テンプレート上でも同様に確認
aws cloudformation get-template --stack-name "OpenReception-Web-${ENV}" --region "$REGION" \
  --query "TemplateBody.Resources.DataTable*.Properties.DeletionProtectionEnabled"

# S3 バケットの RemovalPolicy は prod=RETAIN（infra/lib/config/aws-helpers.ts の
# prodRemovalPolicy）。CFN 上は DeletionPolicy: Retain として現れる。
aws cloudformation get-template --stack-name "OpenReception-Web-${ENV}" --region "$REGION" \
  --query "TemplateBody.Resources.AssetBucket*.DeletionPolicy"
```

期待結果: prod では `DeletionProtectionEnabled=true`、`DeletionPolicy=Retain`。dev/staging の
DynamoDB は `DeletionProtectionEnabled=false`（staging は PITR のみ true）。

### 4.2 実際の削除拒否動作の確認（**dev でのみ実施**）

prod で実際に `cdk destroy` を試すことは行わない。ガードの実効性は dev で
`removalProtection` を一時的に有効化して確認する（本番相当の設定を再現）。

1. `infra/lib/config/environments.ts` の `dev.data.removalProtection` を一時的に `true` に
   変更（**このファイルはコード変更のため、実施はコード変更が許可されたトラック/PR で行う。
   本書は手順の定義のみ**）。
2. `cd infra && npx cdk deploy OpenReception-Web-dev -c env=dev` で反映。
3. `npx cdk destroy OpenReception-Web-dev -c env=dev` を実行し、DynamoDB テーブル削除で
   スタック削除が失敗すること（`DeletionProtection` によるブロック）を確認する。
4. 設定を `false` に戻し、通常どおり destroy できることを確認してから片付ける。

> 実施は #65（実 AWS 環境での検証が必要な作業のスタック先）に積む。手順のみ本書に定義済み。

## 5. dev 環境での復元演習手順

**実施自体は実 AWS 環境への操作（PITR 有効化・restore-table 実行・データ書き込み）を伴うため
承認が必要であり、#65 にスタックする。本書は演習の手順のみを定義し、実施結果は未記入とする。**

### 5.1 事前準備

1. dev は既定で PITR 無効（`environments.ts` の `dev.data.pointInTimeRecovery: false`）。
   演習のため一時的に有効化する:
   ```bash
   aws dynamodb update-continuous-backups \
     --table-name "$TABLE_NAME" --region ap-northeast-1 \
     --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
   ```
   （恒久的に有効化したい場合は `environments.ts` を変更して `cdk deploy` する方が望ましいが、
   演習単体なら上記の直接呼び出しで十分。PITR 有効化後、実際に復元可能になるまで最短でも
   数分〜のバッファが必要な点に留意する。）
2. `npm run seed:dynamodb` で既知の初期データを投入し、復元前の基準状態を作る。
3. 復元演習用に、意図的な「事故」を再現する（例: 特定の担当者データを削除する、または
   `TABLE_NAME=$TABLE_NAME npm run seed:dynamodb -- --with-mock` 実行前後の差分を事故とみなす）。
4. 事故発生時刻（UTC）を記録する。

### 5.2 復元実施

§2.2〜§2.4 の手順をそのまま dev の `TABLE_NAME` に対して実行する（`ENV=dev`）。

### 5.3 アプリ整合確認（受付フローが動作すること）

1. ローカル（またはデプロイ済み dev 環境）で、アプリの `TABLE_NAME` を復元先テーブル
   （`$RESTORE_TABLE`、または §2.5 方式 A 実施後は通常の `$TABLE_NAME`）に向ける。
   ```bash
   DATA_BACKEND=dynamodb TABLE_NAME="$RESTORE_TABLE" AWS_REGION=ap-northeast-1 npm run dev
   ```
2. `/admin` にログインし、部署・担当者・端末一覧が復元前の基準状態と一致することを確認する。
3. `/kiosk` から実際に受付フローを 1 件通し、担当者呼び出し・受付履歴（`/admin/receptions`）
   への記録・監査ログ（`/admin/audit`）への記録が正常に行われることを確認する。
4. 受付履歴の GSI1 経由アクセス（fallback 追記、`docs/persistence-design.md` §4.2）が壊れて
   いないか、可能なら fallback シナリオも 1 件通す。

### 5.4 後片付け

1. 演習用の一時テーブル（`$RESTORE_TABLE`）を削除する。
2. dev の PITR を演習前の状態（既定は無効）に戻す（恒久的に有効化しないと決めた場合）。
3. §6 に演習記録を記入する。

## 6. 演習記録

| 項目 | 内容 |
| --- | --- |
| 実施日時 | 未実施（#65） |
| 実施環境 | dev（予定） |
| 事故シナリオ | 未実施（#65） |
| 復元に用いた方式 | 未実施（#65） |
| PITR 有効化〜復元完了の所要時間（実測 RTO） | 未実施（#65） |
| データ損失範囲（実測 RPO） | 未実施（#65） |
| アプリ整合確認結果（§5.3） | 未実施（#65） |
| 手順の穴・改善点 | 未実施（#65） |
| 対応者 | 未実施（#65） |

演習完了後、本表を実測値で更新し、§1 の RPO/RTO 目標値との乖離があれば目標値または手順を
見直す。

## 7. 関連ドキュメント

- `docs/deploy-aws.md` — 通常デプロイ・機密注入・拠点設定/Secret 準備の一次情報。
- `docs/runbook.md` — アラーム対応・手動受付切替（データ復元を待たずに来訪者対応を継続する手段）。
- `docs/infrastructure-design.md` — インフラ全体構成。
- `docs/persistence-design.md` — DynamoDB シングルテーブルのキー設計・GSI・TTL。
- `infra/lib/config/environments.ts` / `infra/lib/stacks/web-stack.ts` — PITR/DeletionProtection/
  S3/Secrets 設定の実装（一次情報）。
