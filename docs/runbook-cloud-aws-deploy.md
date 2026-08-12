# runbook: クラウドから AWS dev へのデプロイ

Claude Code on the cloud（クラウドセッション / cron routine）から、AWS の **dev 環境のみ**へ
`verify → preflight → diff → deploy → smoke` を無人実行できるようにするための、**人間が実行する**
手順。設計は `docs/superpowers/specs/2026-08-12-claude-cloud-aws-dev-deploy-safety-design.md`、
決定事項は `docs/adr/0009-claude-cloud-aws-dev-deploy-boundary.md` を参照する。

🔴 **本書を書いている時点で、この runbook のステップは 1 度も実行されていない。IAM は未適用、
dev への `cdk deploy` も未実施。** ステップ 1〜11 は人間が実際に手を動かして初めて検証される。

対象アカウント: `822063948773`（open-reception 以外に nodi / salon-loop / Kiaff が同居）。
リージョン: `ap-northeast-1`（主）+ `us-east-1`（`OpenReception-CfMonitoring-dev` のみ）。
qualifier: `orcloud01`。

---

## 全体像（アイデンティティチェーン）

```
[ローカル Mac・人間]
  user/CDK  (AdministratorAccess・既存・本設計では一切変更しない)
      │  aws sts assume-role --external-id open-reception-claude-cloud-dev
      ▼
  role/OpenReceptionClaudeDeploy-dev          ← ステップ 1 で作成（entry role）
      │  AWS_ACCESS_KEY_ID 等 5 変数（ステップ 5・6）
      ▼
[Claude Cloud サンドボックス]  scripts/aws-cloud-deploy.sh 経由でのみ cdk を実行
      │  cdk deploy -c env=dev -c @aws-cdk/core:bootstrapQualifier=orcloud01
      ▼
  role/cdk-orcloud01-deploy-role-822063948773-<region>   ← ステップ 2 (bootstrap) で作成、
      │                                                     ステップ 3 で層 1 の Deny を上乗せ
      ▼
  role/cdk-orcloud01-cfn-exec-role-822063948773-<region> ← ステップ 2 (bootstrap) で作成、
      │                                                     OpenReceptionClaudeCfnExec-dev +
      │                                                     OpenReceptionClaudeBoundary 付き
      ▼
  OpenReception-*-dev のリソースのみ
```

---

## ステップ 1: IAM 初期構築（boundary → entry role → cfn exec policy）

3 つのマネージドポリシー/ロールを、リポジトリの `scripts/aws-policies/*.json` から作る。
**人間が Admin 権限を持つ IAM user（`user/CDK`）で実行する。**

> 🔴 **`claude-boundary.json` は managed policy の 6,144 文字上限に近い。**
> 2026-08-12 時点で **5,682 文字（空白を除いた実サイズ。残り 462 文字）**。
> #680 R1 の carve-out を入れる前は 5,148 文字だったので、**1 回の増分で 534 文字
> 使った**。次にステートメントを足す人は、まず余白を測ること:
>
> ```bash
> node -e "const n=JSON.stringify(JSON.parse(require('fs').readFileSync('scripts/aws-policies/claude-boundary.json','utf8'))).length;console.log(n,'/ 6144  残り',6144-n)"
> ```
>
> 上限を超えると `create-policy` / `create-policy-version` が
> `LimitExceeded: Maximum policy size of 6144 bytes exceeded` で失敗する。
> 溢れそうなときは、ステートメントを削るのではなく **boundary を 2 本に分けて
> どちらも attach する**（IAM は 1 プリンシパルに boundary を 1 本しか付けられないので、
> **分割はできない**）—— つまり実質的には**アクションの列挙を整理するしかない**。
> 「入らないから Deny を削る」は境界の後退なので、必ず人間の承認を取ること。
> `claude-cfn-exec.json` は 4,813 / 6,144（残り 1,331）で余裕がある。

```bash
# 1) Permissions Boundary（層 4）を作成
aws iam create-policy \
  --policy-name OpenReceptionClaudeBoundary \
  --policy-document file://scripts/aws-policies/claude-boundary.json

# 2) CloudFormation 実行ロール用ポリシー（層 2・3）。
#    cfn-exec role 自体は cdk bootstrap（ステップ 2）が作るため、ここでは
#    aws iam create-role しない。--cloudformation-execution-policies へこの ARN を渡す。
aws iam create-policy \
  --policy-name OpenReceptionClaudeCfnExec-dev \
  --policy-document file://scripts/aws-policies/claude-cfn-exec.json

# 3) entry role（アイデンティティチェーンの起点）。
#    trust policy は user/CDK のみ・ExternalId 必須（claude-deploy-entry-trust.json）。
#    MaxSessionDuration は 12h（aws-issue-credentials.sh の --hours 上限と一致させる）。
aws iam create-role \
  --role-name OpenReceptionClaudeDeploy-dev \
  --assume-role-policy-document file://scripts/aws-policies/claude-deploy-entry-trust.json \
  --max-session-duration 43200

# 4) entry role の権限。内訳:
#      - sts:AssumeRole → cdk-orcloud01-{deploy,file-publishing,image-publishing}-role-*
#      - cloudformation:DescribeStacks / DescribeChangeSet（diff gate 自身が使う読み取り）
#    🔴 **cdk-orcloud01-lookup-role-* は入っていない（明示 Deny もしてある）。**
#    bootstrap テンプレートは lookup role に AWS 管理の ReadOnlyAccess を付け、
#    boundary は付けない。assume できるとアカウント全体（nodi / salon-loop / Kiaff）の
#    DynamoDB・S3・Lambda env・Cognito を読めてしまい、主境界を丸ごと迂回する。
#    dev は context provider（fromLookup 等）を一切使わないので不要である。
aws iam put-role-policy \
  --role-name OpenReceptionClaudeDeploy-dev \
  --policy-name OpenReceptionClaudeDeployEntry \
  --policy-document file://scripts/aws-policies/claude-deploy-entry.json
```

**entry role には Permissions Boundary を付けない。** 層 4 の boundary が強制されるのは
`cdk-orcloud01-cfn-exec-role-*`（と、それが新規作成する Role）だけで、これは次のステップの
`cdk bootstrap --custom-permissions-boundary` 経由で付与される。entry role 自身は
`claude-deploy-entry.json` の `DenyEverythingElseOutsideTheChain` で
`sts:AssumeRole` / `sts:GetCallerIdentity` / `cloudformation:DescribeStacks` /
`cloudformation:DescribeChangeSet` の 4 アクション以外を最初から全 Deny しており、
boundary を重ねても実効的な差が無い。

---

## ステップ 2: `cdk bootstrap`（2 リージョンぶん）

```bash
cd infra
npx cdk bootstrap aws://822063948773/ap-northeast-1 aws://822063948773/us-east-1 \
  --qualifier orcloud01 \
  --toolkit-stack-name CDKToolkit-orcloud01 \
  --cloudformation-execution-policies arn:aws:iam::822063948773:policy/OpenReceptionClaudeCfnExec-dev \
  --custom-permissions-boundary OpenReceptionClaudeBoundary \
  --trust 822063948773
```

これで `cdk-orcloud01-deploy-role-822063948773-<region>` /
`cdk-orcloud01-cfn-exec-role-822063948773-<region>` / file-publishing / image-publishing /
lookup の各ロールが作成され、boundary と exec policy が結びつく。

🔴 **`--custom-permissions-boundary` が boundary を付けるのは cfn-exec role 1 つだけである。**
bootstrap テンプレートで `PermissionsBoundary` プロパティを持つのは
`CloudFormationExecutionRole` のみ
（`infra/node_modules/aws-cdk/lib/api/bootstrap/bootstrap-template.yaml`）。
deploy / file-publishing / image-publishing / **lookup** には付かない。とくに lookup role は
AWS 管理の `ReadOnlyAccess` 付き・boundary 無しなので、entry role から到達させてはいけない
（ステップ 1 の 4 と 4b-13 を参照）。

そして **CDK アプリが作る Role にも付かない。** これは `infra/bin/open-reception.ts` の
`applyClaudeDeployBoundary(app)` が担当し、`scripts/aws-cloud-deploy.sh` が全 `cdk` 呼び出しで
`-c claudeBoundary=OpenReceptionClaudeBoundary` を渡すことで有効になる。
**これが無いと初回デプロイは必ず AccessDenied になる**
（`claude-cfn-exec.json` の `DenyRoleCreationWithoutBoundary` が boundary 無しの
`iam:CreateRole` を Deny し、`OpenReception-CfMonitoring-dev` の CREATE がまさにそれを呼ぶ）。
人間が `cdk` を直接叩いて dev を触るときも同じ context を渡すこと。

🔴 **`--toolkit-stack-name CDKToolkit-orcloud01` を必ず明示する。** `scripts/aws-cloud-deploy.sh`
側も全 `cdk deploy` 呼び出しで同じ `--toolkit-stack-name` を渡している
（`TOOLKIT_STACK_NAME="CDKToolkit-${QUALIFIER}"`）。**bootstrap と wrapper でこの名前が
ずれると、wrapper 側が既定の `CDKToolkit`（allowlist に無い名前）を探しに行く。**
致命的エラーにはならず try/catch で握りつぶされる経路があるが、`claude-deploy-role-restriction.json`
の `CDKToolkit-orcloud01` allowlist エントリが実際には一度も行使されない、という気づきにくい
劣化を生む。片方だけを変えない。

---

## ステップ 3: deploy role への層 1（スタック ARN allowlist）適用

bootstrap が作成した `cdk-orcloud01-deploy-role-*` へ、主境界となる Deny をインラインポリシーとして
上乗せする（2 リージョンぶん、ロール名が異なるので両方に適用する）。

```bash
aws iam put-role-policy \
  --role-name cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
  --policy-name OpenReceptionClaudeDeployRestriction \
  --policy-document file://scripts/aws-policies/claude-deploy-role-restriction.json

aws iam put-role-policy \
  --role-name cdk-orcloud01-deploy-role-822063948773-us-east-1 \
  --policy-name OpenReceptionClaudeDeployRestriction \
  --policy-document file://scripts/aws-policies/claude-deploy-role-restriction.json
```

---

## ステップ 4: 🔴 初回デプロイ前の必須ステップ — IAM の実 API 検証

これまでのステップは JSON の**構造**しか検証していない（`src/domain/governance/aws-policy-shape.ts`
の `auditPolicyDocument` は unit テストで固定されているが、実際に AWS が評価した結果ではない）。
ここで初めて実 API（`iam:SimulatePrincipalPolicy`）を使い、机上の設計どおりに Allow/Deny が
効くかを確認する。**Admin 権限を持つ人間の環境から実行する**
（`OpenReceptionClaudeDeploy-dev` は `iam:SimulatePrincipalPolicy` を持たない前提のため）。

### 4a. 自動化されている分（S1〜S22）

🔴 **各 check は「どのロールに対して」「どのリージョンで」評価するかを自分で宣言している。
5 つの ARN をすべて渡すこと。1 つでも欠けていると、スクリプトは既定値で埋めずに
`exit 2` で拒否する。** 実行は 1 回でよい（両リージョンを 1 回で回す）。

```bash
SIMULATE_ENTRY_ROLE_ARN=arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev \
SIMULATE_DEPLOY_ROLE_ARN_AP_NORTHEAST_1=arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
SIMULATE_DEPLOY_ROLE_ARN_US_EAST_1=arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-us-east-1 \
SIMULATE_EXEC_ROLE_ARN_AP_NORTHEAST_1=arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1 \
SIMULATE_EXEC_ROLE_ARN_US_EAST_1=arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-us-east-1 \
  npm run aws:negative-tests -- --simulate-only
```

出力は 1 件ごとに `S4 [exec@us-east-1] iam:CreateRole → denied（期待 denied）` と
`principal=<ARN>` / `resource=<評価した ARN>` / `guards=<どの層のどの Deny を問うているか>` を
並べて印字する。**どのロールを・どのリージョンの何に対して検査したのかを読み違えられない
形にしてある。** 片リージョンしか覆っていない check（S15/S16）は、結果より**前**に
`ℹ️ S15: ap-northeast-1 は未評価: <理由>` として理由つきで印字される。

> 🔴 **なぜ「`-us-east-1` 版でもう 1 度実行する」を廃止したか（2026-08-12 残件レビュー R4）。**
> 旧手順は「us-east-1 側も同じ 3 変数の `-us-east-1` 版で 1 度実行する」と指示していたが、
> `SIMULATED_CHECKS` のリソース ARN は**全部 `ap-northeast-1` にハードコード**されており、
> us-east-1 の entry-role 変種も存在しなかった。2 回目の実行で変わるのは
> `--policy-source-arn` だけで、**評価されるリソースは ap-northeast-1 のまま**である。
> つまり運用者は「us-east-1 検証済み」と記録するのに、us-east-1 のリソースは一度も
> シミュレートされていなかった。**ステップ 4 は初回デプロイを認可するゲート**なので、
> ここでの偽 PASS は本ブランチが繰り返し踏んでいる欠陥そのものだった。
> リソース ARN を region の関数にし、check ごとに `coverage`（両方 / 片方＋理由）を
> 宣言させ、principal も region ごとに別の変数へ分けた。
> 旧変数 `SIMULATE_DEPLOY_ROLE_ARN` / `SIMULATE_EXEC_ROLE_ARN` /
> `SIMULATE_PRINCIPAL_ARN` は設定されていると `exit 2` で止まる（古い手順を無言で
> 受け付けない）。

**S17〜S20 は carve-out（#680 R1/R2/R3）そのものを問う 2 対である。**

| id | 期待 | 意味 |
| --- | --- | --- |
| S17 | **allowed** | carve-out に一致する provider role は boundary 無しで `CreateRole` できる |
| S18 | denied | carve-out に一致しない役割名は従来どおり Deny |
| S19 | **allowed** | rollback / teardown が provider role を `DeleteRole` できる |
| S20 | denied | タグの無い他のロールは従来どおり削除できない |

🔴 **S17 / S19 が `denied` なら、初回デプロイは AccessDenied → rollback →
`ROLLBACK_FAILED` になる。** S18 / S20 が `allowed` なら carve-out が広すぎる。
**対の片方だけを見て進まないこと。**

**S21 / S22 は `iam:PassRole` の対である（#680 R10 で追加）。**

| id | 期待 | 意味 |
| --- | --- | --- |
| S21 | **allowed** | carve-out の provider role へは、タグ無しでも `lambda.amazonaws.com` として渡せる |
| S22 | denied | carve-out の外はタグ条件が残るので、タグの無いロールは渡せない |

> 以前ここには「`iam:PassRole` は S 系に入っていない。`iam:PassedToService` は
> リクエスト側の context key なので評価できない」と書いていた。**渡せる。**
> `--context-entries ContextKeyName=iam:PassedToService,ContextKeyValues=lambda.amazonaws.com,ContextKeyType=string`
> をスクリプトが供給する。**対の両方に同じ context を与えている**ので、S22 の
> `denied` が「タグ条件が効いた」ためであって「context が無かった」ためでないと言える。
> ステップ 4b の 14〜16 は引き続き実経路での確認として残す。

🔴 **Permissions Boundary は simulate へ明示的に渡している（#680 R10）。**
carve-out は `claude-cfn-exec.json` の Allow と `claude-boundary.json` の `NotResource` の
**2 枚**で成立しており、壊れると初回デプロイが Deny で落ちるのは boundary の方である。
`SimulatePrincipalPolicy` がアタッチ済み boundary を自動で含めるかどうかは AWS を
呼ばずには確かめられないので、`exec` の評価では
`--permissions-boundary-policy-input-list` で `scripts/aws-policies/claude-boundary.json`
を明示的に渡す。**何を込みで評価したかは結果行の `boundary=` / `context=` に出る** ——
「boundary 込みで検証した」と記録する前にその 2 行を見ること。
boundary を渡すのは `exec` だけである（`--custom-permissions-boundary` が boundary を
付けるのは cfn-exec role 1 つだけ。entry / deploy に渡すと偽の `denied` になる）。

> 🔴 **なぜ 3 つに分かれたか（2026-08-12 全体レビュー Critical 3）。** 旧手順は
> `SIMULATE_PRINCIPAL_ARN` に **entry role だけ**を渡していた。entry role は
> `DenyEverythingElseOutsideTheChain` で 4 アクション以外を最初から全 Deny するので、
> **S1〜S11 は `claude-boundary.json` と `claude-cfn-exec.json` が作られていようがいまいが
> 全部 `denied` を返す** —— つまり「絶対に落ちない検査」を、ADR が初回デプロイの
> 前提条件と呼んでいた。S4/S5/S7（boundary 脱出）・S6（PassRole）・S1/S3/S10 が
> 実際に問うているのは `cdk-orcloud01-cfn-exec-role-*` の権限である。
> `SIMULATE_PRINCIPAL_ARN` は**廃止**され、設定されていると `exit 2` で止まる
> （古い手順を無言で受け付けない）。

`npm run aws:negative-tests`（フラグ無し）は N 系（実試行）と S 系（シミュレーション）の**両方**を
走らせるので **Admin 専用**である。クラウドセッションからこのコマンドを叩くと、
`OpenReceptionClaudeDeploy-dev` は `iam:SimulatePrincipalPolicy` を持たないため S 系が全部
`unknown`（＝ FAIL 扱い）になる。クラウド側は `scripts/aws-cloud-deploy.sh` 経由で常に
`--live-only` が渡り、S 系は自動的にスキップされる。

### 4b. 🔴 手動でしか検証できない分（changeSet ARN スコープほか、実コマンド 15 本 + 4c の 4 本 = 19）

**このサイクルで一度も実行されていない。** AWS 認証情報が無く、`aws` コマンドの実行も
禁止されていたため、実装の正しさは `auditPolicyDocument` による**静的構造検証のみ**で
確認済みであり、**IAM の実際の評価結果は未証明**である。

**下記 1〜16（および 4c の 17〜20）を実行し、コメントに書かれた期待どおりの `EvalDecision` が返ることを確認する。
1 本でも期待と違ったら、初回デプロイへ進まない。**

> **番号は 20 まで振ってあるが、実行するコマンドは 19 本である。** 10 番はコマンドでは
> なく「1〜9 を us-east-1 で繰り返せ」という指示（したがって実際には 9 本増える）。
> 以前このページと ADR は「20 コマンド」と書いていた —— 2026-08-12 残件レビュー R7 で訂正。

`--policy-source-arn` は実在の IAM ロールでなければならない点に注意
（存在しない ARN を渡すとシミュレーションが別のエラーで失敗する）。

🔴 **14〜16（`iam:PassRole` の条件付き Allow）が、初回デプロイで AccessDenied になる
最有力候補である。** 詳細はそのコメントを読むこと。

```bash
# 1) entry role: DescribeStacks（自分の dev スタック） → allowed 期待
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev \
  --action-names cloudformation:DescribeStacks \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 2) entry role: DescribeChangeSet（自分の changeSet, claude-gate-*） → allowed 期待
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev \
  --action-names cloudformation:DescribeChangeSet \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:changeSet/claude-gate-abc1234/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 3) entry role: CreateChangeSet（entry role 自身は持つべきではない） → denied 期待
#    （entry role は cdk-orcloud01-deploy-role へ assume してから CDK 経由で
#      CreateChangeSet を叩く設計であり、entry role が直接持つ必要は無い。
#      allowed が返ったら意図しない権限付与＝バグ）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev \
  --action-names cloudformation:CreateChangeSet \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 4) entry role: ExecuteChangeSet（entry role 自身は持つべきではない） → denied 期待
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev \
  --action-names cloudformation:ExecuteChangeSet \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:changeSet/claude-gate-abc1234/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 5) CDK deploy role: CreateChangeSet（自分の dev スタック） → allowed 期待
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
  --action-names cloudformation:CreateChangeSet \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 6) CDK deploy role: DescribeChangeSet（自分の changeSet） → allowed 期待（IMPORTANT A の主眼）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
  --action-names cloudformation:DescribeChangeSet \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:changeSet/claude-gate-abc1234/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 7) CDK deploy role: ExecuteChangeSet（自分の changeSet） → allowed 期待（IMPORTANT A の主眼）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
  --action-names cloudformation:ExecuteChangeSet \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:changeSet/claude-gate-abc1234/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 8) CDK deploy role: DescribeStacks（自分の dev スタック） → allowed 期待
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
  --action-names cloudformation:DescribeStacks \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 9) CDK deploy role: DescribeChangeSet を claude-gate-* 以外の名前で試す → denied 期待
#    （NotResource allowlist が claude-gate-* にしか一致しないことの直接確認）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
  --action-names cloudformation:DescribeChangeSet \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:changeSet/some-other-name/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 10) 上記 1〜9 のうち us-east-1 が関係するもの（stack/changeSet の region 部分を
#     us-east-1、stack 名を OpenReception-CfMonitoring-dev に置き換えて）も同様に確認する
#     （OpenReception-CfMonitoring-dev は cross-region 参照のため us-east-1 固定）。

# 11) CDK deploy role: DeleteChangeSet（自分の changeSet） → allowed 期待
#     （`cleanupOldChangeset` が実行時の deploy で必ず呼ぶため必須。名前が衝突した
#     既存 change set を削除できないと `cdk deploy` の実行自体が失敗する）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
  --action-names cloudformation:DeleteChangeSet \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:changeSet/claude-gate-abc1234/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 12) CDK deploy role: DeleteStack（自分の dev スタック） → allowed 期待
#     （`--no-execute` の no-op 実行が REVIEW_IN_PROGRESS のスタック殻を残すことがあり、
#     人間が Admin から片付ける runbook 手順に DeleteStack 権限が要る）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
  --action-names cloudformation:DeleteStack \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 13) 🔴 entry role: lookup role への AssumeRole → denied 期待
#     （bootstrap テンプレートは lookup role に AWS 管理 ReadOnlyAccess を付け、
#     `--custom-permissions-boundary` は cfn-exec role にしか boundary を付けない。
#     ここが allowed だと、窓の間に nodi / salon-loop / Kiaff の DynamoDB・S3・
#     Lambda 環境変数・Cognito をアカウント全体で読める＝主境界の完全な迂回）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev \
  --action-names sts:AssumeRole \
  --resource-arns arn:aws:iam::822063948773:role/cdk-orcloud01-lookup-role-822063948773-ap-northeast-1 \
  --query 'EvaluationResults[0].EvalDecision' --output text

# ---------------------------------------------------------------------------
# 🔴 14〜16: iam:PassRole の条件付き Allow（ADR 決定 6 / Important 4）。
#
# **初回デプロイが AccessDenied になるなら、まずここを疑う。** `iam:PassRole` を
# `Resource: "*"` の無条件 Allow から
#   iam:PassedToService = lambda.amazonaws.com
#   aws:ResourceTag/Project = open-reception
#   aws:ResourceTag/Environment = dev
# の条件付きへ絞った。この 3 条件は AND であり、**渡される Role に 2 つのタグが
# 実際に付いていること**に依存する（`applyCostTags` が `Tags.of(stack)` で付与。
# タグが付くこと自体は `infra/test/claude-deploy-boundary.test.ts` が synth で
# 確認済みだが、**IAM が実際にそう評価するかは未検証**）。
#
# 14 が denied だった場合の切り分け順序:
#   1) タグ条件（`aws:ResourceTag/*` の 2 行）を外して `iam:PassedToService` だけに緩める
#   2) それでも denied なら `iam:PassedToService` の値を増やす
#      （`edgelambda.amazonaws.com` / `apigateway.amazonaws.com` 等）
#   3) 最後の手段として `Resource: "*"` の無条件 Allow に戻す。**戻したら
#      ADR 決定 6 を「撤回」として更新すること**（黙って戻さない）
# ---------------------------------------------------------------------------

# 14) cfn-exec role: dev の Lambda 実行ロール（タグ付き）への PassRole → allowed 期待
#     --context-entries で条件キーの値を明示しないと simulate はキー未設定として
#     評価するため、必ず 3 つとも渡す。
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1 \
  --action-names iam:PassRole \
  --resource-arns 'arn:aws:iam::822063948773:role/OpenReception-Web-dev-ServerFnServiceRoleDUMMY' \
  --context-entries \
      'ContextKeyName=iam:PassedToService,ContextKeyValues=lambda.amazonaws.com,ContextKeyType=string' \
      'ContextKeyName=aws:ResourceTag/Project,ContextKeyValues=open-reception,ContextKeyType=string' \
      'ContextKeyName=aws:ResourceTag/Environment,ContextKeyValues=dev,ContextKeyType=string' \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 15) cfn-exec role: 別プロジェクトのタグが付いたロールへの PassRole → denied 期待
#     （タグ条件が実際に効いていることの直接確認。ここが allowed なら
#      `aws:ResourceTag` 条件が機能しておらず、Important 4 は塞げていない）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1 \
  --action-names iam:PassRole \
  --resource-arns 'arn:aws:iam::822063948773:role/salon-loop-staging-SomeRole' \
  --context-entries \
      'ContextKeyName=iam:PassedToService,ContextKeyValues=lambda.amazonaws.com,ContextKeyType=string' \
      'ContextKeyName=aws:ResourceTag/Project,ContextKeyValues=salon-loop,ContextKeyType=string' \
      'ContextKeyName=aws:ResourceTag/Environment,ContextKeyValues=staging,ContextKeyType=string' \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 16) cfn-exec role: lambda 以外のサービスへの PassRole → denied 期待
#     （PassedToService 条件が効いていることの直接確認）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1 \
  --action-names iam:PassRole \
  --resource-arns 'arn:aws:iam::822063948773:role/OpenReception-Web-dev-ServerFnServiceRoleDUMMY' \
  --context-entries \
      'ContextKeyName=iam:PassedToService,ContextKeyValues=ec2.amazonaws.com,ContextKeyType=string' \
      'ContextKeyName=aws:ResourceTag/Project,ContextKeyValues=open-reception,ContextKeyType=string' \
      'ContextKeyName=aws:ResourceTag/Environment,ContextKeyValues=dev,ContextKeyType=string' \
  --query 'EvaluationResults[0].EvalDecision' --output text
```

### 4c. 他プロジェクトの IAM への書き込みが塞がっているか（ADR 決定 7 / Important 5）

`claude-cfn-exec.json` は `iam:DeleteRole` / `CreatePolicyVersion` 等を `Resource: "*"` で
Allow している（CDK が自分のロール・ポリシーを更新するのに要る）。塞いでいるのは
`DenyIamWriteOnForeignPrincipals`（**名前による明示 Deny**）と
`DenyIamRoleWriteOutsideProject`（**タグ条件。role にだけ効く**）の 2 つ。

```bash
# 17) cfn-exec role: 共有 bootstrap の cfn-exec role を削除 → denied 期待
#     （allowed だと 4 プロジェクト全部のデプロイを壊せる）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1 \
  --action-names iam:DeleteRole \
  --resource-arns arn:aws:iam::822063948773:role/cdk-hnb659fds-cfn-exec-role-822063948773-ap-northeast-1 \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 18) cfn-exec role: 別プロジェクトの実行ポリシーを書き換える → denied 期待
#     （`--set-as-default` 付きの CreatePolicyVersion は中身を丸ごと差し替えられる）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1 \
  --action-names iam:CreatePolicyVersion iam:SetDefaultPolicyVersion \
  --resource-arns arn:aws:iam::822063948773:policy/SalonLoopStagingCfnExecution \
  --query 'EvaluationResults[*].EvalDecision' --output text

# 19) cfn-exec role: **自分のチェーン**（deploy role）から層 1 のインラインポリシーを
#     剥がす → denied 期待。これが allowed だと主境界そのものを外せる
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1 \
  --action-names iam:DeleteRolePolicy \
  --resource-arns arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 20) cfn-exec role: 自分の（タグ付き）dev ロールの削除 → allowed 期待
#     （19 の Deny が広すぎて通常のスタック更新まで壊していないことの対照）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1 \
  --action-names iam:DeleteRole \
  --resource-arns 'arn:aws:iam::822063948773:role/OpenReception-Web-dev-ServerFnServiceRoleDUMMY' \
  --context-entries \
      'ContextKeyName=aws:ResourceTag/Project,ContextKeyValues=open-reception,ContextKeyType=string' \
  --query 'EvaluationResults[0].EvalDecision' --output text
```

🔴 **タグ条件は一般解ではない。** `AWS::IAM::ManagedPolicy` は CloudFormation の
リソース仕様に `Tags` を持たないため、CDK が作るマネージドポリシーは必ず untagged になる。
`iam:CreatePolicyVersion` に `StringNotEquals aws:ResourceTag/Project` を掛けると
（キー欠如時に真なので）**自分自身のポリシー更新まで Deny される**。よって
ポリシー系アクションは**名前による明示 Deny のみ**が頼りであり、列挙から漏れた
第三者ポリシーは覆えない（spec §13 の残存リスクに記載）。

`DeleteStack`（12 番目）は 3 つの dev スタック全部（`OpenReception-Web-dev` /
`OpenReception-WebMonitoring-dev` / `OpenReception-CfMonitoring-dev`、最後のみ us-east-1）に
対して確認すること。**これが本設計で唯一、机上でしか確認できていない部分である。**
とくに重要な確認対象:

- deploy role の `DescribeChangeSet` / `ExecuteChangeSet` on `changeSet/claude-gate-*/*`（6・7）
- `claude-gate` 以外の名前が Deny されること（9）
- `DeleteChangeSet`（11、2 回目以降のデプロイで `cleanupOldChangeset` が必要とする）
- `DeleteStack`（12、`--no-execute` の no-op が残した `REVIEW_IN_PROGRESS` スタックの掃除用）

### 4d. 🔴 承認する前に読むこと — carve-out の影響範囲と、それを抑えているもの（#680 R1/R2/R3/R10）

ステップ 4 を PASS させて初回デプロイを認可するとき、**あなたは次のことも一緒に
承認している**。

`arn:aws:iam::822063948773:role/OpenReception-*-dev-Custom*` は Permissions Boundary の
強制とタグ条件 Deny から**除外されている**（CDK の `crossRegionReferences` /
`autoDeleteObjects` が作る provider role にはどちらも付かないため。理由と実測は
ADR 0009 決定 8 と spec §4.2 層 4）。

**サンドボックスはテンプレートを書く。** 名前グロブはそれを防げない ——
論理 ID も `RoleName` も `Path` もテンプレート側が決められ、しかも
**IAM のリソース ARN グロブでは `*` が `/` を跨ぐ**ので、`Path` を
`/OpenReception-x-dev-Custom/` にするだけでこの名前空間に入る。
「名前を見ればおかしいと分かる」は**成り立たない**。

#### 影響範囲（丸めずに書く）

carve-out **前**は、敵対的なデプロイは boundary で頭打ちだった（他プロジェクト不可・
Secrets Manager 不可・KMS 破壊不可・IAM 昇格不可）。carve-out **後**は、
この名前空間に作られたロールに boundary が無いため、**到達しうる上限は
アカウント全体の Admin** である。`nodi` / `salon-loop` / prod も含む。
さらに 2 つの経路は**デプロイ窓が閉じたあとも残る**:

1. **trust policy はテンプレート側が決める。** IAM には trust policy の中身を縛る
   条件キーが無い。外部アカウント（あるいは `"AWS":"*"`）を信頼するロールは、
   資格情報が失効したあとも外から assume できる。`iam:PassRole` が
   `lambda.amazonaws.com` 限定であることは**この経路に対して何の制約にもならない**
   （PassRole を使う必要が無い）
2. **`AWS::Lambda::Url` の `AuthType: NONE`。** 境界の無いロールを持つ Lambda に
   公開 HTTPS の入口が付く。これも資格情報の失効を越えて残る

#### いま抑えているのは boundary ではなく diff gate である

**この 2 経路と名前空間への侵入を止めているのは `scripts/aws-diff-gate.ts`**
（`src/domain/governance/deploy-diff-gate.ts`）であり、Permissions Boundary ではない。
gate は change set と synth テンプレートを、**1 バイトも AWS に適用される前に**読む:

- carve-out の名前空間に入る `AWS::IAM::Role` は、既知の CDK provider role 3 本以外
  **停止**（`carveOutRoleNamespace`）。物理名は IAM が見るとおりに組む
  （生成名の切り詰め・明示 `RoleName`・`Path`）
- その 3 本を**名乗った**だけのロールも、実体が CDK の生成する形と違えば**停止**
  （`carveOutRoleShape`）。固定しているのは
  **trust policy の Principal（`lambda.amazonaws.com` のみ）と Action
  （`sts:AssumeRole` のみ）／managed policy（基本実行ロールのみ）／
  action と Resource の許可リスト**の 4 点。
  action は **synth で実測した 6 つの `ssm:` アクションだけを許す**（否認リストでは
  ない —— `iam:` のようなコロン込みの接頭辞で禁じても `iam*` `sts*` `*:*`
  `*:CreateRole` がすり抜けるので、2026-08-13 に許可リストへ反転した）。
  `Resource` も**実測どおり `parameter/cdk/exports/` の下**に閉じていることを要求する
  （自アカウント固定、リージョンは具体値。`*` や `parameter/*` は停止）——
  action だけを縛っても `ssm:DeleteParameters` on `*` は
  **アカウント全体の SSM パラメータを静かに消せる**。`Condition` は権限を
  狭める方向にしか働かないので見ない。
  **Add だけでなく Modify も見る** —— trust policy は物理名を変えずに書き換えられる
- 🔴 **権限は「ロールの Properties」以外からも届く。** `AWS::IAM::Policy` /
  `ManagedPolicy` / `RolePolicy` が `Roles` / `RoleName` で carve-out のロールを
  指していれば、**同じ action / Resource 許可リスト**を掛けて**停止**する（IAM 側は
  `AllowCdkProviderRoleMutationWithoutBoundary` で `iam:PutRolePolicy` /
  `AttachRolePolicy` を carve-out ARN に対し無条件に許しているので、ここを見ないと
  「インラインを 1 つ左のリソースへ移す」だけで迂回できる）。付与先が静的に
  決まらなければ**通さない**。`Users` / `Groups` への付与も停止
- carve-out の**外**のロールでも、外部アカウント／`"AWS":"*"`／`Federated` を信頼する
  trust policy は**停止**（`roleTrustPolicyEscape`）
- `AWS::Lambda::Url` は WebStack の 2 本（server / image）以外**停止**
  （`functionUrlExposure`）。image は常に `AWS_IAM`（#631）。
  **論理 ID だけでなく `TargetFunctionArn` の向き先も固定する** ——
  初回デプロイでは全リソースが `Add` なので、allowlist の論理 ID を本物の
  `ServerFn` / `ImageFn` へ結び付けているものは他に何も無い
- `Principal: "*"` の invoke 許可は origin-verify 方式で CDK が足す 2 本以外**停止**
  （こちらも `FunctionName` の向き先を固定する）。別アカウントへの invoke 許可、
  および**自アカウントを名指しする `SourceAccount` / `SourceArn` を持たない
  サービスプリンシパル宛の許可**も**停止**（`publicInvokePermission`）——
  source 条件の無い `apigateway.amazonaws.com` は別アカウントの API から
  呼べる、実在する越境経路である
- 上のどれも「テンプレートを読めた」ことが前提なので、**読めなければ停止**
  （`opaqueResourceShape`）

#### それでも残ること（gate を通り抜けられるもの）

- **gate はサンドボックスの中で走る。** `scripts/aws-cloud-deploy.sh` を迂回して
  `cdk deploy` を直接叩けば gate は動かない。IAM 側にこれを強制する仕組みは無い
  （層 1 は「どのスタックか」しか見ない）
- **既知の 3 本を名乗りつつ、許可リストの中で振る舞う**ことはできる。
  boundary の無いロールに `ssm:PutParameter` / `DeleteParameters` を
  **`parameter/cdk/exports/` の下**で持たせることは通る（provider が実際に
  そうするため）。到達範囲は**このアカウントの CDK cross-region export
  パラメータ**であり、他の CDK アプリのものを**上書き・削除**して
  そのスタックのデプロイを壊すことはできる。`Resource` を `*` や
  `parameter/*` へ広げる経路と、`s3:` `dynamodb:` `logs:` `iam:` などの
  action は 2026-08-13 の 2 段の許可リスト化で**通らなくなった**
- `Condition` は見ていない。condition は権限を**狭める**方向にしか働かないので、
  無視しても安全側に外れる（provider が付ける condition を要求すると、
  CDK 実装の変更で初回デプロイを止める側の risk だけが増える）
- **carve-out の外のロール**は boundary で頭打ちだが、trust policy が
  組み込み関数で書かれていると gate は読み切れず、**止めずに記録する**
  （`opaqueRoleTrustPolicy`。ここを止めると正当な初回デプロイが通らない）

**要するに: carve-out の爆発半径はアカウント全体であり、それを実際に抑えているのは
境界ではなく diff gate である。** gate を迂回された場合の上限は Admin のままである。

**受け入れられないなら、初回デプロイへ進む前に設計判断へ差し戻すこと。**
選択肢は「`crossRegionReferences` をやめて CfMonitoring-dev の distributionId を
context で渡す」「`autoDeleteObjects` をやめてバケットの手動削除を運用に載せる」など。
どちらも carve-out 自体を不要にする（＝gate に依存しなくなる）。

---

## ステップ 5: 短命 STS を発行（窓を開ける）

**ローカル Mac の Admin 環境で人間が実行する。**

```bash
scripts/aws-issue-credentials.sh --hours 4
```

既定 4 時間、`--hours` は 1〜12 の範囲（ロールの `MaxSessionDuration` = 43200 秒 = 12h が上限）。
値は既定では表示されず、macOS のクリップボードへ直接入る（`--print` を明示したときのみ表示）。
**値をこの runbook や git や log に書かない。**

---

## ステップ 6: 環境ダイアログへ登録

claude.ai/code の環境ダイアログへ、次の**変数名 5 つ**を登録する（値はクリップボードから貼る。
値そのものはここにも記載しない）:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`
- `AWS_REGION`
- `AWS_CREDENTIAL_EXPIRATION`

---

## ステップ 7: 🔴 verify（**preflight より先に実行する**）

```bash
bash scripts/aws-cloud-deploy.sh verify
```

`./scripts/quality-gate.sh --pr` ＋ `npm run build:open-next` を実行する。

🔴 **これを先に走らせないと preflight は必ず失敗する（Important 7）。** preflight は
「現ツリーに対する品質ゲート green の記録（スタンプ）」を要求するが、**スタンプは
`git rev-parse --absolute-git-dir` の下、つまり `.git` 配下のローカルファイル**であり
（`scripts/lib/gate-stamp.sh`）、**clone にもブランチにも push にも付いてこない**。
新しいクラウドサンドボックスには存在しないので、`verify` が書くまで green の記録は無い。
**そのスタンプを書く手順は `verify` だけである。**

順序は `verify → preflight → diff → deploy → smoke`。
（本 runbook は以前 5 → 6 → 7=preflight と並べており、`verify` はどの手順からも
呼ばれていなかった。spec §12 / §15 も同じ誤りを持っていた。）

スタンプはゲートが検査した**ツリーの指紋**に紐づく。**`verify` の後にファイルを 1 文字でも
編集したら、走らせ直すこと。**

---

## ステップ 8: preflight

クラウドセッションから:

```bash
bash scripts/aws-cloud-deploy.sh preflight
```

caller identity / account / region / qualifier / environment / credential 残時間
（`deploy` は 40 分以上、それ以外は 20 分以上）/ working tree clean /
**HEAD が push 済み**（`headCommitPushed`。remote-tracking ref で判定。ネットワークへは
出ないので、必要なら先に `git push` しておく）/ 品質ゲート green スタンプ（`--pr` 相当。
ステップ 7 が書く）/ negative test（N 系のみ、`--live-only`）を検査する。
1 つでも不一致なら非ゼロで終了する。

---

## ステップ 9: diff

```bash
bash scripts/aws-cloud-deploy.sh diff
```

3 つの dev スタック（`OpenReception-Web-dev` / `OpenReception-WebMonitoring-dev` /
`OpenReception-CfMonitoring-dev`）それぞれについて `cdk deploy --no-execute --change-set-name
claude-gate-<short-sha>` で change set を作り、`describe-change-set` の JSON を
`src/domain/governance/deploy-diff-gate.ts` の危険判定に掛ける。危険な変更（`Remove` /
`Import` / `Dynamic` などの未知の action / replacement / KMS・Secrets・Route53・
SecurityGroup・IAM プリンシパルの変更 等）を検出したら非ゼロで終了し、`deploy` へ進まない。

**`OpenReception-CfMonitoring-dev` は現時点でアカウントに存在しない**（`Web-dev` と
`WebMonitoring-dev` のみ）。初回はここが CREATE 型の change set になり、全リソースが
`Add` として現れる。

---

## ステップ 10: deploy → smoke

```bash
bash scripts/aws-cloud-deploy.sh deploy
```

3 スタックぶんの diff gate をもう一度通してから（change set 名は同じ
`claude-gate-<short-sha>` を使うが、CDK は `cleanupOldChangeset` により**既存の同名 change set
を無条件に削除してから作り直す**ため、`diff` で承認したのと「同じオブジェクト」が
実行される保証はどこにも無い。ワーキングツリーが gate 通過後に変わっていなければ内容は
同一のはず、という前提に立つ）、`cdk deploy` を実行する。

成功したら、デプロイ済み URL（CloudFront ドメイン等）を使って smoke を実行する:

```bash
OR_SMOKE_URL=https://<デプロイ後のドメイン> bash scripts/aws-cloud-deploy.sh smoke
```

`scripts/url-quality-gate.sh` と `npm run test:e2e:live` を呼ぶ。

---

## ステップ 11: 窓を閉じる／再発行

デプロイが終わったら、claude.ai/code の環境ダイアログから 5 つの環境変数を削除する
（credential の有効期限＝窓なので、削除しなくても期限が来れば自動的に無効化されるが、
早めに閉じたい場合は明示的に削除する）。再度窓を開けるにはステップ 5 を再実行する。

---

## 運用上の注意

### `--live-only` と `--simulate-only` の分担

- **クラウド側**: `scripts/aws-cloud-deploy.sh` の `collect_observation` は常に
  `aws-negative-tests.ts --live-only` を呼ぶ。N 系（実試行・副作用なし）だけが走る。
- **人間の Admin 側**: `--simulate-only` で S 系（`iam:SimulatePrincipalPolicy` によるシミュレーション、
  破壊系は実試行しない）を走らせる（ステップ 4a）。**principal ごとの ARN を 3 つ渡す。**
- `npm run aws:negative-tests`（フラグ無し）は両方を走らせるので **Admin 専用**である。
  クラウドから叩くと `OpenReceptionClaudeDeploy-dev` が `iam:SimulatePrincipalPolicy` を
  持たないため S 系が全部 `unknown`（＝ FAIL 扱い）になる。
- **`S11`（`iam:CreateAccessKey` on `user/CDK` の Deny）は `--live-only` では一度も検証されない。**
  人間の simulate 実行（ステップ 4a）が唯一の検証手段である。もともとは live check（N8）
  として実装されていたが、Deny が効いていない場合に本物の長期アクセスキーを
  `AdministratorAccess` principal 上に発行してしまう副作用があったため、シミュレーションへ
  移した。

### 既知の副作用とクリーンアップ

- `aws-cloud-deploy.sh diff` は、変更が無いスタックにも**空の `FAILED` change set を残す**
  （`--no-execute` では CDK がクリーンアップしない）。自動クリーンアップ経路は無く、
  人間が Admin から `aws cloudformation delete-change-set` で個別に消す必要がある。
- 未作成のスタックに対して `--no-execute` を実行すると、**`REVIEW_IN_PROGRESS` のスタック殻**
  が残る。ステップ 4b の 12 番目（`DeleteStack`）はこの掃除のために deploy role へ確認する。
- **`OpenReception-CfMonitoring-dev` は現時点でアカウントに存在しない**（`Web-dev` と
  `WebMonitoring-dev` のみ）。初回デプロイはこのスタックが CREATE 型の change set になる。

---

## トラブルシュート

### クラウドセッションの `gh` 制約

`gh pr list` / `gh repo view` は GraphQL API が絞られていて **403** になる。
`gh pr create` / `gh pr merge` は通る。一覧・詳細取得系は REST の
`gh api repos/{owner}/{repo}/...` を使う。

### `--toolkit-stack-name` が実は使われていない

ステップ 2 の bootstrap と、`scripts/aws-cloud-deploy.sh` の全 `cdk deploy` 呼び出しが
`--toolkit-stack-name CDKToolkit-orcloud01` で揃っているか確認する。ずれていても
`cdk` は try/catch で握りつぶして動いてしまうことがあるため、エラーとして気づけない。

---

## 参照

- 設計: `docs/superpowers/specs/2026-08-12-claude-cloud-aws-dev-deploy-safety-design.md`
- ADR: `docs/adr/0009-claude-cloud-aws-dev-deploy-boundary.md`
- wrapper 本体: `scripts/aws-cloud-deploy.sh`
- 判定ロジック: `src/domain/governance/deploy-diff-gate.ts` /
  `src/domain/governance/deploy-preflight.ts` / `src/domain/governance/aws-policy-shape.ts` /
  `src/domain/governance/negative-test-outcome.ts`
- IAM ポリシー: `scripts/aws-policies/*.json`
