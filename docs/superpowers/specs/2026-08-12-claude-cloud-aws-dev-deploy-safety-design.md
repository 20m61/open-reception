# Claude Code on the cloud から AWS dev へ安全にデプロイする（設計）

2026-08-12 / 対象: `open-reception` / 状態: 設計承認済み・実装前

Claude Code on the cloud（クラウドセッション / cron routine）から、AWS の **dev 環境のみ**へ
`verify → preflight → diff → deploy → smoke` を実行できる安全境界を作る。

**開発速度より他プロジェクト・本番相当リソースの保護を優先する。**

---

## 1. なぜ今これをやるのか

`--pr` / `--full` の品質ゲートは既にクラウドが既定で、ローカル macOS より速く安定している
（`docs/cloud-dev-environment.md` §6）。**ローカル macOS に残っている作業は 2 つだけ**で、
そのうち 1 つが AWS デプロイである（もう 1 つは darwin VRT ベースラインで、これは
`{platform}` 込みのファイル名ゆえ原理的に移せない）。

本設計が完了すると、ローカル macOS に残る作業は **darwin VRT ベースラインと、
短命 credential の発行（「窓を開ける」操作）だけ**になる。

### 🔴 前提の訂正: 「対話型 SSO だから不可」は誤りだった

`CLAUDE.md` と `docs/cloud-dev-environment.md` §4 は「AWS デプロイはクラウド不可。
対話型 SSO がクラウドセッションで使えないため」としていた。**これは stale である。**

```
$ aws sts get-caller-identity
822063948773  arn:aws:iam::822063948773:user/CDK  AIDA36ZWUMPSTZBOYONU3
```

実体は SSO ではなく **IAM user + 静的アクセスキー**。技術的には今日でもキーを
クラウドへ渡せば動く。**やってはいけないのは、それが `AdministratorAccess` の
長期キーだから**であって、SSO だからではない。本設計はこの区別の上に立つ。

両ドキュメントの当該記述は本作業で訂正する。

---

## 2. 調査結果（2026-08-12 実測）

### 2.1 アカウントは open-reception 専用ではない

アカウント `822063948773` / ap-northeast-1 に **22 スタック・4 プロジェクトが同居**する。

| プロジェクト | スタック | 備考 |
| --- | --- | --- |
| open-reception | `OpenReception-Web-dev` / `-WebMonitoring-dev` | **dev のみ。staging / prod は未存在** |
| nodi | `nodi-dev-*` 4 / `nodi-staging-*` 4 | 別プロジェクト。NAT/VPCe/Aurora で月 $171 の主因 |
| salon-loop | `salon-loop-staging-*` 9 | 別プロジェクト。auth / data / Cognito を含む |
| Kiaff | `KiaffUploaderStack` | 別プロジェクト |
| （CDK） | `CDKToolkit` / `CDKToolkit-staging` | bootstrap |

**帰結**: 守るべき「production」は open-reception の prod（存在しない）ではなく、
**他プロジェクトの実リソース**である。脅威モデルの主対象をここに置く。

### 2.2 既定 bootstrap の CFN 実行ロールが AdministratorAccess

```
cdk-hnb659fds-cfn-exec-role-822063948773-{ap-northeast-1,us-east-1}
  → arn:aws:iam::aws:policy/AdministratorAccess
cdk-staging-cfn-exec-role-...
  → SalonLoopStagingCfnExecution / SalonLoopStagingCfnSupport   (salon-loop 専用)
```

`infra/cdk.json` は既定 qualifier `hnb659fds` を使う。**この qualifier は 4 プロジェクト共有**
であり、`cdk-hnb659fds-deploy-role-*` を assume できる主体は CloudFormation 経由で
アカウント内の任意の操作に到達できる。

**全 bootstrap ロールに Permissions Boundary は設定されていない**（`PermissionsBoundary: None`）。

salon-loop が `staging` qualifier + 専用 exec policy を切っているのは同じ問題への対処である。
本設計も同じ方向を取る（ただし内容はコピーせず open-reception の構成から決める）。

### 2.3 🔴 名前 prefix による allowlist は成立しない

`OpenReception-Web-dev` の実リソース物理名:

| リソース | 物理名 | prefix で絞れるか |
| --- | --- | --- |
| DynamoDB Table | `OpenReception-Web-dev-DataTable447BC44E-1441L2H6XF2FN` | ○ スタック名由来 |
| Lambda Function | `OpenReception-Web-dev-ServerFn4F3A536E-GkscOcXu7XJt` | ○ |
| CloudWatch Dashboard | `open-reception-dev-web` | ○（別綴り） |
| **S3 Bucket** | `openreception-web-dev-assetbucket1d025086-balywcsqpuj9` | △ **ハイフン無しの別綴り** |
| **IAM Policy** | `OpenR-Serve-E3jwlgROqB80` / `OpenR-Custo-BfgbXFf7qDuF` | ✗ **`OpenR-` へ切り詰め** |
| **Cognito UserPool** | `ap-northeast-1_wZxroIjKo` | ✗ **prefix 無し** |
| **CloudFront Dist** | `E3JHU0VUXEJJ0J` | ✗ **prefix 無し** |

spec 原文 §6 は「名前 prefix だけを唯一の security boundary として信用するな」と言うが、
open-reception の実構成では **Cognito / CloudFront / IAM Policy については信用する以前に
使えない**。この事実が §4 の設計を決める。

### 2.4 その他

- リージョンは **ap-northeast-1 と us-east-1 の 2 つ**（`OpenReception-CfMonitoring-*` が
  CloudFront メトリクスの制約で us-east-1。`bin/open-reception.ts:148`）
- 環境の切り替えは CDK context `-c env=dev|staging|prod` のみ。**アカウント分離も
  リージョン分離もしていない**（`infra/lib/config/environments.ts`）
- 全リソースに `Project` / `Environment` / `Owner` / `ManagedBy` タグを付与している
  （`BASE_TAGS`）。ABAC の材料として使える
- 既存 smoke 資産: `scripts/url-quality-gate.sh` / `scripts/e2e-live.sh`
- `cdk-hnb659fds-cfn-exec-role-*` の `MaxSessionDuration` は 3600（既定）

---

## 3. Threat model

信頼境界は **Claude Cloud サンドボックス**である。サンドボックス内で動くコードと、
そこに置かれた credential は「漏れうる」「意図しない使われ方をしうる」と仮定する。

| # | 脅威 | 本設計での封じ方 | 残存 |
| --- | --- | --- | --- |
| T1 | **他プロジェクト（nodi / salon-loop / Kiaff）の破壊** | スタック ARN allowlist（§4.2 層1）＋ 他プロジェクト名の明示 Deny（層3） | — |
| T2 | open-reception **prod / staging** への誤デプロイ | 同上。`OpenReception-*-dev` 以外のスタック ARN は Deny | prod は未存在。作成時に境界拡張の承認が要る |
| T3 | **`hnb659fds` / `staging` bootstrap 経由の権限昇格** | 専用 qualifier `orcloud01`。既定 qualifier ロールへの `sts:AssumeRole` を明示 Deny。trust policy 側でも弾かれる（**二重**） | — |
| T4 | **`iam:PassRole` 経由の昇格** | deploy role の PassRole 先は `cdk-orcloud01-cfn-exec-role-*` に限定。**exec role の PassRole は `iam:PassedToService` ＋ `aws:ResourceTag/Project`・`/Environment` で限定**（Important 4。旧実装は `Resource: "*"` の無条件 Allow で、テンプレートに `Role.fromRoleArn(<既存ロール>)` を足すだけで boundary の外へ出られた） | タグ条件が実 IAM でどう評価されるかは**未検証**。runbook 4b の 14〜16 |
| T5 | **CFN 実行ロール経由の昇格** | 専用 exec policy（AdministratorAccess を使わない）＋ Permissions Boundary | — |
| T6 | **Boundary 外し** | boundary 無し Role 作成 Deny / boundary の Put・Delete Deny / policy 版数変更 Deny | — |
| T7 | **credential 漏洩** | 短命 STS のみ（最大 12h、既定 4h）。長期キーをクラウドへ置かない。ExternalId 必須 | 窓の間は有効。境界が実質的な防御 |
| T8 | **Secrets / KMS の窃取** | **`secretsmanager:*` を全面 Deny。** `OpenReception-Web-dev` のリソース一覧に Secrets Manager は 1 つも無く（dev は `originVerifySecret` を context の生値で渡す運用。`bin/open-reception.ts:68`）、デプロイに不要だと実測で確認した。`kms:*` も CDK assets の SSE-S3 以外に不要 | dev が Secrets Manager を使い始めたら境界の拡張が要る（意図的に fail-closed） |
| T9 | **Route53 / ACM の変更** | 全面 Deny（human-only）。dev はカスタムドメイン未使用のため実害なし | staging/prod でドメインを使う際に再設計 |
| T10 | **DynamoDB / S3 のデータ破壊** | dev のみ。dev の DynamoDB は `pointInTimeRecovery: false` / `removalProtection: false`（`environments.ts:151`）＝**再構築前提**。他プロジェクトのテーブルは Deny | dev データは失いうる（許容） |
| T11 | **CloudFormation replacement / 削除** | dangerous diff gate（§6）で自動停止 | gate は自動 deploy を止めるだけ。人間が承認すれば通る |
| T12 | **deploy wrapper の迂回** | 迂回すると既定 qualifier を引き、trust policy で assume に失敗する＝**fail-closed** | wrapper を通さない `aws` 直叩きは境界内でのみ可能 |
| T13 | **環境判定ミス** | preflight が caller identity / account / region / qualifier / スタック名を全部検査。**1 つでも不一致なら停止** | — |
| T14 | **外部サービス credential（Vonage 等）漏洩** | Vonage secret は `NotificationStack` 側で、dev には未デプロイ。`secretsmanager` の allowlist に含めない | — |
| T15 | **`user/CDK` の Admin 静的キーそのもの** | **本設計のスコープ外（§10 で報告・停止）** | 🔴 残存 |

---

## 4. 設計

### 4.1 アイデンティティチェーン

```
[ローカル Mac・人間]
  user/CDK  (AdministratorAccess・既存・本設計では一切変更しない)
      │  sts:AssumeRole  --external-id <ExternalId>  --duration-seconds <窓>
      ▼
  role/OpenReceptionClaudeDeploy-dev                        ★新規
    trust      : arn:aws:iam::822063948773:user/CDK のみ / ExternalId 必須
    MaxSession : 43200 (12h) — 実際の発行は既定 4h
    権限        : (a) sts:AssumeRole → cdk-orcloud01-{deploy,file-publishing,
                      image-publishing}-role-*（**lookup-role は含めない。下記参照**）
                  (b) cloudformation:DescribeStacks → OpenReception-*-dev の 3 スタック
                  (c) cloudformation:DescribeChangeSet → changeSet/claude-gate-*
                  ※ (b)(c) は diff gate 自身（`run_diff_gate`）が呼ぶ読み取り。
                    これ以外は DenyEverythingElseOutsideTheChain の NotAction
                    （sts:AssumeRole / sts:GetCallerIdentity / 上記 2 つ）で全 Deny
    明示 Deny  : cdk-hnb659fds-* / cdk-staging-* / **cdk-*-lookup-role-*** への
                 sts:AssumeRole
      │  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN /
      │  AWS_REGION / AWS_CREDENTIAL_EXPIRATION
      ▼
[Claude Cloud サンドボックス]   scripts/aws-cloud-deploy.sh 経由でのみ cdk を実行
      │  cdk deploy -c env=dev -c @aws-cdk/core:bootstrapQualifier=orcloud01
      ▼
  role/cdk-orcloud01-deploy-role-822063948773-{ap-northeast-1,us-east-1}   ★新規
    cloudformation:*  →  arn:aws:cloudformation:*:822063948773:stack/OpenReception-*-dev/*
    iam:PassRole      →  cdk-orcloud01-cfn-exec-role-* のみ
      ▼
  role/cdk-orcloud01-cfn-exec-role-...                      ★新規
    policy   : OpenReceptionClaudeCfnExec-dev  (AdministratorAccess ではない)
    boundary : OpenReceptionClaudeBoundary     ← 自身にも、自身が作る Role にも
      ▼
  OpenReception-*-dev のリソースのみ
```

**qualifier は `orcloud01`（9 文字）**。既定の `hnb659fds` と同じ長さにしてある
（`cdk-<q>-file-publishing-role-<12桁account>-ap-northeast-1` が IAM ロール名上限 64 文字に
収まる必要があり、10 文字だと 63 文字で余裕が無いため）。
Toolkit スタック名は `CDKToolkit-orcloud01`。

> 🔴 **lookup role を entry role の allowlist に入れてはならない（2026-08-12 全体レビュー
> Critical 1）。** `cdk bootstrap` のテンプレート
> （`infra/node_modules/aws-cdk/lib/api/bootstrap/bootstrap-template.yaml:493-506`）は
> `cdk-<q>-lookup-role-*` に AWS 管理ポリシー **`ReadOnlyAccess`** を付け、インラインで
> Deny するのは `kms:Decrypt` **だけ**である。さらに `--custom-permissions-boundary` が
> Permissions Boundary を付けるのは `CloudFormationExecutionRole` **1 つだけ**
> （同ファイル 738-744 行目）なので、lookup role は層 4 の外側にいる。**entry role が
> これを assume できると、層 1（スタック ARN allowlist）も層 3（他プロジェクト Deny）も
> 一切通らずに、nodi / salon-loop / Kiaff の DynamoDB・S3 オブジェクト・全 Lambda の
> 環境変数・Cognito ユーザーをアカウント全体で読める。** 本設計の主境界を丸ごと迂回する。
>
> dev はこのロールを必要としない。`infra/` 全体で context provider を呼ぶ箇所は
> `infra/lib/stacks/web-stack.ts` の `route53.HostedZone.fromLookup` **1 箇所のみ**で、
> `customDomain?.createDnsRecord` が真のときだけ実行される。`customDomain` は
> `-c customDomain=...` からしか来ず、dev のデプロイ経路（`scripts/aws-cloud-deploy.sh`）は
> これを渡さない。よって allowlist から外し、`DenyBootstrapLookupRole` で明示 Deny も
> 重ねてある（allowlist へ誤って戻されても Deny が勝つ）。検証は N9（live）と
> `aws-policy-shape.test.ts` の 2 本、および runbook ステップ 4b-13。

**専用 qualifier が必須である理由**: `hnb659fds` は 4 プロジェクト共有かつ
cfn-exec-role が `AdministratorAccess`。ここへ到達できると CloudFormation 経由で
アカウント全体に届く。専用 qualifier は assets バケット・trust・exec policy が
すべて分離される。加えて、**wrapper を迂回して素の `cdk deploy` を打っても
既定 qualifier のロールを assume できずに失敗する**（fail-closed）。

### 4.2 権限境界は 4 層。主境界は「名前」ではなく「スタック ARN」

§2.3 のとおり Cognito / CloudFront / IAM Policy は名前で絞れない。よって
**allowlist は自分の名前ではなく CloudFormation スタック ARN で書き、
denylist は他プロジェクトの名前で書く**（境界の向きを反転させる）。

#### 層 1（主境界）: deploy role の CloudFormation スタック ARN allowlist

CDK の全操作は CloudFormation を通る。deploy role の
`cloudformation:CreateChangeSet` / `ExecuteChangeSet` / `DescribeStacks` /
`DeleteStack` 等を

```
arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/*
arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-WebMonitoring-dev/*
arn:aws:cloudformation:us-east-1:822063948773:stack/OpenReception-CfMonitoring-dev/*
arn:aws:cloudformation:ap-northeast-1:822063948773:stack/CDKToolkit-orcloud01/*
arn:aws:cloudformation:us-east-1:822063948773:stack/CDKToolkit-orcloud01/*
arn:aws:cloudformation:ap-northeast-1:822063948773:changeSet/claude-gate-*/*
arn:aws:cloudformation:us-east-1:822063948773:changeSet/claude-gate-*/*
```

（**これは `claude-deploy-role-restriction.json` の `NotResource` の全 7 行そのままである。**
スタックは `OpenReception-*-dev` のようなワイルドカードではなく**3 つを実名で、
それぞれ所属リージョンにピン留めして**列挙する ―― `CfMonitoring-dev` は us-east-1
にしか無いので、`OpenReception-*-dev` を両リージョンに書くと存在しない組み合わせまで
許可することになる。許可リスト側のワイルドカードは「広すぎる」方向に壊れるため、
`aws-policy-shape.test.ts` が各エントリの形を正規表現で固定している。
唯一の `*` は changeSet 名の `claude-gate-*` で、これは changeSet ARN が
スタック名を埋め込まないという IAM 側の制約による ―― その残存ギャップは §13。）

に限定する。**これが迂回不能な主境界。** 名前 prefix ではなく ARN パターンであり、
CloudFormation スタック名は CDK が `bin/open-reception.ts` で決定論的に付ける
（`OpenReception-<Stack>-<env>`）ため信頼できる。

> 🔴 **`DescribeChangeSet` / `ExecuteChangeSet` / `DeleteChangeSet` は stack ではなく
> changeSet リソースタイプで認可される。** AWS Service Authorization Reference 上、この
> 3 アクションは `arn:aws:cloudformation:<region>:<acct>:changeSet/<name>/<id>` という
> **changeSet ARN**（スタック名を埋め込まない）に対して認可される。stack ARN で認可
> されるのは `CreateChangeSet` / `DescribeStacks` 等のみ。当初の実装はこれを見落としており、
> `claude-deploy-entry.json`（diff gate 自身が呼ぶ `describe-change-set`）が構造的に
> Deny され続け、`claude-deploy-role-restriction.json` の `NotResource`（stack ARN のみの
> allowlist）が `Deny cloudformation:*` で changeset 系アクションまで巻き添えにして
> **`cdk deploy` 自体が動かない**状態になっていた。changeSet ARN は stack 名を含まないため、
> stack 単位では絞れず、**名前**（`claude-gate-*`）でスコープする。`claude-deploy-entry.json`
> は `ReadOwnChangeSetsForDiffGate` として `DescribeChangeSet` を `changeSet/claude-gate-*/*`
> に限定し、`claude-deploy-role-restriction.json` の `NotResource` にも同じパターンを
> 追加してある。この名前スコープが生む残存ギャップは §13 を参照。

> 🔴 **gate が承認した change set と、実際に実行される change set は別物である。**
> `scripts/aws-cloud-deploy.sh` の `diff` と `deploy` は同じ change set 名
> （`claude-gate-<short-sha>`）を使うが、これは「同じ change set オブジェクトを承認して
> 実行する」ことを保証するためではない。CDK（`infra/node_modules/aws-cdk/lib/index.js` の
> `createChangeSetAndCleanup()`）は、指定した名前の change set が既に存在すれば
> `cleanupOldChangeset()` → `cfn.deleteChangeSet()` で**無条件に削除してから**
> `cfn.createChangeSet()` で新しく作り直す。「既存の named change set を再利用する」という
> 経路は CDK の実装に存在しない。**したがって `deploy` の `cdk deploy --change-set-name X`
> は、`diff` が承認したのと同じ名前 `X` の change set を必ず削除して作り直す。** 同じ名前を
> 使う理由は、changeSet ARN が stack 名を埋め込まないため IAM 側が名前でしかスコープできず、
> 名前を固定しないと上記の changeSet ARN allowlist 自体が機能しないからである。ワーキング
> ツリーが gate 通過後に変わっていなければ内容は同一のはずだが、それを保証する仕組みはない。

#### 層 2: exec role の resource 制限（ARN + タグ）

exec role の resource スコープが広くならざるを得ないサービス（Cognito / CloudFront /
IAM Policy）については、**層 1 と層 4 の組み合わせで担保する**:

- exec role を assume できるのは `cloudformation.amazonaws.com` のみ（trust policy）
- exec role を **pass できるのは deploy role だけ**（層 4 / T4）
- deploy role が pass できるのは **層 1 の allowlist に入るスタック操作のとき**だけ

したがって「exec role が `cloudfront:DeleteDistribution` を resource `*` で持つ」ことは、
**`OpenReception-*-dev` スタックのテンプレートがそれを要求したときにしか行使されない**。
これが安全性の主論拠である。ARN / `aws:ResourceTag` で絞れるサービス
（DynamoDB / Lambda / S3 / Logs / SNS / CloudWatch）は絞る。

> 🔴 **この論拠を `iam:PassRole` に適用してはいけなかった（2026-08-12 全体レビュー
> Important 4）。** 「テンプレートが要求したときにしか行使されない」が安全と言えるのは、
> テンプレートが信頼できるときだけである。**そのテンプレートを書くのは、脅威モデル
> （§3）が侵害を仮定している当のサンドボックス自身**であり、`iam:PassRole` は他の広い
> grant と違って**境界そのものを外せる**: `lambda.Function` に
> `Role.fromRoleArn('<lambda.amazonaws.com を信頼する既存のアカウント内ロール>')` を渡せば、
> その Lambda は Permissions Boundary の**外**で動く。change set 上は
> `AWS::Lambda::Function` の `Add`（§6 の `SAFE_ACTION`）にしか見えず、gate は止めも
> 記録もしない。
>
> よって `claude-cfn-exec.json` / `claude-boundary.json` の `iam:PassRole` は
> `Resource: "*"` の無条件 Allow をやめ、
> `iam:PassedToService`（dev が実際に必要とする `lambda.amazonaws.com` のみ）＋
> `aws:ResourceTag/Project` = `open-reception` ＋ `aws:ResourceTag/Environment` = `dev`
> の 3 条件（AND）に絞った。タグは `applyCostTags` が `Tags.of(stack)` で全 taggable
> リソースへ付与しており、**IAM Role に実際に付くことは
> `infra/test/claude-deploy-boundary.test.ts` の synth テストで確認済み**。
> ただし **IAM がこの条件をどう評価するかは未検証**であり、初回デプロイで
> AccessDenied になる最有力候補である（runbook ステップ 4b の 14〜16 で人間が確認する）。

#### 層 3: 他プロジェクトへの明示 Deny（列挙可能で安定）

「自分の名前を allow」より「他人の名前を deny」の方が信頼できる（§2.3）。
Deny は Allow に優先するため、層 1・2 に穴があってもここで止まる。

```
nodi-*  /  salon-loop-*  /  Kiaff*  /  CDKToolkit  /  CDKToolkit-staging
cdk-hnb659fds-*  /  cdk-staging-*
OpenReception-*-staging  /  OpenReception-*-prod
```

対象: `cloudformation:*` のスタック ARN、`sts:AssumeRole` のロール ARN、
`secretsmanager:*` / `dynamodb:*` / `s3:*` の該当 ARN。

#### 層 4: Permissions Boundary（IAM 脱出の封鎖）

`OpenReceptionClaudeBoundary` を **exec role 自身**に付け、かつ
**exec role が作る全 Role に boundary の付与を強制**する。

> 🔴 **`cdk bootstrap --custom-permissions-boundary` だけでは層 4 は成立しない
> （2026-08-12 全体レビュー Critical 2）。**
>
> bootstrap テンプレートで `PermissionsBoundary` プロパティを持つのは
> `CloudFormationExecutionRole` **1 リソースだけ**である
> （`infra/node_modules/aws-cdk/lib/api/bootstrap/bootstrap-template.yaml` の
> `CloudFormationExecutionRole.Properties.PermissionsBoundary`）。**CDK アプリが
> 作る Role には何も付かない** —— `infra/` に `PermissionsBoundary.of(...)` は無く、
> `infra/cdk.json` にも `@aws-cdk/core:permissionsBoundary` は無かった。
>
> 一方 `claude-boundary.json` / `claude-cfn-exec.json` は
> `iam:CreateRole` / `PutRolePolicy` / `AttachRolePolicy` を boundary 条件付きでしか
> 許さず、`StringNotEquals`（キー欠如時に真）で明示 Deny する。したがって
> **runbook ステップ 10 の初回デプロイは必ず AccessDenied になる**:
> `OpenReception-CfMonitoring-dev` は新規 CREATE であり、`crossRegionReferences: true`
> が custom resource Lambda ＋ `AWS::IAM::Role` を持ち込むため、CloudFormation が
> boundary 無しで `iam:CreateRole` を呼ぶ。これは同時に、**§6 で IAM の Add/Modify を
> 止めない根拠（「新しい Role は構造的に boundary を超えられない」）が成立していなかった**
> ことを意味する。
>
> **対処**: `infra/lib/config/claude-deploy-boundary.ts` の
> `applyClaudeDeployBoundary(app)` を `bin/open-reception.ts` の先頭（Stack 構築前）で
> 呼び、`-c claudeBoundary=OpenReceptionClaudeBoundary` が渡されたときだけ
> App 配下の全 Role / User へ boundary を強制する。`scripts/aws-cloud-deploy.sh` は
> **全 `cdk` 呼び出し**（diff / deploy 双方）でこの context を渡す。
>
> **`-c '@aws-cdk/core:permissionsBoundary={"name":"..."}'` は使えない。** CDK CLI の
> `parseStringContextListToObject` は `-c key=value` の value を JSON へパースせず
> **生の文字列**のまま context に入れる。`Stack.permissionsBoundaryArn` は
> `context.arn` / `context.name` を**プロパティとして**読むので、文字列だと両方
> `undefined` になり、**警告もエラーも出さない完全な no-op** になる。
> `infra/test/claude-deploy-boundary.test.ts` がこの罠を回帰テストとして固定している。
>
> **無条件には適用しない。** boundary は「天井」であり、`claude-boundary.json` が
> Allow していないサービスは、そのロールの identity policy が許可していても実行時に
> 効かない。無条件に適用すると人間の staging / prod デプロイでアプリのロールに
> この天井が掛かり、`secretsmanager:*`（`appSecretsName` / `providerSecretBackend`）が
> 壊れる。dev の Claude 経路だけが context を渡す。
>
> **天井が広がった 1 点**: dev の server Lambda は `ce:GetCostAndUsage` /
> `ce:GetCostForecast` を持つ（`infra/lib/constructs/cost-explorer-access.ts`、#377）。
> boundary がアプリロールにも掛かるようになったため、この 2 つを boundary の Allow へ
> 追加した（`AllowDevRuntimeCostExplorerReads`）。read-only であり、boundary は天井
> なので**これ自体は誰にも権限を与えない**。`aws-policy-shape.test.ts` が固定している。

**明示 Deny ステートメントとして出荷しているもの**（Sid は `claude-boundary.json`）:

- `DenyRoleCreationWithoutThisBoundary`: `iam:CreateRole` / `PutRolePolicy` /
  `AttachRolePolicy` で `iam:PermissionsBoundary` condition が
  `OpenReceptionClaudeBoundary` でないもの（下記 carve-out を `NotResource` で除外）
- `DenyBoundaryEscape`: `iam:DeleteRolePermissionsBoundary` / `PutRolePermissionsBoundary`
- `DenyTamperingWithTheBoundaryPolicyItself`: boundary 自身
  （`policy/OpenReceptionClaudeBoundary`）への `CreatePolicyVersion` / `DeletePolicy` /
  `DeletePolicyVersion` / `SetDefaultPolicyVersion`
- `DenySharedBootstrapRoles`: `cdk-hnb659fds-*` / `cdk-staging-*` への
  `sts:AssumeRole` / `iam:PassRole`
- `DenySharedDnsAndCertificates`: `route53:*` / `acm:*` / `route53domains:*`（全面。human-only）
- `DenyPrincipalCreationAndOrgChanges`: `organizations:*` / `account:*` /
  `iam:CreateUser` / `iam:CreateAccessKey` / `iam:CreateLoginProfile` /
  `iam:UpdateAssumeRolePolicy`
- `DenySecretsAndKeyDestruction`: `secretsmanager:*` / `kms:ScheduleKeyDeletion` /
  `kms:DisableKey` / `kms:PutKeyPolicy`

> 🔴 **かつてこの節は、出荷していない 2 つの Deny を「Deny するもの」として挙げていた
> （2026-08-12 残件レビュー R7）。** 実装と読み合わせて訂正する。効果は別の仕組みで
> 得ているので、その仕組みを書く。
>
> - **「`arn:aws:iam::aws:policy/AdministratorAccess` 等の広域 policy の attach」**:
>   policy ARN を指定して Deny するステートメントは**無い**。効果は
>   「`iam:AttachRolePolicy` は boundary 付きのロールにしか行えない」ことから来る ——
>   boundary は**天井**なので、AdministratorAccess を attach しても実効権限は
>   `claude-boundary.json` の Allow を超えない。加えて `DenyIamWriteOnForeignPrincipals`
>   が他プロジェクト・自分のチェーンのロールへの attach を名前で塞ぐ。
>   **この論法が成立しないのは carve-out されたロールだけである**（下記・§13）。
> - **「鎖の外への `iam:PassRole` / `sts:AssumeRole`」**: 「鎖の外」を一般に表す Deny は
>   **無い**（そのようなステートメントは書けない ―― 「鎖」は ARN の集合として
>   列挙できない）。実際に効いているのは 3 つ: `DenySharedBootstrapRoles`（共有 bootstrap
>   の 2 系統）、`AllowPassRoleOnlyToTaggedDevWorkloads` の 3 条件 AND
>   （`iam:PassedToService` = `lambda.amazonaws.com` ＋ `Project`/`Environment` タグ）、
>   そして exec role の trust policy（`cloudformation.amazonaws.com` のみが assume 可）。
>   **タグの付かないロールへは、そもそも Allow が成立しないので PassRole できない**
>   ―― Deny ではなく「Allow が無い」ことで塞いでいる。

##### carve-out: CDK custom-resource provider role（#680 R1/R2/R3）

`iam:CreateRole` / `PutRolePolicy` / `AttachRolePolicy` の boundary 強制と、
`DenyIamRoleWriteOutsideProject` のタグ条件には、**1 つだけ名前による例外**がある:

```
arn:aws:iam::822063948773:role/OpenReception-*-dev-Custom*
```

理由。CDK の `CustomResourceProvider`（`crossRegionReferences: true` と
`autoDeleteObjects: true` が使う）は、`iam.Role` construct ではなく**生の
`AWS::IAM::Role`** をテンプレートへ吐く。したがって

- `ITaggable` ではない → `Tags.of()`（`applyCostTags`）が届かず `Project`/`Environment`
  タグが**付かない**
- cross-region の 2 本は `prepareApp`（`app.synth()` の内側）で materialise される →
  `Stack.addPermissionsBoundaryAspect()` の Aspect が走った**後**に生えるので
  `PermissionsBoundary` も**付かない**

dev で実際に生えるのは 3 本（`infra/test/claude-deploy-boundary.test.ts` が synth で実測）:

| ロール | boundary | Project/Environment |
| --- | --- | --- |
| `CustomS3AutoDeleteObjects…`（Web-dev） | **付く** | 付かない |
| `CustomCrossRegionExportWriter…`（Web-dev） | 付かない | 付かない |
| `CustomCrossRegionExportReader…`（CfMonitoring-dev / us-east-1） | 付かない | 付かない |

carve-out が無いと初回デプロイはこう壊れる: `iam:CreateRole` が
`DenyRoleCreationWithoutBoundary` に当たり AccessDenied → rollback →
rollback の `iam:DeleteRole` がタグ条件 Deny に当たって **`ROLLBACK_FAILED`**。
さらに provider Lambda への `iam:PassRole` もタグ条件で Deny される。

**Deny は Allow に勝つ**ので、Allow を足すだけでは解けない。該当の 2 つの Deny は
`Resource` を `NotResource` へ変えて carve-out を除外してある。

**なぜこのパターンか（より狭いものを選ばなかった理由）。** CloudFormation の生成名は
`<スタック名>-<論理 ID を 64 文字に収まるまで切り詰めたもの>-<12 文字の乱数>` で、
切り詰め量が**スタック名の長さで変わる**。実在する 2 本
（`OpenReception-Web-dev-CustomCrossRegionExportWriter-mWjZeIPYdVgw` /
`OpenReception-Web-dev-CustomS3AutoDeleteObjectsCust-yIrNw85NvcWP`、どちらもちょうど
64 文字）から、`OpenReception-Web-dev` では論理 ID の取り分が 29 文字、
`OpenReception-CfMonitoring-dev` では 20 文字と求まる。したがって

- `…-Custom*CustomResourceProviderRole*` は**どの 1 本にも一致しない**
  （`CustomResourceProviderRole` は切り詰めで消える）
- `…-CustomCrossRegionExport*` は us-east-1 の Reader に一致しない
  （そこでは `CustomCrossRegionExp` で切れる）

3 本すべてに当たり、かつスタック名の長さに依存しないのは `Custom` の 6 文字だけである。
名前の導出は `src/domain/governance/cfn-generated-name.ts`（実在名 2 本を ground truth に
テストで固定）、パターンとの照合は `infra/test/claude-deploy-boundary.test.ts` が
**出荷 JSON からパターンを読んで** synth 結果に当てている。
残存リスクは §13。

> 🔴 **実装上の注意: boundary 条件は専用ステートメントに分離し、素の `StringEquals` を使う。**
> `claude-boundary.json` と `claude-cfn-exec.json` は、`iam:CreateRole` / `PutRolePolicy` /
> `AttachRolePolicy` を `lambda:*` 等を含む大きな `Allow` から分離した専用ステートメント
> `AllowRoleMutationOnlyWithBoundary` として持ち、`Condition: { StringEquals: {
> "iam:PermissionsBoundary": "arn:...:policy/OpenReceptionClaudeBoundary" } }` で要求する。
> 当初案はこの 3 アクションを他の 30 アクションと同じ Allow に束ねていたが、そのままだと
> boundary 条件を掛けた瞬間に無関係な全アクションを巻き添えにする。また
> `StringEqualsIfExists` での代用は**キー欠如時に無条件で true を返す**ため、boundary
> パラメータ無しの `iam:CreateRole` 呼び出しをすり抜けさせてしまい、lint だけ緑になって
> 実効しない（実際に一度この形で実装され、レビューで差し戻した）。
> `src/domain/governance/aws-policy-shape.ts` の `hasBoundaryCondition` は、演算子名が
> `ifexists` で終わるもの、および `Null` 演算子（`{ Null: { "iam:PermissionsBoundary":
> "true" } }` で「このキーが存在しないこと」を主張できてしまう）を boundary 条件として
> **認めない**ことで、この種の実効性の無い条件を機械的に検出する。

---

## 5. deploy wrapper

`scripts/aws-cloud-deploy.sh <preflight|verify|diff|deploy|smoke>`。
**クラウドから素の `cdk deploy` を打たない**（打っても §4.1 の fail-closed で失敗する）。

### preflight が検査するもの（1 つでも不一致なら非ゼロ終了）

| 検査 | 期待値 |
| --- | --- |
| caller identity | `.../OpenReceptionClaudeDeploy-dev/*` の assumed-role |
| account | `822063948773` |
| region | `ap-northeast-1`（us-east-1 スタックは CDK が処理） |
| qualifier | `orcloud01` |
| credential 残時間 | > 20 分（`deploy` は > 40 分） |
| working tree | clean |
| branch / commit | 現在の HEAD が push 済みであること（`headCommitPushed`。`git branch -r --contains HEAD` で判定し、**ネットワークへは出ない**） |
| 環境 | `-c env=dev` 以外を拒否 |
| 品質ゲート | 現ツリーに対する green スタンプ（既存 `pr-gate-guard.sh` と同じ記録を読む） |
| negative tests | 全 PASS（§7） |

> 🔴 **`branch / commit` は Minor 9（2026-08-12 全体レビュー）まで、この表にあるだけで
> 実装が無かった。** `DEFAULT_PREFLIGHT_REQUIREMENT` にも `collect_observation` にも
> 対応する項目が存在しなかった。**削除ではなく実装した**: 無人デプロイでは
> 「dev に何が載っているか」が後から復元できなければならず、`workingTreeClean` は
> 「ツリーとコミットが一致している」ことしか言わず、gate スタンプは**ツリーの指紋**に
> 紐づくのでコミットを特定しない。両方 green でもローカルにしか無い commit をデプロイでき、
> サンドボックスが消えれば追跡不能になる。
>
> 判定はローカルの remote-tracking ref だけで行う（`git fetch` は preflight に外部依存と
> 新しい失敗モードを持ち込む）。ref が古い場合の誤りは「push 済みなのに未 push と言う」
> 方向＝fail-closed で、対処は `git push` を打つだけである。
>
> 🔴 **`品質ゲート` のスタンプは `verify` だけが書く。** スタンプは
> `git rev-parse --absolute-git-dir` の下（`.git` 配下）のローカルファイルで、
> **clone にも push にも付いてこない**。fresh なクラウドサンドボックスでは
> `verify` を先に走らせない限り preflight は必ず落ちる（§12 / Important 7）。

### 各サブコマンド

- `verify` … 既存 `./scripts/quality-gate.sh --pr` ＋ `npm run build:open-next`
  （🔴 #677 で「`record-gate-run.sh` が `build:open-next` を呼んでおらず infra synth が
  SKIP=FAIL になる」既知不具合があるため、ここでは明示的に呼ぶ）
- `diff` … `cdk diff` ではなく **change set を作って JSON で取得**し、§6 の gate に掛ける
- `deploy` … gate PASS のときのみ `cdk deploy`。gate NG なら非ゼロ終了して PR にリスクを記録

> 🔴 **`cdk` 呼び出しは全部 `--require-approval never` を渡す（2026-08-12 全体レビュー
> Important 6 / ADR 決定 5）。** CDK CLI の既定は `broadening`
> （`options.requireApproval ?? RequireApproval.BROADENING`）で、TTY の無いクラウド
> サンドボックスでは権限が広がる差分に当たった瞬間 `TtyNotAttached` を投げる。しかも
> 投げる**前**に `cleanupChangeSet()` を呼び、**gate が判定に使う change set を削除する**。
> §6 の判定（および ADR 決定 4）は Lambda 権限変更のたびに IAM の Add/Modify が出ることを
> 前提にしており、つまり broadening は例外ではなく**通常運用**である。
> 承認者は CDK の対話プロンプトではなく `run_diff_gate`（§6）であり、そちらの方が厳しい。
> `tests/hooks/aws-cloud-deploy.test.ts` が「全 `cdk` 呼び出しが `never` を渡すこと」と
> 「`deploy` ケースが `cdk deploy` の**前**に gate を通すこと」を対で固定している
> （gate を外して `never` だけが残る、という失敗を防ぐ）。
- `smoke` … 既存 `scripts/url-quality-gate.sh` と `scripts/e2e-live.sh` を呼ぶ（新規作成しない）

---

## 6. Dangerous diff gate

**`cdk diff` のテキストを parse しない。** 取りこぼす。
`cloudformation describe-change-set` の JSON を判定する。

停止条件（`src/domain/governance/deploy-diff-gate.ts` の純関数として実装し、unit テストで固定。
`scripts/aws-diff-gate.ts` は上記を呼ぶ薄い CLI）:

**停止（deploy させない）**

| 条件 | 理由 |
| --- | --- |
| スタック名が `OpenReception-<Stack>-dev` 以外 | 環境判定ミス |
| `Action: Remove` | リソース削除（Cognito UserPool / DynamoDB Table / CloudFront Distribution はここで捕まる） |
| `Action` が `Add` / `Modify` / `Remove` のいずれでもない（`Import` / `Dynamic` / 将来 AWS が増やす値） | 🔴 実装は `SAFE_ACTIONS = {'Add', 'Modify'}` の**許可リスト**で判定しており、`Remove` は上の行、それ以外の未知の値はこの行（`unknownAction`）で止める。CloudFormation の `Dynamic` は実行時まで影響が確定しないため、未知の action を安全側（見逃す方向）に倒すと、無人デプロイを認可するはずの gate が向きとして逆になる |
| `Replacement: True` または `Conditional` | 再作成＝データ消失・ダウンタイム |
| `AWS::KMS::*` / `AWS::SecretsManager::*` の任意の操作 | dev には現状 1 つも無い（§2.3 の実測）。**出現すること自体が想定外** |
| `AWS::Route53::*` / `AWS::CertificateManager::*` の任意の操作 | 共有 DNS / 証明書。human-only |
| `AWS::EC2::SecurityGroup*` の任意の操作 | ネットワーク境界 |
| `AWS::IAM::User` / `AccessKey` / `Group` / `LoginProfile` の任意の操作 | dev スタックが IAM プリンシパルを作る正当な理由が無い |
| carve-out の名前空間に入る `AWS::IAM::Role` で、既知の provider role 3 本以外（`carveOutRoleNamespace`。#680 R10） | **この名前空間には boundary が掛からない。** 物理名は生成名・`RoleName`・`Path` を IAM と同じ規則で組んで判定する（ARN グロブの `*` は `/` を跨ぐ） |
| 既知 3 本を名乗るが実体が CDK の生成する形と違う（`carveOutRoleShape`） | 論理 ID はテンプレート側が決められる。trust の Principal は `lambda.amazonaws.com` のみ／trust の Action は `sts:AssumeRole` のみ／managed policy は基本実行ロールのみ／action は **synth で実測した 6 つの `ssm:` アクションの許可リスト**（否認リストでは `iam*` `*:*` `*:CreateRole` がすり抜ける）／`Resource` は実測どおり `parameter/cdk/exports/` の下に閉じていること（`*` も `parameter/*` も停止。`ssm:DeleteParameters` on `*` はアカウント全体の SSM を静かに消せる）。**Add だけでなく Modify も見る** |
| `AWS::IAM::Policy` / `ManagedPolicy` / `RolePolicy` が carve-out のロールへ許可リスト外の action / Resource を付ける（`carveOutRoleShape`） | 権限はロールの `Properties` 以外からも届く。IAM 側は carve-out ARN への `iam:PutRolePolicy` / `AttachRolePolicy` を無条件に許しているので、**ここを見ないとインラインを 1 つ左のリソースへ移すだけで迂回できる**。付与先が静的に決まらなければ通さない |
| 外部アカウント／`"AWS":"*"`／`Federated` を信頼する trust policy（`roleTrustPolicyEscape`） | IAM に trust policy を縛る条件キーが無く、boundary も効かない。**デプロイ窓を越えて残る** |
| WebStack の 2 本以外の `AWS::Lambda::Url`、`TargetFunctionArn` が期待した関数を指さないもの、および image URL の `AuthType != AWS_IAM`（`functionUrlExposure`） | 公開 HTTPS の入口は資格情報の失効を越えて残る。image を `NONE` にすると無認証・無検証になる (#631)。**初回デプロイでは全リソースが `Add`** なので、allowlist の論理 ID を本物の `ServerFn` / `ImageFn` へ結び付けるものは向き先の固定しかない |
| 未知の `Principal:"*"` invoke 許可（向き先違いを含む）・別アカウントへの invoke 許可・**source 条件がこのアカウントを名指ししないサービスプリンシパル宛の許可**（`publicInvokePermission`） | リソースポリシーとして残り、失効後も外から呼べる。`SourceAccount` / `SourceArn` の無い `apigateway.amazonaws.com` は別アカウントの API から呼べる |
| 上記の判定に必要な synth テンプレートを読めない（`opaqueResourceShape`） | **読めなかったを問題なしに落とさない** |

🔴 **上の 6 行のために、gate は change set だけでなく synth テンプレート
（`infra/cdk.out/<stack>.template.json`）も入力に取る（必須。#680 R10）。**
`describe-change-set` は「どの property が変わったか」の**名前**しか返さず値を返さないので、
`RoleName` / `Path` / `AssumeRolePolicyDocument` / `Principal` / `AuthType` は
テンプレートからしか読めない。optional にすると「渡し忘れ = 検査なしで green」という
最悪の既定になるため、CLI はテンプレートを読めなければ非ゼロで終わる。

**記録のみ（deploy は進める）**

| 条件 | なぜ止めないか |
| --- | --- |
| carve-out の**外**の `AWS::IAM::Role` / `Policy` / `ManagedPolicy` / `RolePolicy` の Add・Modify（`iamPolicyChange`） | boundary が強制される（下記）。**内／外の区別は実装にある**（2026-08-13）—— `Policy` 系は `Roles` / `RoleName` を解決し、carve-out に入るものだけ停止側へ回す。解決できないものは停止 |
| trust policy が組み込み関数で静的に読み切れない（`opaqueRoleTrustPolicy`。carve-out の外のみ） | CDK は自アカウントの ARN を `Fn::Join` で組む。ここを止めると正当な初回デプロイが通らない。**代わりに 4d の人間へ必ず見せる** |

> 🔴 **ここは意図的に spec 原文 §8 の「IAM を検出したら停止」より緩めている。**
> `OpenReception-Web-dev` は IAM Role 4 個・Policy 3 個を含み、Lambda の権限が変わるたびに
> Modify が出る。一律停止にすると **gate が恒常的に赤くなり、赤を無視する習慣がつく**
> 方が危険（`change-risk.ts` が report-only である理由と同じ判断）。
>
> 止めなくてよい根拠は **§4.2 層 4 の Permissions Boundary**にある。exec role が作る
> Role には boundary が強制されるので、**新しい Role が boundary を超える権限を持つことは
> 構造的に不可能**。差分レビューより強い保証である。Remove / Replace は上表で止まる。
>
> 🔴 **この根拠は carve-out の名前空間には及ばない（#680 R10）。** そこには boundary が
> 掛からないので「差分レビューより強い保証」が存在しない。だから carve-out に入る
> ロールだけは、記録ではなく**停止**にしてある（上表の `carveOutRoleNamespace` /
> `carveOutRoleShape`）。**その名前空間に入るかどうかは名前を眺めても分からない** ——
> IAM のリソース ARN グロブでは `*` が `/` を跨ぐので、`Path` を細工すれば
> 論理 ID が何であれ入る。判定は `iamArnGlobMatchesGeneratedName` が IAM と同じ規則で行う。
>
> 🔴 **この根拠は 2026-08-12 全体レビュー（Critical 2）の時点では成立していなかった。**
> `--custom-permissions-boundary` は cfn-exec role 1 つにしか boundary を付けず、
> CDK アプリが作る Role には何も付いていなかった。`applyClaudeDeployBoundary` を
> 配線して初めて真になる。§4.2 層 4 の注記を参照。
>
> 🔴 **`iam:PassRole` の穴も同レビューで塞いだ（Important 4）。** boundary を強制しても、
> テンプレートが `Role.fromRoleArn('<既存の別ロール>')` を Lambda に渡せば、その Lambda は
> boundary の外で動く。change set 上は `AWS::Lambda::Function` の `Add`（＝`SAFE_ACTION`）
> にしか見えず、gate は止めも記録もしない。よって `iam:PassRole` 側を
> `iam:PassedToService` ＋ `aws:ResourceTag/Project` ＋ `aws:ResourceTag/Environment`
> で絞ってある（§4.2 層 2）。
>
> この判断に同意できない場合は `DEPLOY_BLOCK_RULES` の 1 行で停止側へ移せる。

`Replacement: Conditional` は停止側に倒す（**実行時条件で決まるものは「安全である」と
証明できないため、指摘する側に倒す**。`orphan_branch` 検出で同じ判断をした前例がある）。

停止したときは **黙って終わらない**。gate の判定内容を PR コメント/記録に残して
非ゼロ終了する（#656 の型: 何もせず正常終了するのが最悪）。

---

## 7. Negative security tests

`scripts/aws-negative-tests.ts`。**preflight から必ず呼ぶ**
（`scripts/check-script-wiring.ts` が「作っただけで誰も呼ばない」状態を検出する既存の
仕組みに載せる — #656 / PR #671 で実際に起きた失敗）。

### 🔴 破壊系を実試行しない

「AccessDenied を期待して DeleteTable を実行する」テストは、**Deny が効いていなかった
場合に本当に消す**。二分する。

**実試行してよい（副作用なし）**

| # | 操作 | 期待 |
| --- | --- | --- |
| N1 | `sts:AssumeRole` → `cdk-orcloud01-deploy-role-*` | ALLOW |
| N2 | `sts:AssumeRole` → `cdk-hnb659fds-deploy-role-*` | **DENY** |
| N3 | `sts:AssumeRole` → `cdk-staging-deploy-role-*` | **DENY** |
| N4 | `cloudformation:DescribeStacks` → `OpenReception-Web-dev` | ALLOW |
| N5 | `cloudformation:DescribeStacks` → `nodi-dev-app` | **DENY** |
| N6 | `cloudformation:DescribeStacks` → `salon-loop-staging-data` | **DENY** |
| N7 | `secretsmanager:ListSecrets` | **DENY**（列挙させない） |
| N8 | — | **欠番**（旧 `iam:CreateAccessKey`。副作用があるため下表 S11 へ移動） |
| N9 | `sts:AssumeRole` → `cdk-orcloud01-lookup-role-*` | **DENY**（§4.1 の Critical 1。lookup role は `ReadOnlyAccess` 付きで boundary の外） |

> 🔴 **N8（`iam:CreateAccessKey` on `user/CDK`）はここに置かない。** 当初案は
> 「実試行してよい」に分類していたが、これは誤りだった。**Deny が効いていない場合
> （＝このチェックが検出したい唯一の状況）に、`AdministratorAccess` principal 上へ
> 本物の長期アクセスキーを実際に作ってしまう。** 回収も報告もされない。「実試行してよい
> ＝副作用なし」の定義を明示すると、`sts:assume-role`（N1〜N3）が返す一時 credential を
> **変数に束縛も記録も再利用もしない**（実装は `execFileSync` の戻り値を捨てる）ことが
> 条件になる。`iam:CreateAccessKey` はこの条件を満たさないため、実装では下表の `S11` へ
> 移した。

**実試行しない（`iam:SimulatePrincipalPolicy` で判定 / 人間側 Admin から実行）**

🔴 **各 check は「どの principal に対して評価するか」を宣言する（2026-08-12 全体レビュー
Critical 3）。** 旧実装は principal ARN を 1 本だけ受け取り、既定を entry role
（`OpenReceptionClaudeDeploy-dev`）にしていた。runbook ステップ 4a もその ARN を渡していた。
entry role は `DenyEverythingElseOutsideTheChain` で 4 アクション以外を最初から全 Deny
するので、**S1〜S11 は `claude-boundary.json` / `claude-cfn-exec.json` が存在するか否かに
関係なくすべて `denied` を返す ―― 落ちようのない検査だった。** 本来 S4/S5/S7（boundary 脱出）・
S6（PassRole）・S1/S3/S10 が問うているのは `cdk-orcloud01-cfn-exec-role-*` の権限であり、
その principal は本ブランチのどこでも一度もシミュレートされていなかった。

🔴 **各 check は「どのリージョンで評価するか」も宣言する（2026-08-12 残件レビュー R4）。**
旧実装は `SIMULATED_CHECKS` のリソース ARN を**全部 `ap-northeast-1` にハードコード**し、
principal ARN も 1 リージョン分しか受け取らなかった。runbook は「us-east-1 側も
`-us-east-1` 版で 1 度実行する」と指示していたが、それで変わるのは
`--policy-source-arn` だけで**評価されるリソースは ap-northeast-1 のまま** ――
運用者は「us-east-1 検証済み」と記録するのに、us-east-1 のリソースは一度も
シミュレートされていなかった。**ステップ 4 は初回デプロイを認可するゲート**である。

対処は文書ではなく構造で行う。

- `SIMULATED_CHECKS` の各エントリが `principals`（`entry` / `deploy` / `exec`）と
  `coverage`（`both` または `only` ＋**理由の文字列（型が必須にしている）**）を持つ
- `resource` は**リージョンを引数に取る関数**である（ハードコードを
  `tests/hooks/aws-negative-tests-source.test.ts` が禁止している）
- principal ARN は**リージョンごとに別の環境変数**（`entry` だけは IAM ロール 1 本なので
  リージョンを持たない）:
  `SIMULATE_ENTRY_ROLE_ARN` /
  `SIMULATE_{DEPLOY,EXEC}_ROLE_ARN_{AP_NORTHEAST_1,US_EAST_1}`。
  1 つでも**供給されていなければ実行を拒否**する（既定値で埋めない）
- 旧 `SIMULATE_PRINCIPAL_ARN` / `SIMULATE_DEPLOY_ROLE_ARN` / `SIMULATE_EXEC_ROLE_ARN`
  （リージョン無し）は設定されていると `exit 2` で止まる
- 結果行に principal ARN・リージョン・**実際に評価したリソース ARN**を印字する。
  覆っていないリージョンは結果より**前**に理由つきで印字する
- `summarizeNegativeTests` は、意図した principal と異なる principal で評価された結果を
  **採点せず棄却**する（`denied` でも PASS にしない）

| # | 操作 | principal | region | 期待 |
| --- | --- | --- | --- | --- |
| S1 | `dynamodb:DeleteTable` on nodi のテーブル | exec | 両方 | DENY |
| S2 | `cloudformation:DeleteStack` on `nodi-*` | deploy, exec | 両方 | DENY |
| S3 | `secretsmanager:GetSecretValue` on 他プロジェクトの secret | exec | 両方 | DENY |
| S4 | `iam:CreateRole` (boundary 指定なし) | exec | 両方 | DENY |
| S5 | `iam:AttachRolePolicy` | exec | 両方 | DENY |
| S6 | `iam:PassRole` → `cdk-hnb659fds-cfn-exec-role-*` | deploy, exec | 両方 | DENY |
| S7 | `iam:DeleteRolePermissionsBoundary` | exec | 両方 | DENY |
| S8 | `route53:ChangeResourceRecordSets` | exec | 両方 | DENY |
| S9 | `cloudformation:UpdateStack` on `OpenReception-*-prod`（将来） | deploy, exec | 両方 | DENY |
| S10 | `kms:ScheduleKeyDeletion` | exec | 両方 | DENY |
| S11 | `iam:CreateAccessKey` on `user/CDK`（旧 N8） | entry, exec | 両方 | DENY |
| S12 | `sts:AssumeRole` → `cdk-orcloud01-lookup-role-*`（Critical 1） | entry | 両方 | DENY |
| S13 | `iam:DeleteRolePolicy` on `cdk-orcloud01-deploy-role-*`（Important 5。自分のチェーン） | exec | 両方 | DENY |
| S14 | `iam:CreatePolicyVersion` on 他プロジェクトのポリシー（Important 5） | exec | 両方 | DENY |
| S15 | `cloudformation:DescribeStacks` on `OpenReception-CfMonitoring-dev` | entry | us-east-1 のみ | **ALLOW** |
| S16 | `cloudformation:DescribeChangeSet` on `claude-gate-*`（us-east-1） | entry | us-east-1 のみ | **ALLOW**（🔴 シミュレーション不能。下記参照） |
| S17 | `iam:CreateRole` on carve-out のロール名（boundary なし。#680 R2） | exec | 両方 | **ALLOW** |
| S18 | `iam:CreateRole` on carve-out**外**のロール名（boundary なし） | exec | 両方 | DENY |
| S19 | `iam:DeleteRole` on carve-out のロール名（rollback 経路。#680 R3） | exec | 両方 | **ALLOW** |
| S20 | `iam:DeleteRole` on タグの無い別のロール | exec | 両方 | DENY |
| S21 | `iam:PassRole` on carve-out のロール（`iam:PassedToService=lambda.amazonaws.com` を供給。#680 R10） | exec | 両方 | **ALLOW** |
| S22 | `iam:PassRole` on タグの無い別のロール（同じ context を供給） | exec | 両方 | DENY |

**S17〜S20 は 2 対で 1 つの主張である。** 片方だけ見ると、carve-out を消しても
（S18/S20 が緑）carve-out を `*` へ広げても（S17/S19 が緑）気づけない。
`tests/hooks/aws-negative-tests-source.test.ts` が「対で存在すること」を固定している。

> **`iam:PassRole` の carve-out は S 系に入っていない。** `iam:PassedToService` は
> リクエスト側の context key なので `--context-entries` 無しでは評価できず、
> 渡さないと「実際には通る呼び出し」が `denied` に見える。runbook 4b の 14〜16 で
> 人間が手動確認する。**覆っていないことを書いておく。**

`principals` を配列にしてあるのは、同じ問いが層をまたいで二重に守られている場合
（例: foreign stack への操作は deploy role の層 1 と cfn-exec role の層 3 の両方）、
どちらか一方を選ぶのが恣意的で片方の退行を見逃すため。各 principal × region ごとに
1 件として採点する。

**「policy を読む限り安全」で終わらせない**（spec 原文 §9）。S 系は
`SimulatePrincipalPolicy` の実 API 応答を根拠とし、結果を PR 本文へ貼る。

### 🔴 S15/S16 はシミュレーション不能（2026-08-13 実測、#680 フォローアップ）

`--simulate-only` を実 IAM に対して初めて実行した結果、49/50 件が期待どおりで、
残り 1 件（`S16`）は `implicitDeny` を返し続けた。`simulate-custom-policy` で単離した
実測:

| 呼び出し | 結果 |
| --- | --- |
| `DescribeChangeSet`, リソース ARN 無し | `allowed`（アクション自体は認識される） |
| `DescribeStacks`, stack ARN, `Resource: "*"` | `allowed`（stack 型は機能する） |
| `DescribeChangeSet`, changeSet ARN, `Resource: "*"` | `implicitDeny`（最小 Allow でも！） |
| `ExecuteChangeSet`, changeSet ARN, `Resource: "*"` | `implicitDeny`（同上） |

`Resource: "*"` の最小 Allow ですら `implicitDeny` が返るのは、ポリシーの中身が
悪いのではなく **AWS の IAM ポリシーシミュレータが CloudFormation の `changeset`
リソース種別を評価できない**ことを意味する。`claude-deploy-entry.json` に欠陥は無い
（デプロイ済みインラインポリシーとリポジトリのファイルはバイト一致）。

🔴 **`S15`/`S16` へのハードコードした exemption にはしない。** 「落ちようのない検査」を
作る側の欠陥は、本設計が Critical 3・R4 で繰り返し踏んできた。代わりに、
`expected: 'allowed'` の check が `implicitDeny`（他の何にも一致しなかった）を返した
ときだけ、`negative-test-outcome.ts` が同じ action/resource に対して
`simulate-custom-policy`（無関係の最小 Allow, `Resource: "*"`）で probe を打つ
（`isUnexplainedImplicitDeny` → `classifyProbeVerdict`）。probe も `implicitDeny` を
返せば「ℹ️ シミュレーション不能」として集計から除外し、根拠と実際の検証先を印字する。
probe が `allowed`（＝将来 AWS が changeset リソース種別に対応した場合）を返せば、
check は自動的に通常の pass/fail 採点へ戻る ―― 文書を書き換える必要が無い。

**changeSet スコープの authorisation を実際に検証するのは
`bash scripts/aws-cloud-deploy.sh diff`** である（`--no-execute` で change set を
作成し `describe-change-set` を呼ぶ。誤ったスコープが AccessDenied として最初に
現れる地点）。`diff` は何も適用しないため安全側のまま、ステップ 4 が確認できない
leg（changeSet 認可）の実質的なゲートになる。詳細は
`docs/runbook-cloud-aws-deploy.md` ステップ 4 と §13。

---

## 8. Credential 発行と「デプロイ窓」

### 窓 = credential の有効期限そのもの

窓を表す別の状態ファイルを作らない。**credential が生きている＝窓が開いている。**
状態が 2 箇所にあると必ず食い違う（`scripts/cloud-setup.sh` と環境ダイアログで
実際に起きている問題）。

`user/CDK` は IAM **user** なので role chaining の 1 時間上限は掛からず、
**ロールの `MaxSessionDuration` まで（最大 12h）**取れる。既定 **4 時間**を推奨する。

### 発行スクリプト

`scripts/aws-issue-credentials.sh`（ローカル Mac の Admin 環境で人間が実行）

- `aws sts assume-role` で短命 credential を取得
- **端末へ表示するのは環境変数名と有効期限のみ。値は表示しない**
- 値は macOS のクリップボードへ直接入れる（`pbcopy`）か、`--print` を明示したときのみ表示
- Git / artifact / log / docs へ値を書かない。`.gitignore` に頼らず**そもそもファイルに書かない**

登録先は claude.ai/code の環境ダイアログ。**変数名のみ** runbook に記載する（5 つ）:
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` /
`AWS_CREDENTIAL_EXPIRATION`。`scripts/aws-cloud-deploy.sh` は `AWS_CREDENTIAL_EXPIRATION`
から credential の残時間を計算し、パースできなければ fail-closed する
（`credentialSecondsRemaining` が `null` になり preflight が停止する）ため、5 つ目を
登録し忘れると原因の分かりにくい preflight 失敗になる。

### 窓の外の routine の振る舞い

`cdk diff` も**デプロイ済みスタックを読むため credential が要る**。したがって
「窓の外では diff まで」は成立しない。**窓の外では AWS に一切触れない。**

- 窓の外 … 実装・品質ゲート・PR までを通常どおり回す。デプロイ段は
  「credential 無しのためスキップ」と**明示的に記録して**正常終了する
- 窓の中 … verify → preflight → diff → deploy → smoke を無人で完走する

---

## 9. 既存ルール・QA との整合

### 9.1 `docs/cloud-dev-environment.md` §1 との矛盾を解消する

現行: 「**環境変数は設定しない。** 環境変数はその環境を使う全員が読めて、専用の
secrets store が無い。AWS 認証情報などは置かないこと。」

改訂後: 「**長期 secret を置かない。** 有効期限付きの STS credential のみ可とし、
窓を閉じたら削除する。長期アクセスキー・API キー・秘密鍵は置かない。」

### 9.2 QA を弱めない（spec 原文 §11）

- `quality-gate.sh` を skip して deploy を成功させる経路を作らない。preflight が
  green スタンプを要求する
- 誤検知が出ても QA 全体を無効化しない。最小範囲で直す
- `--strict` の思想（未導入ツールの SKIP を FAIL にする）を negative test にも適用する。
  **判定不能を PASS にしない**

### 9.3 停止境界（`CLAUDE.md` / `.claude/rules/opus5-autonomous-loop.md`）

本設計は「Cognito、認可、PIN/IP 制御の境界変更」「継続的 AWS 費用増加」に触れない
（dev のみ・新規リソースは IAM とサンドボックス的な bootstrap のみ・費用増は実質ゼロ）。
IAM の実適用は人間が runbook で行う（§10）。

---

## 10. 🔴 スコープ外として報告する事項

### `user/CDK` の AdministratorAccess + 長期キー

```
user/CDK   AdministratorAccess (attached)  + inline policy "CDK"
  access key <アクセスキー ID は伏字>   Active / 2026-04-19 作成（約 4 か月無交換）
```

これは移行と独立に存在する既存リスクだが、**本設計では一切変更しない**。理由:
このユーザーは **nodi / salon-loop / Kiaff を含む 4 プロジェクト共通の人間用デプロイ経路**
であり、権限を縮小すると他プロジェクトのデプロイが壊れる。
spec 原文 STOP CONDITIONS の「既存 production deploy 経路を壊す可能性がある」に該当する。

**推奨（人間の別作業として）**: キーのローテーション、または IAM Identity Center への移行。
本設計はこの是正を前提にしていない（是正されればさらに安全になるだけ）。

---

## 11. 成果物

| パス | 内容 |
| --- | --- |
| `scripts/aws-policies/*.json` | boundary（層 4）/ entry role の権限 / entry role の trust / cfn exec（層 2・3）/ deploy role への上乗せ Deny（**層 1・主境界**）の 5 ポリシー |
| `scripts/aws-cloud-deploy.sh` | wrapper（preflight / verify / diff / deploy / smoke） |
| `src/domain/governance/deploy-diff-gate.ts` + `.test.ts` | change set の危険判定（**純関数**） |
| `src/domain/governance/deploy-preflight.ts` + `.test.ts` | preflight の判定ロジック（**純関数**） |
| `src/domain/governance/aws-policy-shape.ts` + `.test.ts` | ポリシー JSON の構造検証（**純関数**）。ドキュメントと出荷 JSON の一致もここで固定する（#680 R6/R9） |
| `src/domain/governance/negative-test-outcome.ts` + `.test.ts` | S/N 系の判定・principal × region の解決（**純関数**） |
| `src/domain/governance/cfn-generated-name.ts` + `.test.ts` | CloudFormation 生成名の予測と IAM グロブ照合（**純関数**。carve-out の ARN パターンが実在名に当たることの根拠。#680 R1） |
| `src/domain/governance/bash-source.ts` + `.test.ts` | シェルソースからコメント／文字列リテラルを落とす（**純関数**。ソース検査が偽の緑にならないように。#680 R5） |
| `infra/lib/config/claude-deploy-boundary.ts` + `infra/test/claude-deploy-boundary.test.ts` | 層 4 の Permissions Boundary を CDK アプリ側で適用する（§4.2 層 4 の注記。bootstrap だけでは付かない） |
| `scripts/aws-diff-gate.ts` | 上記を呼ぶ薄い CLI |
| `scripts/aws-negative-tests.ts` | N1-N7 + N9 実試行（`--live-only`）/ S1-S22 シミュレーション（`--simulate-only`。principal × region ごとに評価。旧 N8 は S11 へ移動済み） |
| `scripts/aws-issue-credentials.sh` | 人間が窓を開ける（ローカル Mac） |
| `tests/hooks/aws-cloud-deploy.test.ts` | wrapper の preflight を実起動して検証 |
| `docs/runbook-cloud-aws-deploy.md` | runbook（§12 の 10 ステップ） |
| `docs/adr/0009-claude-cloud-aws-dev-deploy-boundary.md` | ADR |
| `docs/cloud-dev-environment.md` / `CLAUDE.md` | §1 の訂正・§9.1 の改訂 |

### 🔴 スクリプトは `scripts/` 直下へフラットに置く（`scripts/aws/` にしない）

`scripts/check-script-wiring.ts` の `listScripts()` は `readdirSync(...).filter(e => e.isFile())`
であり、**サブディレクトリを走査しない**。`scripts/aws/` に置くと「誰も呼んでいない
スクリプト」の検査対象から丸ごと外れる —— #656 の再現そのものになる。
`aws-` prefix のフラット配置にし、配線を明示する:

- `scripts/aws-cloud-deploy.sh` を `check-script-wiring.ts` の **`WIRING_SOURCES` へ追加**する
  （これは実際の入口であり、ここからの参照は配線と数えてよい）
- `aws-cloud-deploy.sh` 自身と `aws-issue-credentials.sh` は **`MANUAL_ONLY_ALLOWLIST`** へ
  （前者はクラウド routine から、後者は人間がローカルで叩く入口）

なお `listScripts()` がサブディレクトリを見ない件自体は既存の穴だが、`scripts/hooks/**` を
検査対象に含めると別途 allowlist 整理が要るため**本サイクルでは直さず、別 issue にする**。

### テスト方針

既存の governance スクリプト（`change-risk` / `merge-method` / `script-wiring` 等）と
**同じ形**にする: 純ロジックを `src/domain/governance/` に置いて同居テストで固定し、
`scripts/` 側は引数を渡すだけの CLI にする。こうすると AWS へ接続せず `--fast` に載る。

- `deploy-diff-gate` は **change set JSON を入力とする純関数**にし、fixture で全停止条件を固定する
- preflight の判定も純関数にする。
  **「形を固定するテスト」にしない** — status や引数の個数ではなく、
  「不一致のとき実際に非ゼロで止まるか」を許可リスト方式で固定する
- 全テストは変異させて赤を確認してから green にする

---

## 12. 人間が実行する手順（runbook の骨子）

1. IAM 初期構築（boundary → entry role → cfn exec policy）
2. 専用 qualifier で bootstrap（ap-northeast-1 / us-east-1、`--custom-permissions-boundary`
   と `--cloudformation-execution-policies` を明示、`--toolkit-stack-name CDKToolkit-orcloud01`）
3. deploy role への層 1 制限の適用
4. negative test（S 系シミュレーション）を Admin から実行し全 DENY を確認
5. `aws-issue-credentials.sh` で短命 STS を発行（窓を開ける）
6. claude.ai/code の環境ダイアログへ変数名 5 つを登録
7. 🔴 クラウドセッションで **`aws-cloud-deploy.sh verify`**（`quality-gate.sh --pr` ＋
   `build:open-next`）
8. `aws-cloud-deploy.sh preflight`（N 系実試行がここで走る）
9. `aws-cloud-deploy.sh diff`
10. `aws-cloud-deploy.sh deploy` → `smoke`
11. 窓を閉じる（環境変数を削除）／期限切れ後の再発行

> 🔴 **`verify` が `preflight` より先である（2026-08-12 全体レビュー Important 7）。**
> preflight は「現ツリーに対する品質ゲート green のスタンプ」を要求するが、**スタンプは
> `git rev-parse --absolute-git-dir` の下（`.git` 配下）のローカルファイル**であり
> （`scripts/lib/gate-stamp.sh`）、**clone にも push にも付いてこない**。
> 新しいクラウドサンドボックスには存在しないので、`verify` が書くまで green の記録は無い。
> **そのスタンプを書く手順は `verify` だけである。**
> 本 spec と runbook は以前この順序を逆に書いており（§12 は 6 → 7=preflight、
> runbook も 5 → 6 → 7=preflight）、`verify` はどの手順からも呼ばれていなかった。
> 結果として、fresh なサンドボックスの preflight は `gateStampSatisfied` で必ず落ち、
> 直し方がどこにも書かれていない状態だった。

---

## 13. 残存リスク

| リスク | 評価 |
| --- | --- |
| 窓の間に credential が漏れると dev を壊せる | dev は再構築可能（PITR 無効・削除保護無効の設計）。他プロジェクトへは層 1・3 で到達不能 |
| exec role の resource が一部 `*` | §4.2 層 2 の論拠（PassRole + スタック ARN）で担保。**論拠であって Deny ではない**点は明記して残す |
| `user/CDK` の Admin 長期キー | §10。本設計の外 |
| `Replacement: Conditional` の過検出 | 安全側。人間が承認して通す運用 |
| staging / prod を作るとき境界の拡張が要る | 意図的。そのとき改めて承認する |
| changeSet 名スコープの account-wide 露出 | **deploy role 単体の層では構造的に閉じられない。** 詳細は下記 |
| IAM シミュレータが changeSet リソース種別を評価できない（`S15`/`S16`） | **`iam:SimulatePrincipalPolicy` では検証不能（2026-08-13 実測）。** `negative-test-outcome.ts` の probe が「シミュレーション不能」として測定・除外する。changeSet スコープの authorisation は `bash scripts/aws-cloud-deploy.sh diff` で実証する。詳細は §7 |
| 列挙から漏れた第三者 IAM ポリシーの書き換え | **タグでは閉じられない。** 下記 |
| `iam:PassRole` のタグ条件が実 IAM でどう評価されるか | **未検証。** 初回デプロイで AccessDenied になる最有力候補。runbook 4b の 14〜16。simulate 側は S21/S22 が `--context-entries` で `iam:PassedToService` を供給して問う（#680 R10） |
| carve-out された名前空間に境界の無いロールを作られる | **IAM では閉じられない**（サンドボックスがテンプレートを書き、名前グロブは論理 ID / `RoleName` / `Path` を縛れない）。**diff gate で制動している。** 到達しうる上限はアカウント Admin。下記 |
| 境界の無いロールの trust policy を外部アカウントへ向けられる | **IAM に trust policy を縛る条件キーが無い。** デプロイ窓を越えて残る。gate の `carveOutRoleShape` / `roleTrustPolicyEscape` が止める。下記 |
| `AuthType: NONE` の Function URL で公開入口を残される | 同上。gate の `functionUrlExposure` / `publicInvokePermission` が止める。下記 |
| gate 自身がサンドボックス内で動く | **`aws-cloud-deploy.sh` を迂回されれば効かない。** gate は制動であって境界ではない。下記 |
| `claude-boundary.json` のサイズが上限に近い | 5,682 / 6,144 文字（残り 462）。次に足す人が壁にぶつかる。runbook ステップ 1 に注記 |

### carve-out された名前空間の残存ギャップ（#680 R1/R2/R3 の実装限界）

§4.2 層 4 の carve-out は
`arn:aws:iam::822063948773:role/OpenReception-*-dev-Custom*` に対して

1. `iam:CreateRole` / `PutRolePolicy` / `AttachRolePolicy` を **boundary 条件なしで**許し
2. `iam:PassRole` を（`lambda.amazonaws.com` 限定で）タグ条件なしで許し
3. `DenyIamRoleWriteOutsideProject`（タグ条件）から除外する

**覆えないこと（正直に書く）。** テンプレートを書くのは、脅威モデル（§3）が侵害を
仮定している当のサンドボックス自身である。したがってサンドボックスは、construct の
id を `Custom…` で始めるだけで、**この名前空間に入る Permissions Boundary の無い
IAM ロールを意図的に作れる**。そのロールへ `iam:PutRolePolicy` で任意のインライン
ポリシー（実質 Admin）を載せ、`iam:PassRole` で Lambda に渡して実行できる。
これは carve-out が新たに開いた経路であり、carve-out 前は `iam:CreateRole` の
boundary 条件で塞がっていた。

🔴 **名前グロブでは防げない（訂正: #680 R10）。** 「construct の id を `Custom…` で
始めるだけ」よりも入口は広い。物理名を決めるのは 3 つとも**テンプレート側**である:

1. 論理 ID（切り詰められて生成名になる）
2. `RoleName` の明示（切り詰めすら起きない）
3. `Path` の明示 —— **IAM のリソース ARN グロブでは `*` が `/` を跨ぐ**ので、
   `Path: '/OpenReception-x-dev-Custom/'` を付ければ論理 ID が何であれ
   `role/OpenReception-x-dev-Custom/<名前>` になり carve-out に入る。
   **「名前を見ればおかしいと分かる」は成り立たない。**

同じ理由で、**carve-out を 2 本に分けて狭くしても防御にはならない**
（`…-CustomCrossRegion*` ＋ `…-CustomS3AutoDelete*` は文字数的には収まる）。
狭さが買えるのは事故耐性だけである。以前ここに書いていた
「3 本すべてに当たる中で最も狭い」という説明は、**選定理由としては誤り**だった。

### 影響範囲（丸めない）

carve-out **前**、敵対的なデプロイの上限は boundary だった（他プロジェクト不可・
Secrets Manager 不可・KMS 破壊不可・IAM 昇格不可）。carve-out **後**の上限は
**アカウント全体の Admin** である（`nodi` / `salon-loop` / prod を含む）。
しかも次の 2 経路は**デプロイ窓（§8）が閉じたあとも残る**:

1. **trust policy はテンプレート側が決める。** IAM には trust policy の中身を縛る
   条件キーが存在しない。外部アカウントや `"AWS":"*"` を信頼するロールは、
   資格情報の失効後も外から assume できる。したがって
   **`iam:PassRole` が `lambda.amazonaws.com` 限定であることは、この経路に対して
   制約になっていない**（PassRole を通る必要が無い）
2. **`AWS::Lambda::Url` の `AuthType: NONE`。** boundary の無いロールを持つ Lambda に
   公開 HTTPS の入口が付く。これも失効を越えて残る

### 実際に抑えているのは diff gate である（§6）

**boundary ではなく `deploy-diff-gate.ts` がこの名前空間の主たる制御である。**
gate は change set と synth テンプレートを、1 バイトも AWS へ適用される前に読む:

| 停止理由 | 何を止めるか |
| --- | --- |
| `carveOutRoleNamespace` | carve-out に入る `AWS::IAM::Role` のうち、既知の provider role 3 本以外。物理名は生成名・`RoleName`・`Path` を IAM と同じ規則で組んで判定する |
| `carveOutRoleShape` | 既知 3 本を**名乗った**だけの実体、および `AWS::IAM::Policy` / `ManagedPolicy` / `RolePolicy` から carve-out のロールへ届く許可。trust の Principal は `lambda.amazonaws.com`・Action は `sts:AssumeRole` のみ／managed policy は基本実行ロールのみ／action は実測 6 つの `ssm:` の**許可リスト**／`Resource` は `parameter/cdk/exports/` の下。**Add だけでなく Modify も見る**（trust policy もインラインも物理名を変えずに書き換えられ、後者はロールが change set に現れない） |
| `roleTrustPolicyEscape` | carve-out の**外**でも、外部アカウント／`"AWS":"*"`／`Federated` を信頼する trust policy |
| `functionUrlExposure` | WebStack の 2 本以外の `AWS::Lambda::Url`。image は常に `AWS_IAM`（#631） |
| `publicInvokePermission` | origin-verify 方式で CDK が足す 2 本以外の `Principal:"*"` invoke 許可、および別アカウントへの invoke 許可 |
| `opaqueResourceShape` | 上の判定に必要なテンプレートを読めなかった場合（読めなかったを問題なしに落とさない） |

allowlist は `REVIEWED_CDK_GENERATED_LOGICAL_IDS` 1 か所。**論理 ID を載せることは
「この ID の実体は CDK が決定論的に生成するもので、中身をレビューした」という主張**で
あって便宜ではない。だから論理 ID だけでなく形も固定してある。

### それでも残ること（gate を通り抜けられるもの）

- **gate はサンドボックスの中で走る。** `scripts/aws-cloud-deploy.sh` を迂回して
  `cdk deploy` を直接叩けば gate は動かない。IAM 側にこれを強制する手段は無い
  （層 1 は「どのスタックか」しか見ない）。**gate は制動であって境界ではない**
- gate は action の名前と `Resource` を許可リストで縛るが、`Condition` は見ていない
  （condition は権限を**狭める**方向にしか働かないので、無視しても安全側）。
  残るのは**許可リストの中での振る舞い**である: boundary の無いロールが
  `ssm:PutParameter` / `DeleteParameters` を `parameter/cdk/exports/` の下で持つのは
  通るので、**このアカウントの CDK cross-region export パラメータを上書き・削除して
  他の CDK アプリのデプロイを壊すこと**はできる。`Resource: "*"` / `parameter/*` と
  `s3:` `dynamodb:` `logs:` `iam:` は 2 段の許可リスト化（2026-08-13）で通らなくなった
- `AWS::IAM::OIDCProvider` / `SAMLProvider` の Add は止めない。プロバイダ単体では
  誰にも何も許さないためで、**この判断は「`Federated` を信頼するロールが必ず止まる」
  ことに依存している**（carve-out の内は `carveOutRoleShape`、外は
  `roleTrustPolicyEscape`。どちらもテストで固定済み）
- carve-out の外のロールの trust policy が組み込み関数で書かれていると gate は
  読み切れず、**止めずに記録する**（`opaqueRoleTrustPolicy`）。ここを止めると
  正当な初回デプロイが通らない

**やらなかったこと。** `iam:AttachRolePolicy` に `iam:PolicyARN =
…/service-role/AWSLambdaBasicExecutionRole`（provider role が実際に attach する唯一の
managed policy。synth で確認）の条件を足せば「AdministratorAccess を attach する」
経路だけは IAM 側でも塞げる。**足していない** —— `iam:PutRolePolicy` による
インラインポリシーの経路が同じ強さで開いたままなので IAM 側の防御としては
見かけ倒しになり、その一方で provider の実装が変わったときに
**初回デプロイを AccessDenied で壊す**副作用がある。同じ性質を gate 側で
（壊しても停止するだけの場所で）固定した。

**再評価の条件**: dev の 3 スタックに `Custom` で始まる construct id を人が意図的に
足したくなったとき、または carve-out の名前空間に provider 以外のロールが現れたとき。

🔴 **その検出は回帰テストではなく gate が担う（訂正: #680 R10）。** 以前ここには
「`infra/test/claude-deploy-boundary.test.ts` が論理 ID の完全一致で固定しているので
増えれば赤くなる」と書いていたが、**誤りだった**。あの fixture は手で組んだ
2 スタックのモデルであって実アプリではないので、`web-stack.ts` に `Custom…` の
construct を足しても fixture の synth 結果は変わらない（実際 `web-stack.ts` は既に
`CustomDomainHostedZone` / `CustomDomainAliasA` / `CustomDomainUrl` を construct id に
使っている。いずれも IAM ロールを作らないので今は無害だが、「赤くなるはず」の
主張は既に成り立っていない）。実アプリの synth を assert する案は
`.open-next/` の鮮度に依存して**大半の実行でスキップされる**（#628 / #612 で
実害が出た形）ため採らない。**deploy のたびに無条件で走る gate が検出する。**

### 第三者 IAM ポリシー書き換えの残存ギャップ（Important 5 の実装限界）

`claude-cfn-exec.json` は `iam:CreatePolicyVersion` / `SetDefaultPolicyVersion` /
`DeletePolicy` / `DeleteRole` 等を `Resource: "*"` で Allow している（CDK が自分の
ロール・ポリシーを更新するのに要る）。塞ぎ方は 2 段構え:

1. **名前による明示 Deny**（`DenyIamWriteOnForeignPrincipals`）… `cdk-hnb659fds-*` /
   `cdk-staging-*` / `cdk-orcloud01-*` / `OpenReceptionClaudeDeploy-dev` / `nodi-*` /
   `salon-loop-*` / `Kiaff*` / `SalonLoop*` / `Nodi*` / `OpenReceptionClaude*` の
   role・policy、および全 `user/*`。**自分のチェーンを含めているのが要点** ——
   `iam:DeleteRolePolicy` で deploy role から層 1 のインラインポリシーを剥がされたら
   主境界そのものが消える。
2. **タグ条件**（`DenyIamRoleWriteOutsideProject`）… `aws:ResourceTag/Project` が
   `open-reception` でない **role** への破壊的書き込みを Deny。

🔴 **2 はポリシーには適用できない。** `AWS::IAM::ManagedPolicy` は CloudFormation の
リソース仕様に `Tags` プロパティを持たないため、CDK が作るマネージドポリシーは
**必ず untagged になる**。`iam:CreatePolicyVersion` に
`StringNotEquals aws:ResourceTag/Project` を掛けると（キー欠如時に真なので）
自分自身のポリシー更新まで Deny してしまう。したがってポリシー系アクションは
**名前の列挙のみ**が防御であり、**将来この account に増える第三者ポリシーで、
上の名前パターンに一致しないものは覆えない**。「タグで一般化した」とは書かない。

### changeSet 名スコープの account-wide 露出（詳細）

changeSet ARN は stack 名を埋め込まない
（`arn:aws:cloudformation:<region>:<acct>:changeSet/<name>/<id>` — stack 名は含まれない）。
そのため `claude-deploy-role-restriction.json` の `DenyCloudFormationOutsideDevStacks` に
追加した `changeSet/claude-gate-*/*` という `NotResource` エントリは、**changeSet の
「名前」だけでスコープしており、その changeSet がどの stack に属するかを一切見ない。**
結果として、`DescribeChangeSet` / `ExecuteChangeSet` / `DeleteChangeSet` の 3 アクションは
**account 全体**で `claude-gate-*` という名前の changeSet に対して許可される
（`DenyForeignAndNonDevStacksExplicitly` は stack ARN の列挙であり、changeSet ARN を
一切見ないので、ここでの再 Deny は起こらない）。AWS 側にも stack を絞る手段は無い
（`cloudformation:ChangeSetName` という条件キーはあるが、これも名前ベースであり
stack を特定しない）。**この意味で、deploy role 単体の層では構造的に閉じられない
ギャップである。**

ただし、悪用の実現可能性は限定的である。以下をすべて含めて正確に書く:

1. **前提条件が重い**: 悪用が成立するには、`nodi-*` / `salon-loop-*` /
   `OpenReception-*-prod`（あるいは他の foreign stack）上に、**あらかじめ**
   `claude-gate-` で始まる名前の changeSet が存在している必要がある。偶然にせよ
   意図的にせよ、この命名の changeSet が foreign stack 側に存在すること自体が前提。
2. **deploy role はそのような changeSet を自分で作れない**: `cloudformation:
   CreateChangeSet` は **stack ARN** に対して認可されるアクションであり、
   `DenyForeignAndNonDevStacksExplicitly` が `nodi-*` / `salon-loop-*` /
   `OpenReception-*-prod` 等の stack ARN を明示的に Deny している。つまり deploy role
   が foreign stack 上に `claude-gate-*` という名前の changeSet を新規作成すること
   自体ができない。
3. **仮に誰か・何かが（この経路の外で）そのような changeSet を作っていたとしても、
   実行（`ExecuteChangeSet`）は第二層で止まる**: change set の実行はその stack に
   対するスタック操作（作成/更新/削除）を引き起こし、これは cfn-exec role
   （`claude-cfn-exec.json`）の権限で実行される。`claude-cfn-exec.json` の
   `DenyForeignProjectStacks`（同種の stack ARN allowlist）が foreign stack への
   操作を別途 Deny するため、**実際にスタックへ影響を与える操作は cfn-exec role 側の
   第二の防波堤で止まる**。

したがって、現実的な露出範囲は次の 2 点に限定される（この 2 点だけが実際に成立し得る）:

- `cloudformation:DescribeChangeSet` による**情報漏洩**: 万一 foreign stack 上に
  `claude-gate-*` という名前の changeSet が存在すれば、その内容（提案されているリソース
  変更の詳細）を読める。
- `cloudformation:DeleteChangeSet` による**該当 changeSet への denial-of-service**:
  同条件下で、その changeSet を削除できてしまう（stack 自体やその他のリソースには
  影響しない。あくまで「その 1 つの changeSet オブジェクト」に対する妨害）。

「閉じられる」と誤って書かない一方、「使われている」と誇張しても書かない（前提条件が
満たされる可能性は現状ゼロに近い —— foreign project 側で `claude-gate-` という命名規則を
使う理由が無い）。

🔴 **この changeSet スコープの authorisation 自体は `iam:SimulatePrincipalPolicy` で
確認できない（2026-08-13 実測）。** IAM のポリシーシミュレータが CloudFormation の
`changeset` リソース種別を評価できないため、`S15`/`S16` は `Resource: "*"` の最小 Allow
でも `implicitDeny` を返す（詳細は §7「S15/S16 はシミュレーション不能」）。
「ステップ 4 が全件 PASS したので changeSet スコープも安全」とは読めない。
実際の authorisation は `bash scripts/aws-cloud-deploy.sh diff`（`--no-execute` の
change set 作成 → `describe-change-set`）が最初の実証地点になる。

## 14. 非スコープ

- open-reception の staging / prod スタック作成（継続費用＝停止境界）
- `user/CDK` の権限縮小・キーローテーション（§10）
- 無人ループ本体（routine 化・memory の repo 移設・失敗の可視化）— **別サイクル**
- darwin VRT ベースライン（原理的にローカル macOS のみ）

## 15. Definition of Done

**Claude Code on the cloud が他プロジェクトと prod 相当リソースへ到達できないことを
テストで確認した上で、dev へ `verify → preflight → diff → deploy → smoke` を
無人実行できる。** ただし本サイクルでは **deploy を実行しない**。
scripts / policies / tests / runbook を完成させ、人間が短命 credential を
投入できる直前で停止し、§10 を含めて報告する。
