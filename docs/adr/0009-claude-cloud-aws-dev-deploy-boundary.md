# ADR 0009: Claude Cloud から AWS dev への安全境界（qualifier 分離・スタック ARN 主境界・短命 STS 窓・IAM 記録のみ）

- ステータス: 承認（設計 + スクリプト/ポリシー/テストのみ。**IAM は未適用、`cdk deploy` は
  本サイクルで一度も実行していない**）。
- 関連: issue #680（本 ADR の対象）
- 関連ドキュメント: `docs/superpowers/specs/2026-08-12-claude-cloud-aws-dev-deploy-safety-design.md`
  （設計原本）、`docs/runbook-cloud-aws-deploy.md`（人間が実行する手順）、
  `docs/cloud-dev-environment.md`（クラウド環境の正本）
- 実装: `scripts/aws-policies/*.json`（5 ポリシー）、`scripts/aws-cloud-deploy.sh`（wrapper）、
  `scripts/aws-negative-tests.ts`、`scripts/aws-issue-credentials.sh`、
  `src/domain/governance/deploy-diff-gate.ts` / `deploy-preflight.ts` / `aws-policy-shape.ts` /
  `negative-test-outcome.ts`

## 背景

Claude Code on the cloud（クラウドセッション / cron routine）から AWS の dev 環境へ
デプロイできるようにしたい。従来は「対話型 SSO がクラウドセッションで使えないため不可」と
されていたが、これは誤りだった。実体は IAM **user**（`user/CDK`）＋静的アクセスキーであり、
技術的にはキーをクラウドへ渡せば今日でも動く。**やってはいけないのは、それが
`AdministratorAccess` の長期キーだからであって、SSO だからではない。**

対象の AWS アカウント `822063948773` は open-reception 専有ではない。実測（2026-08-12）で
**22 スタック・4 プロジェクト**（open-reception / nodi / salon-loop / Kiaff）が同居しており、
既定 bootstrap（qualifier `hnb659fds`）の CloudFormation 実行ロールは
`AdministratorAccess` を持ち、全ロールに Permissions Boundary が設定されていない。
守るべきは open-reception の prod（未存在）ではなく、**他プロジェクトの実リソース**である。

## 決定

### 決定 1: 隔離単位はアカウント分離ではなく、専用 CDK qualifier + IAM

新しい AWS アカウントを作って分離するのではなく、既存アカウント内で**専用の CDK bootstrap
qualifier（`orcloud01`）+ 専用 IAM ロール一式**によって隔離する。

| 案 | Pros | Cons | 採否 |
| --- | --- | --- | --- |
| **専用 qualifier + IAM**（採用） | 既存の 4 プロジェクトの運用（`user/CDK` によるデプロイ、請求、タグ体系）に一切手を触れない。実装がコード（IAM ポリシー JSON 5 本）で完結し、レビュー・テストできる | アカウント境界という OS レベルの隔離ではなく、IAM ポリシーの正しさに依存する | ○ |
| アカウント分離（新規 AWS アカウント） | AWS が提供する最も強い分離。IAM ポリシーの書き間違いに依存しない | 新規アカウント作成・組織設定・請求体系の変更が要り、他プロジェクトの運用にも影響しうる。継続的なアカウント管理コストが増える。本 issue のスコープ（dev のみ・IAM とサンドボックス的な bootstrap のみ）を超える | ✗ |

**理由**: 決定に要する変更範囲を IAM ポリシーとスクリプトに閉じ込められることを優先した。
`hnb659fds`（既定 qualifier）を使い続けると、そのロールへ到達できる主体は
CloudFormation 経由でアカウント全体に届いてしまう（`AdministratorAccess` の cfn-exec-role）。
専用 qualifier にすることで、assets バケット・trust policy・exec policy がすべて
既定 bootstrap から分離される。加えて、**wrapper を迂回して素の `cdk deploy` を打っても
既定 qualifier のロールを assume できずに失敗する**（fail-closed）。

### 決定 2: 主境界は名前 prefix ではなく CloudFormation スタック ARN

`OpenReception-*-dev` という名前で始まるリソースだけを許可する、という直感的な設計を
**採らなかった**。根拠は spec §2.3 の実測:

| リソース | 物理名 | prefix で絞れるか |
| --- | --- | --- |
| DynamoDB Table / Lambda Function | `OpenReception-Web-dev-...` | ○ スタック名由来 |
| S3 Bucket | `openreception-web-dev-assetbucket...` | △ ハイフン無しの別綴り |
| IAM Policy | `OpenR-Serve-E3jwlgROqB80` | ✗ `OpenR-` へ切り詰められる |
| Cognito UserPool | `ap-northeast-1_wZxroIjKo` | ✗ prefix 無し |
| CloudFront Distribution | `E3JHU0VUXEJJ0J` | ✗ prefix 無し |

Cognito / CloudFront / IAM Policy は**信用する以前に、そもそも名前で絞る手段が無い**。

| 案 | Pros | Cons | 採否 |
| --- | --- | --- | --- |
| **CloudFormation スタック ARN を主境界**（採用） | CDK の全操作は CloudFormation を通るため、`OpenReception-*-dev` のスタック ARN allowlist で操作単位を確実に絞れる。スタック名は `bin/open-reception.ts` が決定論的に付けるため信頼できる | exec role の resource スコープ自体は Cognito/CloudFront/IAM Policy について広くならざるを得ない（`*` を含む） | ○ |
| 物理リソース名 prefix（当初案） | resource ARN を直接絞れれば意味的に分かりやすい | 上表のとおり Cognito / CloudFront / IAM Policy で成立しない。使えないサービスがあるのに主境界に据えると、そこだけ穴が残る | ✗ |

**理由**: exec role の resource スコープが広い部分（層 2）は、それ単独では境界にならない
ことを認めた上で、**「exec role を pass できるのは deploy role だけ」＋「deploy role が
pass できるのは層 1 の allowlist に入るスタック操作のときだけ」**という 2 段階の組み合わせで
担保する設計にした。「exec role が `cloudfront:DeleteDistribution` を resource `*` で持つ」
ことは、`OpenReception-*-dev` スタックのテンプレートがそれを要求したときにしか行使されない。

**副作用と残存ギャップ**: changeSet ARN（`arn:...:changeSet/<name>/<id>`）は stack 名を
埋め込まない。そのため `DescribeChangeSet` / `ExecuteChangeSet` / `DeleteChangeSet` の
3 アクションは、stack ARN ではなく changeSet の**名前**（`claude-gate-*`）でしかスコープ
できない。結果として、この 3 アクションは deploy role 単体の層では**アカウント全体**で
`claude-gate-*` という名前の changeSet に対して許可されており、**構造的に閉じられない**。
悪用には foreign stack 上にあらかじめ `claude-gate-*` という名前の changeSet が存在している
ことが前提で、かつ deploy role はそのような changeSet を自分で作れない（`CreateChangeSet`
は stack ARN で認可され、foreign stack は層 1・3 で Deny 済み）。実行を伴う操作は
cfn-exec role 側の `DenyForeignProjectStacks`（層 3 相当）が第二の防波堤として止める。
現実的な露出は `DescribeChangeSet` による内容の閲覧と `DeleteChangeSet` による妨害に限定される
（詳細は `docs/runbook-cloud-aws-deploy.md` および spec §13）。

### 決定 3: 短命 STS の有効期限そのものをデプロイ窓とする

「デプロイ窓が開いている/閉じている」という状態を表す専用のファイルやフラグを別に持たない。
**`aws sts assume-role` で取得した STS credential が有効かどうか、それ自体が窓の状態である。**

| 案 | Pros | Cons | 採否 |
| --- | --- | --- | --- |
| **credential の有効期限＝窓**（採用） | 状態を 1 箇所にしか持たないため、状態同期のバグが原理的に起きない | 窓の残り時間を知るには credential 自体（`AWS_CREDENTIAL_EXPIRATION`）を読む必要がある | ○ |
| 別ファイル/フラグで窓の開閉を管理 | 「窓が開いているか」を credential を取得せずに問い合わせられる | 状態が 2 箇所（credential とフラグ）になり、食い違いうる。本リポジトリの `scripts/cloud-setup.sh` と環境ダイアログの間で実際にこの種の食い違いが起きたことがある | ✗ |

**理由**: `preflight` は `AWS_CREDENTIAL_EXPIRATION` から残り秒数を計算し、`deploy` は 40 分、
それ以外は 20 分を最低ラインとする（`src/domain/governance/deploy-preflight.ts`）。
credential を発行する `user/CDK` は IAM **user**（role ではない）なので role chaining の
1 時間上限は掛からず、entry role の `MaxSessionDuration`（43200 秒 = 12h）まで取れる。
既定は 4 時間（`scripts/aws-issue-credentials.sh` の既定 `--hours 4`）。窓の外（credential が
無い、または期限切れ）では AWS に一切触れず、デプロイ段を「credential 無しのためスキップ」と
明示的に記録して正常終了する。

### 決定 4: IAM Role/Policy の Add・Modify は止めずに記録する

`src/domain/governance/deploy-diff-gate.ts` の危険判定（dangerous diff gate）は、
CloudFormation change set の `AWS::IAM::Role` / `Policy` / `ManagedPolicy` に対する
`Add` / `Modify` を**自動デプロイの停止条件に含めない**（`DEPLOY_FLAG_REASONS` の
`iamPolicyChange` として記録するのみ）。停止するのは `Remove`（削除）と、action が
`Add`/`Modify` のいずれでもない値（`Import` / `Dynamic` / 将来 AWS が増やす未知の値、
`unknownAction`）、および `Replacement: True`/`Conditional` である。

| 案 | Pros | Cons | 採否 |
| --- | --- | --- | --- |
| **IAM Role/Policy の Add・Modify を止めずに記録**（採用） | `OpenReception-Web-dev` は IAM Role 4 個・Policy 3 個を含み、Lambda の権限が変わるたびに Modify が出る。一律停止にすると gate が恒常的に赤くなり、**赤を無視する習慣がつく方が危険**（`change-risk.ts` が report-only である理由と同じ判断） | 差分レビューを経ずに IAM の変更がそのまま `deploy` まで進む | ○ |
| IAM 変更を検出したら常に停止 | 差分を必ず人間が見てから通す、最も保守的な運用 | dev スタックの通常運用（Lambda 権限の Add/Modify）で gate が恒常的に赤くなる | ✗ |

**理由（根拠は Permissions Boundary）**: 止めなくてよい根拠は決定 1・2 で確立した層 4 の
Permissions Boundary にある。`cdk-orcloud01-cfn-exec-role-*` が新規作成する Role には
`OpenReceptionClaudeBoundary` の付与が
`iam:CreateRole`/`PutRolePolicy`/`AttachRolePolicy` の `Condition: { StringEquals:
{ "iam:PermissionsBoundary": ".../OpenReceptionClaudeBoundary" } }` で強制されるため、
**新しい Role が boundary を超える権限を持つことは構造的に不可能**。これは差分レビューより
強い保証である。この条件は素の `StringEquals` を使い、`AllowRoleMutationOnlyWithBoundary`
という専用のステートメントに分離してある（`lambda:*` 等の大きな Allow には含めない）。
`StringEqualsIfExists` のような `*IfExists` 系演算子は、対象 context key が存在しない
リクエスト（boundary パラメータ無しの `iam:CreateRole` 呼び出し）に対して無条件で `true` を
返すため、一見 boundary 条件が付いているように見えて実効性が無い。この区別は
`src/domain/governance/aws-policy-shape.ts` の `hasBoundaryCondition` が
`*IfExists` 系および `Null` 演算子を boundary 条件と認めないことで機械的に検証している。
Remove や Replacement は決定 4 の対象外で、通常どおり停止側に倒す。

## 未検証事項・撤回条件

- **`iam:SimulatePrincipalPolicy` による実 API 検証（12 コマンド、`docs/runbook-cloud-aws-deploy.md`
  ステップ 4b）は本サイクルで一度も実行されていない。** 実装の正しさは静的な構造検証
  （`auditPolicyDocument`）でのみ確認済み。**この 12 本が全て期待どおりの結果を返すことが、
  初回デプロイへ進む前提条件である。** 1 本でも違えば設計を見直す。
- dev が Secrets Manager や KMS を使い始めたら、`secretsmanager:*` / `kms:*` の全面 Deny
  （T8 対応）を見直す必要がある。意図的に fail-closed にしてあるため、境界の拡張が要る。
- open-reception の staging / prod スタックを新規作成するときは、層 1・3 の allowlist/denylist
  を拡張し、あらためて人間の承認を得る（本 ADR の対象は dev のみ）。
- `user/CDK` の `AdministratorAccess` + 長期アクセスキーは本 ADR のスコープ外。他 3 プロジェクト
  （nodi / salon-loop / Kiaff）の人間用デプロイ経路であるため、権限縮小は別途判断する。

## 停止手段・ロールバック

- **窓を閉じる**: `scripts/aws-issue-credentials.sh` で発行した credential は既定 4 時間
  （最大 12 時間）で自動失効する。早期に閉じたい場合は claude.ai/code の環境ダイアログから
  5 つの環境変数を削除する。
- **deploy role/ボリシーの撤去**: `aws iam delete-role-policy` / `aws iam delete-policy` で
  ステップ 1・3 の逆操作を行う。`cdk-orcloud01-*` ロールは `cdk bootstrap` が作った
  `CDKToolkit-orcloud01` スタックの一部であり、それ自体を削除すれば bootstrap ごと撤去できる。
  他 4 プロジェクトが使う既定 qualifier（`hnb659fds`）には一切触れないため、この撤去は
  他プロジェクトのデプロイに影響しない。
- **IAM は未適用**: 本 ADR 執筆時点で決定 1〜4 はコードとポリシー JSON としてのみ存在し、
  実際の AWS への適用（`docs/runbook-cloud-aws-deploy.md` ステップ 1〜3）はまだ行われていない。
