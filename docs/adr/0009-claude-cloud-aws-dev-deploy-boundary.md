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
  `negative-test-outcome.ts`、`infra/lib/config/claude-deploy-boundary.ts`（層 4 の
  アプリ側適用。決定 4 の訂正を参照）

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

**副作用と残存ギャップ（2026-08-13 の実測で訂正）**: 当初はここに「changeSet ARN は
stack 名を埋め込まないため、`DescribeChangeSet` / `ExecuteChangeSet` / `DeleteChangeSet`
の 3 アクションは stack ARN ではなく changeSet の**名前**でしかスコープできず、この
3 アクションはアカウント全体で `claude-gate-*` という名前の changeSet に対して許可されて
おり構造的に閉じられない」と書いていた。**この前提は `DescribeChangeSet` については
誤りだったと実測で判明した**（次段落）。

🔴 **認可の資源型はドキュメントの読解ではなく実 API 応答で確認する ―― この設計が
踏んだ失敗（教訓）。** AWS Service Authorization Reference の読解を根拠に
「`DescribeChangeSet` / `ExecuteChangeSet` / `DeleteChangeSet` は changeSet リソース
タイプに対して認可される」と結論し、主境界を changeSet **名前**スコープへ再設計した
（`ReadOwnDevStacksForDiffGate` から `DescribeChangeSet` を切り出し、`changeSet/claude-gate-*/*`
の別 Allow へ分離した）。ところが 2026-08-13 の実 `cdk deploy --no-execute` が返した
`AccessDenied` は次のとおり ―― **`resource` が `stack/...` ARN であり、`changeSet/...`
ARN ではない**（denial message は原文のまま記録する。これが唯一の証拠である）:

```
AccessDenied: User: arn:aws:sts::822063948773:assumed-role/OpenReceptionClaudeDeploy-dev/claude-cloud-20260814-0352
is not authorized to perform: cloudformation:DescribeChangeSet
on resource: arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/f9c7aab0-8f6f-11f1-be9b-0a2cf2440d9f
because no identity-based policy allows the cloudformation:DescribeChangeSet action
```

**`DescribeChangeSet` は stack ARN に対して認可される。** `iam:SimulatePrincipalPolicy` で
changeSet ARN ＋ `Resource: "*"` の最小 Allow を与えても `implicitDeny` になっていた実測
（`S16`、後述）は、道具の限界の証拠ではなく、**「changeSet ARN スコープの Allow では
このアクションは本来一致し得ない」という正しい応答**だった。この誤読を、シミュレータの
`implicitDeny` を「道具側の限界」と決め打ったことが後押しした ―― 本来なら「そもそも
この資源型で認可されているのか」を先に疑うべきだった。

> 🔴 **教訓**: An IAM action's authorisation resource type must be confirmed against a
> real API response, not inferred from documentation. A documentation reading
> redesigned the primary boundary around the wrong resource type; the simulator's
> inability to evaluate that type was evidence pointing at the error and was misread
> as a tooling limitation.

**対処**: `claude-deploy-entry.json` の `DescribeChangeSet` を `ReadOwnDevStacksForDiffGate`
（stack ARN の Allow）へ統合し、changeSet ARN スコープの `ReadOwnChangeSetsForDiffGate` は
削除した（一度も実際の権限として機能していなかった死んだステートメントだったため）。
`scripts/aws-negative-tests.ts` の `S16` も stack ARN へ向け直し、`S15` と同じ形で通常どおり
シミュレートできるようにした。

**`ExecuteChangeSet` / `DeleteChangeSet` はまだ未証明である。** これらは deploy 段の実行
（`cdk deploy`、`--no-execute` の diff 実行時の cleanup）でしか呼ばれず、今回の
`diff --no-execute` 実行では発火していない。stack ARN で認可されるのか changeSet 名前
スコープが必要なのかは実測していない。**推測で決めない**ため、
`claude-deploy-role-restriction.json` の deploy role 上乗せ Deny には、既存の stack ARN
許可リスト（`CreateChangeSet`/`DescribeChangeSet` を証明済みでカバーする）に加えて、
changeSet 名前スコープ（`claude-gate-*`）の許可エントリを**予防的な安全網として残して
ある**（次に `deploy` を実行して壊さないため）。この 2 アクションが実際にどちらの
資源型で評価されるかは、`bash scripts/aws-cloud-deploy.sh deploy` を実行して初めて
分かる。分かるまでは「`claude-gate-*` という名前の changeSet に対してアカウント全体で
許可されている可能性」という同じ形の残存ギャップが残る（詳細は spec §13）。
悪用には foreign stack 上にあらかじめ `claude-gate-*` という名前の changeSet が存在している
ことが前提で、かつ deploy role はそのような changeSet を自分で作れない（`CreateChangeSet`
は stack ARN で認可され、foreign stack は層 1・3 で Deny 済み）。実行を伴う操作は
cfn-exec role 側の `DenyForeignProjectStacks`（層 3 相当）が第二の防波堤として止める。

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

🔴 **2026-08-12 全体レビューでの訂正 — この根拠は当初、事実として成立していなかった。**
`cdk bootstrap --custom-permissions-boundary` が boundary を付けるのは
`CloudFormationExecutionRole` **1 リソースだけ**であり
（`infra/node_modules/aws-cdk/lib/api/bootstrap/bootstrap-template.yaml`）、
**CDK アプリが作る Role には何も付いていなかった**（`infra/` に
`PermissionsBoundary.of(...)` は無く、`infra/cdk.json` にも
`@aws-cdk/core:permissionsBoundary` は無く、wrapper も渡していなかった）。
つまり「新しい Role は構造的に boundary を超えられない」は偽であり、同時に初回の
CREATE（`OpenReception-CfMonitoring-dev`）が `iam:CreateRole` の Deny で
AccessDenied になる状態でもあった。`infra/lib/config/claude-deploy-boundary.ts` の
`applyClaudeDeployBoundary(app)` を配線し、wrapper が全 `cdk` 呼び出しで
`-c claudeBoundary=OpenReceptionClaudeBoundary` を渡すようにして初めて真になる。

🔴 **さらに `iam:PassRole` の抜け道があった（同レビュー Important 4）。** boundary を
強制しても、テンプレートが `Role.fromRoleArn('<既存の別ロール>')` を Lambda へ渡せば、
その Lambda は boundary の外で動く。change set 上は `AWS::Lambda::Function` の
`Add`（`SAFE_ACTION`）にしか見えず、gate は止めも記録もしない。決定 4 を維持するには
PassRole 側の制約が要るため、`iam:PassRole` を `iam:PassedToService` ＋
`aws:ResourceTag/Project` ＋ `aws:ResourceTag/Environment` で絞った（決定 6）。

### 決定 5: CDK の承認プロンプトを使わず、diff gate を唯一の承認者にする

`scripts/aws-cloud-deploy.sh` の **すべての** `cdk` 呼び出し（`diff` の
`--no-execute` と `deploy` の両方）に `--require-approval never` を渡す。

| 案 | Pros | Cons | 採否 |
| --- | --- | --- | --- |
| **`--require-approval never` ＋ diff gate が承認者**（採用） | 無人実行が成立する。承認基準がコード（`deploy-diff-gate.ts`）として読め、テストで固定でき、CDK の「権限が広がったか」より広い条件（Remove / 未知 action / Replacement / KMS / Secrets / Route53 / SecurityGroup / IAM プリンシパル）で止める | CDK 本体が持つ二重チェックを失う | ○ |
| 既定（`broadening`）のまま | CDK の安全網が残る | **クラウドサンドボックスには TTY が無い**ので、権限が広がる差分に当たった瞬間 `TtyNotAttached` を投げて必ず失敗する。しかも投げる**前**に `cleanupChangeSet()` を呼び、gate が判定に使った change set を削除する。決定 4 は「Lambda 権限変更のたびに IAM の Add/Modify が出る」ことを前提にしており、broadening は例外ではなく**通常運用**。つまりこの案では無人デプロイが原理的に成立しない | ✗ |

**理由**: `deploy-diff-gate.ts` の停止条件は CDK の `broadening` 判定より**厳しい**。
CDK が聞くのは「IAM/セキュリティグループの権限が広がったか」だけだが、gate は
リソース削除・replacement・未知の action・KMS/Secrets/DNS/SG/IAM プリンシパルの
出現でも止める。したがって承認機構を失ってはいない。

**この決定に付随する失敗の型**: gate を外すと `never` だけが丸裸で残る。
`tests/hooks/aws-cloud-deploy.test.ts` は「全 `cdk` 呼び出しが `never` を渡すこと」と
「`deploy` ケースが `cdk deploy` の**前**に `run_diff_gate` を通すこと」を**対で**
固定してある（前者だけだと、gate 削除に気づけない）。

### 決定 5b: 人間の承認は「差分に固定されたトークン」として渡す（#680）

決定 5 で diff gate を唯一の承認者にしたが、**gate が止めたあと人間が承認して先へ進む
経路が実装されていなかった**。runbook は「人間が手で流す」としか書いておらず、実際に
そうすると wrapper の preflight（資格情報の残時間・品質ゲート記録・ツリーの清潔さ・
HEAD が push 済みか）と negative security test 8 本が**まるごと省略される**。
要件は「gate を skip して deploy を成功させることは禁止」なので、この抜け道は塞ぐ。

| 案 | Pros | Cons | 採否 |
| --- | --- | --- | --- |
| **承認トークン（採用）** … `diff` がブロック時に findings のダイジェストを印字し、`deploy` は `OR_APPROVED_DIFF` に一致するトークンが渡されたときだけ通す | 承認が**その差分に固定**され、findings が変われば自動的に無効。preflight と negative test を経由したまま承認できる。承認の事実と内容がログに残る | 仕組みが 1 つ増える | ○ |
| wrapper の外で `cdk deploy` を直に叩く | 追加実装ゼロ | preflight と negative test 8 本が省略される。**要件が明示的に禁じている** | ✗ |
| gate をブール env（`OR_SKIP_DIFF_GATE=1` 等）で無効化 | 実装が最小 | 承認が差分に紐づかない。一度書いたら以降のあらゆる差分を通す。停止境界の意味が消える | ✗ |

**保証すること**: 承認は人間が見た findings 集合に固定される。`reason` だけでなく
`evidence`（論理 ID・リソース型・action）まで含めてダイジェストを取るので、
「同じ理由で別のリソースが置換される」差分は別トークンになる。

**保証しないこと**: トークンは秘密ではない（誰でも計算できる）。これは*認証*ではなく
**取り違え防止**であり、実行を止める力は IAM 境界（boundary / restriction ポリシー）が持つ。

**この決定に付随する失敗の型**: 承認が `diff` にも効いてしまうと、「承認済みだから差分が
無いように見える」状態を作る。`aws-diff-gate.ts` はモードを CLI 引数で受け取り、
**既定は `diff`（承認を無視する側）**。`tests/hooks/aws-cloud-deploy.test.ts` が
「gate を呼ぶ箇所はすべてモードを明示している」ことと既定値を固定している。

### 決定 6: `iam:PassRole` は「渡す先のサービス」と「タグ」で絞る

`claude-cfn-exec.json` / `claude-boundary.json` の `iam:PassRole` を
`Resource: "*"` の無条件 Allow から、次の条件付き Allow へ変更する。

- `iam:PassedToService` が dev スタックが実際に必要とするサービスであること
- `aws:ResourceTag/Project` = `open-reception` かつ `aws:ResourceTag/Environment` = `dev`

| 案 | Pros | Cons | 採否 |
| --- | --- | --- | --- |
| **PassedToService ＋ タグ条件**（採用） | 「テンプレートが要求したときにしか行使されない」という層 2 の論拠に依存しなくなる。テンプレートを書くのは**脅威モデルが侵害を仮定しているサンドボックス自身**（spec §3）なので、その論拠だけでは弱い | 全 dev リソースにタグが付いていることに依存する（`applyCostTags` が `Tags.of(stack)` で `Project`/`Environment` を全 taggable リソースへ付与しているので成立するが、**AWS 認証情報が無いため実測で確認できていない**） | ○ |
| `Resource: "*"` のまま | 壊れない | `Role.fromRoleArn('<lambda.amazonaws.com を信頼する既存ロール>')` を足すだけで boundary の外に出られる。diff gate からは `AWS::Lambda::Function` の `Add` にしか見えない | ✗ |

🔴 **これが初回デプロイで AccessDenied になる最有力候補である。** 検証は
`docs/runbook-cloud-aws-deploy.md` ステップ 4b の 14〜16 で行う。
1 本でも denied なら、タグ条件（`aws:ResourceTag/*`）を外して
`iam:PassedToService` だけに緩めるのが最初の切り分けである。

### 決定 7: 他プロジェクトの IAM ロール / ポリシーへの書き込みを明示 Deny する

`claude-cfn-exec.json` は `iam:DeleteRole` / `CreatePolicy` / `DeletePolicy` /
`CreatePolicyVersion` / `DeletePolicyVersion` / `DeleteRolePolicy` /
`DetachRolePolicy` を `Resource: "*"` で Allow している。層 3 の denylist は
CloudFormation スタック・DynamoDB/S3 データ・`cdk-*` ロールへの
`sts:AssumeRole`/`iam:PassRole` は覆うが、**他プロジェクトの IAM ロールと
ポリシーそのものは覆っていなかった**。`iam:CreatePolicyVersion --policy-arn
.../SalonLoopStagingCfnExecution --set-as-default` で別プロジェクトの実行ポリシーを
書き換えられ、`iam:DeleteRole` で `cdk-hnb659fds-cfn-exec-role-*` を消せば
4 プロジェクト全部のデプロイが壊れる。

対処は 2 段構え（`DenyIamWriteOnForeignPrincipals` / `DenyIamRoleWriteOutsideProject`）。

1. **名前による明示 Deny**（確実に効く）。🔴 **role 側と policy 側の列挙は対称ではない**
   —— 対称であるかのように 1 行で書くと、実装が覆っていない範囲を覆っていると
   読ませてしまう（2026-08-12 残件レビュー R7 での訂正）。出荷している 16 エントリの内訳:

   | 種別 | 列挙している名前 |
   | --- | --- |
   | `role/` | `cdk-hnb659fds-*` / `cdk-staging-*` / `cdk-orcloud01-*` / `OpenReceptionClaudeDeploy-dev` / `nodi-*` / `salon-loop-*` / `Kiaff*` |
   | `policy/` | `cdk-hnb659fds-*` / `cdk-staging-*` / `nodi-*` / `salon-loop-*` / `Kiaff*` / `SalonLoop*` / `Nodi*` / `OpenReceptionClaude*` |
   | `user/` | `*`（全ユーザー） |

   `cdk-orcloud01-*`（**自分のチェーン**。deploy role の層 1 インラインポリシーを
   `iam:DeleteRolePolicy` で剥がされたら主境界が消える）は role 側だけ、
   `SalonLoop*` / `Nodi*` / `OpenReceptionClaude*`（**exec ポリシー・boundary 自身の
   書き換えを塞ぐ**）は policy 側だけにある。片方の欄にあるものがもう片方にもあると
   仮定しないこと。
2. **タグ条件による一般化**（role にだけ効く）: `iam:DeleteRole` / `UpdateRole` /
   `UpdateAssumeRolePolicy` / `DeleteRolePolicy` / `DetachRolePolicy` の **5 つ**を
   `aws:ResourceTag/Project != open-reception` で Deny する
   （`iam:UpdateRole` が抜けていたのも R7 での訂正）。
   ただし #680 R3 の carve-out（決定 8）を `NotResource` で除外する。

🔴 **タグ条件は一般解にならない。** `AWS::IAM::ManagedPolicy` は CloudFormation の
リソース仕様に `Tags` プロパティを持たないため、CDK が作るマネージドポリシーは
**必ず untagged になる**。`iam:CreatePolicyVersion` に
`StringNotEquals aws:ResourceTag/Project` を掛けると（キー欠如時に真なので）
**自分自身のポリシー更新まで Deny される**。よってポリシー系アクションは
名前による明示 Deny のみが頼りであり、**列挙から漏れた第三者ポリシーは覆えない**。
これは残存ギャップとして spec §13 に記載する（「実装した以上のカバレッジを主張しない」）。

### 決定 8: CDK custom-resource provider role を**名前で** carve-out する

`crossRegionReferences: true`（#303 の us-east-1 監視スタック）と
`autoDeleteObjects: true`（dev の S3）は、CDK の `CustomResourceProvider` 経由で
**生の `AWS::IAM::Role`** をテンプレートへ吐く。これは `iam.Role` construct ではないので
`ITaggable` ではなく（`applyCostTags` が届かない）、cross-region のものは
`prepareApp`（synth 中）で materialise されるため boundary Aspect よりも**後**に生える。
synth での実測（`infra/test/claude-deploy-boundary.test.ts`）:

| ロール | boundary | Project/Environment |
| --- | --- | --- |
| `CustomS3AutoDeleteObjects…`（Web-dev） | **付く** | 付かない |
| `CustomCrossRegionExportWriter…`（Web-dev） | 付かない | 付かない |
| `CustomCrossRegionExportReader…`（CfMonitoring-dev） | 付かない | 付かない |

このままだと初回デプロイは `iam:CreateRole` の AccessDenied → rollback →
rollback の `iam:DeleteRole` がタグ条件 Deny に当たって **`ROLLBACK_FAILED`** になる。

**決定**: `arn:aws:iam::822063948773:role/OpenReception-*-dev-Custom*` を carve-out する。
`iam:CreateRole` / `PutRolePolicy` / `AttachRolePolicy` の boundary 条件なし Allow、
`iam:PassRole`（`lambda.amazonaws.com` 縛りは維持、タグ条件のみ外す）、そして
**Deny が Allow に勝つ**ため `DenyRoleCreationWithoutBoundary` /
`DenyRoleCreationWithoutThisBoundary` / `DenyIamRoleWriteOutsideProject` を
`Resource` から `NotResource` へ変えて除外する。

**なぜこの粒度か**: 物理名は論理 ID を**スタック名の長さに応じて切り詰める**ため、
`CustomResourceProviderRole` も `CustomCrossRegionExport` も物理名には残らない
（実在名 2 本が ground truth。`src/domain/governance/cfn-generated-name.ts`）。
3 本すべてに当たり、かつスタック名の長さに依存しないのは `Custom` の 6 文字だけである。

🔴 **「取りうる最も狭いパターン」だとは主張しない（訂正: #680 R10）。** 2 本に分ければ
（`…-CustomCrossRegion*` ＋ `…-CustomS3AutoDelete*`）より狭く、`claude-boundary.json` の
残り 462 文字にも収まる。1 本を選んだ本当の理由は「**どのみち名前グロブでは
敵対的なテンプレートを防げない**」ことである —— 論理 ID・`RoleName`・`Path` はすべて
テンプレート側が決められ、切り詰めで区別できるサフィックスは物理名から消える。
狭さが買えるのは**事故耐性だけ**であり、それと引き換えにスタック名の長さ変更で
壊れる脆いパターンを選ぶ価値は無い。

### 決定 8b: carve-out の制動は IAM ではなく diff gate に置く（#680 R10）

**問題**: 決定 8 は boundary の強制を「名前」で外した。名前は守れない。とくに
**IAM のリソース ARN グロブでは `*` が `/` を跨ぐ**ので、`Path` を
`/OpenReception-x-dev-Custom/` にするだけで論理 ID に関わらず carve-out へ入る。
「名前を見ればおかしいと分かる」は成り立たない。

**影響範囲**: carve-out 前の上限は boundary（他プロジェクト不可・Secrets Manager 不可・
KMS 破壊不可・IAM 昇格不可）。carve-out 後の上限は**アカウント全体の Admin** であり、
うち 2 経路は**デプロイ窓を越えて残る**: (1) trust policy を外部アカウントや
`"AWS":"*"` に向けたロール（IAM に trust policy を縛る条件キーは存在しない。
`iam:PassRole` の `lambda.amazonaws.com` 縛りは**この経路の制約にならない** ——
PassRole を通る必要が無い）、(2) `AuthType: NONE` の `AWS::Lambda::Url`。

**決定**: carve-out は維持し、**`deploy-diff-gate.ts` で制動する**。gate は change set と
synth テンプレートを、1 バイトも AWS へ適用される前に読める我々自身のコードである。
停止理由は `carveOutRoleNamespace`（名前空間に入る未知のロール。物理名は生成名・
`RoleName`・`Path` を IAM と同じ規則で組む）／`carveOutRoleShape`（既知 3 本を名乗った
だけの実体。Add だけでなく **Modify** も見る）／`roleTrustPolicyEscape`／
`functionUrlExposure`／`publicInvokePermission`／`opaqueResourceShape`。
allowlist は `REVIEWED_CDK_GENERATED_LOGICAL_IDS` の 1 か所で、**載せることは
「CDK が決定論的に生成し、中身をレビューした」という主張**である。

🔴 **論理 ID の allowlist だけでは足りない、を隣の種別まで徹底する（2026-08-13 訂正）。**
当初の実装はロール本体しか見ておらず、**同じ権限が
`AWS::IAM::Policy` / `ManagedPolicy` / `RolePolicy` から別リソースとして届く**経路と、
`AWS::Lambda::Url` / `Permission` の**向き先**（`TargetFunctionArn` / `FunctionName`）が
未検査だった。どちらも allowlist 済みの名前を名乗るだけで迂回できたので、
`carveOutRoleShape` は付与リソース 3 種にも掛け、URL / Permission は
GetAtt 先を関数の論理 ID に固定する。carve-out に載せてよい action は
**synth で実測した 6 つの `ssm:` の許可リスト**（否認リストではワイルドカードが
サービス部分を跨ぐ書き方を列挙し切れない）。

**代替案とその却下理由**: IAM 側で `iam:AttachRolePolicy` に `iam:PolicyARN` 条件を
足す案は、`iam:PutRolePolicy` の経路が同じ強さで開いたままなので見かけ倒しであり、
provider 実装の変更で**初回デプロイを AccessDenied で壊す**。同じ性質を、壊しても
停止するだけの gate 側で固定した。

🔴 **gate は制動であって境界ではない。** `scripts/aws-cloud-deploy.sh` を迂回して
`cdk deploy` を直接叩けば動かず、IAM 側にそれを強制する手段は無い。
**迂回された場合の上限は Admin のままである。** 残存の一覧は spec §13、
承認者への説明は runbook 4d。

### 決定 8c: 脱出防止は「動詞」ではなく「遷移の向き」で書く（2026-08-14 の実地失敗）

当初 `claude-boundary.json` は `DenyBoundaryEscape` 1 文で
`iam:PutRolePermissionsBoundary` と `iam:DeleteRolePermissionsBoundary` を
**条件なし・`Resource:"*"`** で Deny していた。これが初回デプロイを止めた。

dev の Lambda 実行ロールは境界の仕組みが入る前（2026-08-06）に境界なしで作られており、
初回デプロイは「既存ロールに**我々の**境界を付ける」＝ `PutRolePermissionsBoundary` を
必要とする。自分の境界に自分で止められ、rollback も `Delete` が Deny されて失敗し、
`OpenReception-Web-dev` が `UPDATE_ROLLBACK_FAILED` に落ちた（runbook ステップ 9c）。

| 案 | Pros | Cons | 採否 |
| --- | --- | --- | --- |
| **遷移の向きで分ける（採用）** … `Delete` は無条件 Deny のまま、`Put` は「我々の境界 ARN 以外なら Deny」 | 脱出防止は完全に保たれる（付けられるのは我々の境界だけ・外すのは不可）。既存ロールへの後付けが通る | boundary が +194 文字（5,876 / 6,144。残り 268） | ○ |
| アプリロールに境界を付けない | IAM を触らない | 層 4（Permissions Boundary）がアプリロールに効かなくなる。Critical 2 の対策が無効化される | ✗ |
| 既存ロールを作り直す | IAM を触らない | ロール置換は Lambda 実行に波及し dev が落ちる。影響範囲が当初の差分より大きい | ✗ |

**理由**: 脱出防止で本当に禁じたいのは「**外す**」と「**弱いものへ差し替える**」であって、
「付ける」ではない。動詞（Put / Delete）で Deny を書くと、仕組み自身が必要とする操作まで殺す。

**この決定に付随する失敗の型**: 既存の「`deniedActions` に含まれる」テストは**条件付き
Deny でも通る**ため、この性質を固定できない。`aws-policy-shape.test.ts` の
「permissions boundary の付け外し」describe がドキュメントを直接見て、
(1) Delete の無条件 Deny、(2) Put の包括 Deny が無いこと、(3) Put の Deny が我々の境界以外に
限定されていること、(4) cfn-exec の Allow が境界限定であること、を固定する。
他プロジェクトのロールに対する条件なし Deny（`DenyIamWriteOnForeignPrincipals`）は
資源リスト付きなので数えない ―― あれは正当で残すべきもの。

**残るリスク（受容）**: 一度 boundary を付けたあとの更新が失敗すると、rollback が
「boundary を外す」を試みて再び `Delete` で失敗しうる。外せることの方が危険なので受容し、
対処は `continue-update-rollback --resources-to-skip`（runbook ステップ 9c）。

## 未検証事項・撤回条件

- **`iam:SimulatePrincipalPolicy` による実 API 検証（`docs/runbook-cloud-aws-deploy.md`
  ステップ 4a の S1〜S22 と、ステップ 4b・4c の 19 コマンド）を 2026-08-13 に実 IAM へ
  向けて初めて実行した。** 49/50 件が期待どおりで、残り 1 件（`S16`）は当時
  `implicitDeny` を返し続けた。
  🔴 **当初は「IAM のポリシーシミュレータが CloudFormation の `changeset` リソース種別を
  評価できない」という道具側の限界と解釈したが、この解釈自体が誤りだった。** 同日、
  実 `cdk deploy --no-execute` の `AccessDenied` が `resource: stack/OpenReception-Web-dev/<id>`
  ―― stack ARN ―― を名指しした（原文は決定 2 参照）。`DescribeChangeSet` は
  changeSet ARN ではなく stack ARN に対して認可される。`S16` の `implicitDeny` は
  シミュレータの限界の証拠ではなく、「changeSet ARN スコープでは本来一致し得ない」と
  いう正しい応答だった。**教訓: 認可の資源型はドキュメント読解ではなく実 API 応答で
  確認する**（詳細と原文は決定 2）。
  `claude-deploy-entry.json` を stack ARN の Allow へ統合し、`S16` も stack ARN へ
  向け直したことで、`S15`/`S16` はどちらも通常どおりシミュレートできるようになった
  （**この訂正後の値でステップ 4a を再実行してはいない** ―― IAM 側の変更適用は
  ユーザーが行う。次回実行時に両方 `allowed` になることを確認すること）。
  一方 `ExecuteChangeSet` / `DeleteChangeSet` がどちらの資源型で認可されるかは
  まだ実測していない（決定 2 の対処欄を参照）。**それ以外の全件が期待どおりであること**
  が前提条件であり、`ExecuteChangeSet`/`DeleteChangeSet` の資源型は
  `bash scripts/aws-cloud-deploy.sh deploy` を実行して初めて確定する。
  1 件でも期待と違えば設計を見直す。
  （番号は 1〜20 まで振ってあるが、ステップ 4b の**10 番はコマンドではなく
  「1〜9 を us-east-1 で繰り返せ」という指示**なので実コマンドは 19 本。
  「20 コマンド」は誤記だった ―― 2026-08-12 残件レビュー R7）
- 🔴 **決定 6（PassRole のタグ条件）が初回デプロイで AccessDenied になる最有力候補である。**
  条件は「渡される IAM Role に `Project`/`Environment` タグが実際に付いていること」に
  依存する。タグが付くこと自体は synth テストで確認済みだが、**IAM がそう評価するかは
  未検証**。切り分け順序は runbook ステップ 4b の 14〜16 のコメントに書いた。
- 🔴 **決定 8 の carve-out は実 IAM で一度も評価していない。** `NotResource` による
  Deny の除外が期待どおり働くか（＝carve-out に一致するロールの `iam:CreateRole` /
  `iam:DeleteRole` が allowed になるか）は、runbook ステップ 4a の **S17〜S20**
  （allowed / denied の 2 対）で確かめる。**S17 / S19 が `denied` なら初回デプロイは
  `ROLLBACK_FAILED` になる。S18 / S20 が `allowed` なら carve-out が広すぎる。**
  synth 側の前提（どのロールに boundary / タグが付かないか）は
  `infra/test/claude-deploy-boundary.test.ts` が実測で固定している。
  なお simulate 側は **boundary 文書を `--permissions-boundary-policy-input-list` で
  明示的に渡す**ようにした（#680 R10）。carve-out は cfn-exec ポリシーと boundary の
  2 枚で成立しており、`SimulatePrincipalPolicy` がアタッチ済み boundary を自動で
  含めるかどうかを AWS 抜きで確かめられない以上、**曖昧なまま「検証済み」と
  記録しない**ため。`iam:PassRole` の対（S21/S22）も `--context-entries` で
  `iam:PassedToService` を供給して追加した。
- 🔴 **決定 7 のポリシー系 Deny は名前の列挙のみである。** `AWS::IAM::ManagedPolicy` は
  CloudFormation に `Tags` を持たずタグ条件が使えないため、**列挙から漏れた第三者
  ポリシーは覆えない**。この account に新しいプロジェクトが増えたら列挙を見直すこと。
- **層 4 の boundary をアプリのロールへ適用する経路（`applyClaudeDeployBoundary`）は
  synth でしか検証していない。** 実際に `iam:CreateRole` が boundary 付きで呼ばれ、
  `AllowRoleMutationOnlyWithBoundary` の `StringEquals` に一致するかは初回デプロイで
  初めて分かる。boundary が Deny 側に当たる場合、`OpenReception-CfMonitoring-dev` の
  CREATE が AccessDenied で止まる（決定 4 の訂正を参照）。
- **boundary はアプリの実行ロールの天井でもある。** dev が新しい AWS サービスを使い
  始めたら（`secretsmanager` / `bedrock` / `polly` 等）、`claude-boundary.json` の
  Allow を広げないと**デプロイは成功するのに機能だけ実行時に壊れる**。
  現状の既知の追加は `ce:GetCostAndUsage` / `ce:GetCostForecast`（#377）のみ。
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
