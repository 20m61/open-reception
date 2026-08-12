# Claude Code on the cloud から AWS dev へ安全にデプロイする（設計）

2026-08-12 / 対象: `open-reception` / 状態: 設計承認済み・実装前

Claude Code on the cloud（クラウドセッション / cron routine）から、AWS の **dev 環境のみ**へ
`preflight → verify → diff → deploy → smoke` を実行できる安全境界を作る。

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
| T4 | **`iam:PassRole` 経由の昇格** | PassRole 先を `cdk-orcloud01-cfn-exec-role-*` に限定 | — |
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
arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-*-dev/*
arn:aws:cloudformation:us-east-1:822063948773:stack/OpenReception-*-dev/*
arn:aws:cloudformation:ap-northeast-1:822063948773:stack/CDKToolkit-orcloud01/*
arn:aws:cloudformation:us-east-1:822063948773:stack/CDKToolkit-orcloud01/*
```

（リージョンは 2 つを列挙する。出荷している `claude-deploy-role-restriction.json` の
`NotResource` も同じ 2 行で、`*` ワイルドカードは使っていない ―― 許可リスト側の
ワイルドカードは「広すぎる」方向に壊れるため、`aws-policy-shape.test.ts` が
各エントリの形を正規表現で固定している。）

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

Deny するもの:

- `iam:CreateRole` / `PutRolePolicy` / `AttachRolePolicy` で
  `iam:PermissionsBoundary` condition が `OpenReceptionClaudeBoundary` でないもの
- `arn:aws:iam::aws:policy/AdministratorAccess` 等の広域 policy の attach
- `iam:DeleteRolePermissionsBoundary` / `PutRolePermissionsBoundary`（差し替え）
- boundary 自身（`policy/OpenReceptionClaudeBoundary`）への `CreatePolicyVersion` /
  `DeletePolicy` / `SetDefaultPolicyVersion`
- 鎖の外への `iam:PassRole` / `sts:AssumeRole`
- `route53:*` / `acm:*`（全面。human-only）
- `organizations:*` / `account:*` / `iam:CreateUser` / `iam:CreateAccessKey`

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
| branch / commit | 現在の HEAD が push 済みであること |
| 環境 | `-c env=dev` 以外を拒否 |
| 品質ゲート | 現ツリーに対する green スタンプ（既存 `pr-gate-guard.sh` と同じ記録を読む） |
| negative tests | 全 PASS（§7） |

### 各サブコマンド

- `verify` … 既存 `./scripts/quality-gate.sh --pr` ＋ `npm run build:open-next`
  （🔴 #677 で「`record-gate-run.sh` が `build:open-next` を呼んでおらず infra synth が
  SKIP=FAIL になる」既知不具合があるため、ここでは明示的に呼ぶ）
- `diff` … `cdk diff` ではなく **change set を作って JSON で取得**し、§6 の gate に掛ける
- `deploy` … gate PASS のときのみ `cdk deploy`。gate NG なら非ゼロ終了して PR にリスクを記録
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

**記録のみ（deploy は進める）**

| 条件 | なぜ止めないか |
| --- | --- |
| `AWS::IAM::Role` / `Policy` / `ManagedPolicy` の Add・Modify | — |

> 🔴 **ここは意図的に spec 原文 §8 の「IAM を検出したら停止」より緩めている。**
> `OpenReception-Web-dev` は IAM Role 4 個・Policy 3 個を含み、Lambda の権限が変わるたびに
> Modify が出る。一律停止にすると **gate が恒常的に赤くなり、赤を無視する習慣がつく**
> 方が危険（`change-risk.ts` が report-only である理由と同じ判断）。
>
> 止めなくてよい根拠は **§4.2 層 4 の Permissions Boundary**にある。exec role が作る
> Role には boundary が強制されるので、**新しい Role が boundary を超える権限を持つことは
> 構造的に不可能**。差分レビューより強い保証である。Remove / Replace は上表で止まる。
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

| # | 操作 | 期待 |
| --- | --- | --- |
| S1 | `dynamodb:DeleteTable` on nodi / salon-loop のテーブル | DENY |
| S2 | `cloudformation:DeleteStack` on `nodi-*` / `salon-loop-*` | DENY |
| S3 | `secretsmanager:GetSecretValue` on 他プロジェクトの secret | DENY |
| S4 | `iam:CreateRole` (boundary 指定なし) | DENY |
| S5 | `iam:AttachRolePolicy` (AdministratorAccess) | DENY |
| S6 | `iam:PassRole` → `cdk-hnb659fds-cfn-exec-role-*` | DENY |
| S7 | `iam:DeleteRolePermissionsBoundary` | DENY |
| S8 | `route53:ChangeResourceRecordSets` | DENY |
| S9 | `cloudformation:UpdateStack` on `OpenReception-*-prod`（将来） | DENY |
| S10 | `kms:ScheduleKeyDeletion` | DENY |
| S11 | `iam:CreateAccessKey` on `user/CDK`（旧 N8） | DENY |

**「policy を読む限り安全」で終わらせない**（spec 原文 §9）。S 系は
`SimulatePrincipalPolicy` の実 API 応答を根拠とし、結果を PR 本文へ貼る。

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
- 窓の中 … preflight → verify → diff → deploy → smoke を無人で完走する

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
| `src/domain/governance/aws-policy-shape.ts` + `.test.ts` | ポリシー JSON の構造検証（**純関数**） |
| `scripts/aws-diff-gate.ts` | 上記を呼ぶ薄い CLI |
| `scripts/aws-negative-tests.ts` | N1-N7 実試行（`--live-only`）/ S1-S11 シミュレーション（`--simulate-only`。旧 N8 は S11 へ移動済み） |
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
7. クラウドセッションで `aws-cloud-deploy.sh preflight`（N 系実試行がここで走る）
8. `aws-cloud-deploy.sh diff`
9. `aws-cloud-deploy.sh deploy` → `smoke`
10. 窓を閉じる（環境変数を削除）／期限切れ後の再発行

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

## 14. 非スコープ

- open-reception の staging / prod スタック作成（継続費用＝停止境界）
- `user/CDK` の権限縮小・キーローテーション（§10）
- 無人ループ本体（routine 化・memory の repo 移設・失敗の可視化）— **別サイクル**
- darwin VRT ベースライン（原理的にローカル macOS のみ）

## 15. Definition of Done

**Claude Code on the cloud が他プロジェクトと prod 相当リソースへ到達できないことを
テストで確認した上で、dev へ `preflight → verify → diff → deploy → smoke` を
無人実行できる。** ただし本サイクルでは **deploy を実行しない**。
scripts / policies / tests / runbook を完成させ、人間が短命 credential を
投入できる直前で停止し、§10 を含めて報告する。
