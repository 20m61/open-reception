# runbook: クラウドから AWS dev へのデプロイ

Claude Code on the cloud（クラウドセッション / cron routine）から、AWS の **dev 環境のみ**へ
`verify → preflight → diff → deploy → smoke` を無人実行できるようにするための、**人間が実行する**
手順。設計は `docs/superpowers/specs/2026-08-12-claude-cloud-aws-dev-deploy-safety-design.md`、
決定事項は `docs/adr/0009-claude-cloud-aws-dev-deploy-boundary.md` を参照する。

🔴 **本書を書いている時点で、この runbook のステップは 1 度も実行されていない。IAM は未適用、
dev への `cdk deploy` も未実施。** ステップ 1〜11 は人間が実際に手を動かして初めて検証される。

対象アカウント: `822063948773`（open-reception 以外に nodi / salon-loop / Kiaff が同居）。
リージョン: `ap-northeast-1`（主）+ `us-east-1`（`OpenReception-CfMon-dev` のみ）。
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
> 2026-08-15 時点で **5,978 文字（空白を除いた実サイズ。残り 166 文字）**。
> 変遷: carve-out で 5,148 → 5,682（+534）、`DenyBoundaryEscape` 分割で 5,876（+194）、
> `PutRolePermissionsBoundary` の Allow で 5,909（+33）、Secrets Manager の
> 読み取り許可で 6,240 相当まで膨らんだが、**Deny を削らずに詰めて** 6,037 まで戻した。
>
> 🔴 **詰め方の正解（2026-08-15）**: 「入らないから Deny を削る」ではなく
> **(a) 実効的に重複している列挙を外す**（`iam:UpdateAssumeRolePolicy` は
> `Resource:"*"` の無条件 Deny が別にあり、スコープ付き Deny への再掲は無意味だった）、
> **(b) 資源パターンを畳む**（`cdk-hnb659fds-*` / `cdk-staging-*` / `cdk-orcloud01-*` の
> role・policy 計 5 本を `role/cdk-*` + `policy/cdk-*` の 2 本へ。Deny なので
> **覆う範囲は増える**＝安全側）。どちらも `aws-policy-shape.test.ts` が被覆で固定している。
>
> 🔴 **`*` + `/cdk-*` のように資源パスの型を丸ごとワイルドカードにしてはいけない。**
> IAM が `MalformedPolicyDocument` で拒否する（`resource path must ... start with
> user/, role/, policy/, ...`）。**構造テストも被覆テストも通るのに AWS が受け取らない**
> ポリシーになるので、`aws-policy-shape.test.ts` の「IAM の許すパスで始まる」テストで
> 固定してある。2026-08-15 に実際にこれで `create-policy-version` が落ちた。
>
> **残りは 107 文字。**
> 次にステートメントを足す人は、まず余白を測ること:
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
> `claude-cfn-exec.json` は 5,141 / 6,144（残り 1,003）で余裕がある。
>
> 🔴 **層 2（cfn-exec）と層 4（boundary）は同じ規則の 2 つの写しである。** 実効権限は
> `identity ∩ boundary` なので、**片方だけ直しても効かない**。2026-08-15 にこれで 2 度落ちた
> （移行の窓を境界にだけ開けた / dev の secret 読み取りを境界にだけ足した）。
> dev が必要とする能力は `src/domain/governance/policy-parity.test.ts` に列挙してあり、
> `deploy` 区分のものは**両方のポリシーに要求される**。片側だけの修正はそこで落ちる。
>
> 🔴 **`DenyBoundaryEscape` を 1 文で書いていた頃の失敗を繰り返さないこと。**
> `iam:PutRolePermissionsBoundary` を条件なし・`Resource:"*"` で Deny すると、
> 「既存ロールに**我々の**境界を付ける」正当な操作まで死に、初回デプロイが
> `UPDATE_ROLLBACK_FAILED` に落ちる（2026-08-14 に実際に踏んだ。ステップ 9c 参照）。
> 禁じたいのは動詞ではなく**遷移の向き**（外す・弱いものへ差し替える）である。

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
`iam:CreateRole` を Deny し、`OpenReception-CfMon-dev` の CREATE がまさにそれを呼ぶ）。
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

🔴 **更新のときも 2 本とも必ず適用する。** 初期構築だけでなく、スタック名を変えた・
allowlist を足した等で `claude-deploy-role-restriction.json` を直したときも同じ。
2026-08-15 のスタック改名では ap-northeast-1 側にしか反映せず、us-east-1 側が旧名のままで
`DescribeStacks` が Deny され、`CfMon-dev` の change set 作成が失敗した。

反映されたことは**両方**で確かめる:

```bash
for r in ap-northeast-1 us-east-1; do
  printf "%s: " "$r"
  aws iam get-role-policy \
    --role-name "cdk-orcloud01-deploy-role-822063948773-$r" \
    --policy-name OpenReceptionClaudeDeployRestriction \
    --query PolicyDocument --output json | rg -c 'CfMon-dev'
done
```

> **同じ規則の写しが複数ある所は、必ず片方だけ直る。** 今日だけで 3 度起きた ――
> 層 2 と層 4（identity ∩ boundary）、移行用ポリシーの対、そしてこのリージョン別ロール。
> 「両方に同じ性質を要求する」テスト（`policy-parity.test.ts` /
> `boundary-migration.test.ts`）が効くのは repo 内の写しだけで、**実 IAM 側の写しは
> 人間の手順が守るしかない**。だからここに書いてある。

---

## ステップ 4: 🔴 初回デプロイ前の必須ステップ — IAM の実 API 検証

これまでのステップは JSON の**構造**しか検証していない（`src/domain/governance/aws-policy-shape.ts`
の `auditPolicyDocument` は unit テストで固定されているが、実際に AWS が評価した結果ではない）。
ここで初めて実 API（`iam:SimulatePrincipalPolicy`）を使い、机上の設計どおりに Allow/Deny が
効くかを確認する。**Admin 権限を持つ人間の環境から実行する**
（`OpenReceptionClaudeDeploy-dev` は `iam:SimulatePrincipalPolicy` を持たない前提のため）。

🔴 **2026-08-13 にこのステップ（4a）を実 IAM へ向けて初めて実行した結果、49/50 件が
期待どおりで、残り 1 件（`S16`、当時は changeSet ARN スコープ）は `implicitDeny` を
返し続けた。** 当初はこれを「AWS の IAM ポリシーシミュレータが CloudFormation の
`changeset` リソース種別を評価できない」という**道具側の限界**と解釈した。

🔴 **この解釈は誤りだった（同日、`cdk deploy --no-execute` の実 API 実測で訂正）。**
実際の `cloudformation:DescribeChangeSet` に対する `AccessDenied` は次を返した
（原文のまま記録する ―― これが唯一の証拠である）:

```
AccessDenied: User: arn:aws:sts::822063948773:assumed-role/OpenReceptionClaudeDeploy-dev/claude-cloud-20260814-0352
is not authorized to perform: cloudformation:DescribeChangeSet
on resource: arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/f9c7aab0-8f6f-11f1-be9b-0a2cf2440d9f
because no identity-based policy allows the cloudformation:DescribeChangeSet action
```

`resource` は **`stack/...` ARN であり、`changeSet/...` ARN ではない**。
`DescribeChangeSet` は changeSet ではなく **stack** リソースタイプに対して認可される。
`S16` の `implicitDeny`（changeSet ARN ＋ `Resource: "*"` の最小 Allow でも一致しない）は
シミュレータの限界の証拠ではなく、**「changeSet ARN スコープの Allow ではこのアクションは
本来一致し得ない」という正しい応答**だった。

> 🔴 **教訓（本設計が踏んだ失敗そのもの）**: An IAM action's authorisation resource type
> must be confirmed against a real API response, not inferred from documentation. A
> documentation reading redesigned the primary boundary around the wrong resource
> type; the simulator's inability to evaluate that type was evidence pointing at the
> error and was misread as a tooling limitation. 詳細は ADR 0009 決定 2。

**対処**: `claude-deploy-entry.json` の `DescribeChangeSet` を、changeSet ARN スコープの
別ステートメント（`ReadOwnChangeSetsForDiffGate`、一度も実効しなかった死んだ許可）から
`ReadOwnDevStacksForDiffGate`（`DescribeStacks` と同じ stack ARN の Allow）へ統合した。
`scripts/aws-negative-tests.ts` の `S16` も stack ARN へ向け直し、`S15` と同じ形で
通常どおりシミュレートできるようにした。**この訂正はまだ実 IAM に適用・再実行して
いない**（IAM の適用は人間が行う。次にステップ 4a を実行したとき、`S15`/`S16` とも
`✅ allowed` になることを確認すること ―― `ℹ️ シミュレーション不能` の probe 機構
自体は汎用のまま残っており、別のアクション／資源型の組み合わせで同じ形の
`implicitDeny` に出会えば引き続き働く）。

**`ExecuteChangeSet` / `DeleteChangeSet` はまだ未証明である。** これらは `deploy` 段の
実行でしか呼ばれず、今回の `--no-execute` diff では発火していない。stack ARN で認可
されるのか changeSet 名前スコープ（`claude-gate-*`）が必要なのかは実測していないため、
`claude-deploy-role-restriction.json` には両方の許可エントリを残してある（4b の該当箇所
参照）。**この 2 アクションの authorisation を実際に検証するのは、実際に `deploy` を
実行したとき**である。`diff`（本ステップ）は何も適用しないため安全側のまま、
すでに証明済みの `DescribeChangeSet`/`DescribeStacks`/`CreateChangeSet` の実質的な
確認地点になる。

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

🔴 **`S16` は 2026-08-13 の実測当時は `ℹ️ シミュレーション不能` として出ていた
（changeSet ARN スコープだったため）。ステップ 4 冒頭の訂正のとおり、`S16` は
stack ARN へ向け直したので、次回実行時からは `S15` と同じく通常どおり `✅`/`❌` として
出るはずである（この訂正後の再実行はまだ行っていない ―― IAM 側の適用後に確認する）。**
万一 probe（`ℹ️ シミュレーション不能`）が別の check で発火した場合は、`probe raw
EvalDecision=...` → `verdict=...` というログとその根拠が続く ―― この機構自体は
汎用のまま残っている（詳細は `negative-test-outcome.ts` のコメント）。
**全件が期待どおりであることが、初回デプロイへ進む前提条件**である。実行結果の最終行は
`passed=<N> failed=<N> notSimulatable=<N>` を分けて表示するため、`notSimulatable` が
0 でないことは見落とせない（`⚠️` 付きの行になり、無条件の `✅ PASS` としては出ない）。

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

> 🔴 **2・6 は訂正済み（2026-08-13 実測、#680 フォローアップ）。** `DescribeChangeSet` は
> changeSet ARN ではなく **stack ARN** に対して認可されると実 API で確認した（原文と
> 経緯はステップ 4 冒頭・ADR 0009 決定 2）。下記コマンドはすでに stack ARN を渡す形へ
> 訂正してあるので、そのまま実行して `allowed` を確認すればよい（changeSet ARN で
> 試す必要はない）。
>
> **7（`ExecuteChangeSet`）は引き続き未証明である。** `deploy` 段の実行でしか呼ばれず、
> stack ARN と changeSet 名前スコープ（`claude-gate-*`）のどちらで認可されるかを
> この手順は確定できない。`implicitDeny` が返っても「ポリシーが間違っている」のか
> 「そもそもこの資源型では一致し得ない」のか、生の `simulate-principal-policy` 呼び出し
> だけでは区別できない（4a のスクリプトが行う自動 probe はこの手動手順には無い）。
> **`ExecuteChangeSet`/`DeleteChangeSet` の authorisation を実際に確定させるのは
> 実際の `deploy` 実行である。** 7・9・11 の結果は参考情報として記録しつつ、
> **確定的な合否判定は実際に deploy を実行するまで持ち越すこと。**

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

# 2) entry role: DescribeChangeSet（自分の dev スタック。stack ARN で認可される。
#    2026-08-13 実測で訂正 ―― 以前は changeSet ARN で叩いていた） → allowed 期待
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev \
  --action-names cloudformation:DescribeChangeSet \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/dummy-id \
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

# 6) CDK deploy role: DescribeChangeSet（自分の dev スタック。stack ARN で認可される。
#    2026-08-13 実測で訂正） → allowed 期待
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
  --action-names cloudformation:DescribeChangeSet \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/dummy-id \
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

# 9) CDK deploy role: ExecuteChangeSet を claude-gate-* 以外の名前で試す → denied 期待
#    （NotResource allowlist が claude-gate-* にしか一致しないことの直接確認）
#    🔴 2026-08-13 実測での訂正: 元は DescribeChangeSet で書いていたが、そのアクションは
#    stack ARN で認可されると判明したため changeSet 名前スコープでは何も検証できない
#    （常に implicitDeny になり、claude-gate-* かどうかに関わらず情報が無い）。
#    changeSet **名前**スコープの Deny が実際に効いているかを問う意味があるのは、
#    まだ資源型が未証明の ExecuteChangeSet（7 の対）である。
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-deploy-role-822063948773-ap-northeast-1 \
  --action-names cloudformation:ExecuteChangeSet \
  --resource-arns arn:aws:cloudformation:ap-northeast-1:822063948773:changeSet/some-other-name/dummy-id \
  --query 'EvaluationResults[0].EvalDecision' --output text

# 10) 上記 1〜9 のうち us-east-1 が関係するもの（stack/changeSet の region 部分を
#     us-east-1、stack 名を OpenReception-CfMon-dev に置き換えて）も同様に確認する
#     （OpenReception-CfMon-dev は cross-region 参照のため us-east-1 固定）。

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
`OpenReception-WebMonitoring-dev` / `OpenReception-CfMon-dev`、最後のみ us-east-1）に
対して確認すること。とくに重要な確認対象:

- deploy role の `DescribeChangeSet`（6、**stack ARN で認可されると 2026-08-13 実測で
  証明済み**。ADR 0009 決定 2 参照）
- deploy role の `ExecuteChangeSet`（7、**未証明**。`changeSet/claude-gate-*/*` は
  次回 deploy を壊さないための予防的な安全網であり、実際にこの資源型で認可されるかは
  未確認）
- `claude-gate` 以外の名前が Deny されること（9）
- `DeleteChangeSet`（11、2 回目以降のデプロイで `cleanupOldChangeset` が必要とする。
  `ExecuteChangeSet` と同じく資源型は未証明）
- `DeleteStack`（12、`--no-execute` の no-op が残した `REVIEW_IN_PROGRESS` スタックの掃除用）

🔴 **6（`DescribeChangeSet`）はもう「机上でしか確認できていない部分」ではない。**
2026-08-13 の実 `cdk deploy --no-execute` が `resource: stack/OpenReception-Web-dev/<id>`
を名指しした `AccessDenied` を返し、`DescribeChangeSet` は stack ARN で認可されることが
実測で確定した（原文は ADR 0009 決定 2）。したがって 6 の `--resource-arns` は
（1 と同じ）stack ARN で叩けば足り、`allowed` を期待してよい。

**7・11（`ExecuteChangeSet`/`DeleteChangeSet`）は引き続き未証明である。** これらは
`deploy` 段の実行でしか呼ばれず、今回の `diff --no-execute` では発火していない。
stack ARN と changeSet 名前スコープのどちらで認可されるかを確定させるのはステップ 9
（実際には `deploy` の実行）であり、「本設計で唯一、机上でしか確認できていない部分」は
この 2 本と `DeleteStack`（12）である。

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

- carve-out の名前空間に入る `AWS::IAM::Role` は、既知の CDK provider role 4 本以外
  **停止**（`carveOutRoleNamespace`）。物理名は IAM が見るとおりに組む
  （生成名の切り詰め・明示 `RoleName`・`Path`）。4 本目は `s3deploy.BucketDeployment`
  （`web-stack.ts` の `AssetDeployment`）が使う `SingletonFunction` の ServiceRole
  （#680 続報。`.open-next/` を build 済みで実 `WebStack` を synth して実測した）
- その 4 本を**名乗った**だけのロールも、実体が CDK の生成する形と違えば**停止**
  （`carveOutRoleShape`）。固定しているのは
  **trust policy の Principal（`lambda.amazonaws.com` のみ）と Action
  （`sts:AssumeRole` のみ）／managed policy（基本実行ロールのみ）／
  action と Resource の許可リスト**の 4 点。
  action は **synth で実測した 16 個の許可リストだけを許す**（`ssm:` が 6 個 /
  `s3:` が 10 個。否認リストではない —— `iam:` のようなコロン込みの接頭辞で禁じても
  `iam*` `sts*` `*:*` `*:CreateRole` がすり抜けるので、2026-08-13 に許可リストへ
  反転した）。
  `Resource` は action ごとに閉じ込め先が違う: `ssm:` は**実測どおり
  `parameter/cdk/exports/` の下**（自アカウント固定、リージョンは具体値）、
  `s3:` は **CDK 資産ステージングバケット（`cdk-orcloud01-assets-*`。既定
  qualifier `hnb659fds` は含めない —— 層 3 の Deny と矛盾するため）と、
  `BucketDeployment` の宛先である自前 `AssetBucket`（論理 ID `AssetBucket1D025086`
  を `Fn::GetAtt` で照合し、`Type` が `AWS::S3::Bucket` であることまで確かめる。
  物理名は「ハイフン無しの別綴り」で prefix 照合が成立しないため、物理名では
  照合しない）**。`*` や `parameter/*` は停止——
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
- **既知の 4 本を名乗りつつ、許可リストの中で振る舞う**ことはできる。
  boundary の無いロールに `ssm:PutParameter` / `DeleteParameters` を
  **`parameter/cdk/exports/` の下**で持たせることは通る（provider が実際に
  そうするため）。到達範囲は**このアカウントの CDK cross-region export
  パラメータ**であり、他の CDK アプリのものを**上書き・削除**して
  そのスタックのデプロイを壊すことはできる。同様に、`BucketDeployment` の
  ServiceRole を名乗れば `s3:PutObject` / `DeleteObject*` などを**自前
  `AssetBucket` の中**（`OpenReception-Web-dev` 自身の静的アセット）で
  振る舞える —— 到達範囲はこのバケット 1 つに閉じる。`Resource` を `*` や
  `parameter/*` へ広げる経路、`dynamodb:` `logs:` `iam:` などの action、
  および許可リストに無い `s3:` action（`s3:DeleteBucket` 等）は
  2026-08-13 / #680 続報の許可リスト化で**通らなくなった**。**4 本のうち
  どれを名乗っても、他の 3 本の action/Resource へは広がらない** ——
  許可リストは 4 本の**和集合**なので、例えば `EXPORT_WRITER` を名乗った
  ロールが `s3:PutObject` を自前 `AssetBucket` へ持つことも許可リスト上は
  通る（action は共通の一枚岩）。狭めているのは「未知の action / Resource
  を通さない」ことであって「どの 4 本を名乗ったかで許可を分ける」ことでは
  ない。実害は 4 本それぞれの実測範囲を超えない
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

`npm run build:open-next` → `./scripts/quality-gate.sh --pr` の順で実行する。

🔴 **この順序を逆にしない（#680）。** フレッシュな clone には `.open-next/` が無い。
逆順（gate → build）だと、`quality-gate.sh --pr` が「infra WebStack synth」等を検査
できず green スタンプを書かずに非ゼロで終わり（#640。検査できなかったステップを green
として記録しない設計そのもの）、`set -e` によって `verify` がそこで打ち切られる。
`.open-next/` を作る唯一の手段である `npm run build:open-next` が一度も実行されず、
**何回 `verify` を再実行しても green スタンプが書けないデッドロック**になる（クラウドの
実セッションで踏んだ）。ゲートへの入力を作るステップは、ゲートより前に置く。

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

🔴 **前提: `aws` CLI が cloud sandbox に入っていること。** `scripts/cloud-setup.sh`
（環境ダイアログの Setup script）が入れる。入っていないと、直後の
`aws sts get-caller-identity` が失敗する。ここは `command -v aws` による確認
（`src/domain/governance/command-preflight.ts`）を `collect_observation` の先頭に
入れてあるので、資格情報を誤って疑わせない具体的なメッセージ（`aws` が無いこと・
`scripts/cloud-setup.sh` を確認すること）が出る（#680。詳細はトラブルシュート参照）。

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
`OpenReception-CfMon-dev`）それぞれについて `cdk deploy --no-execute --change-set-name
claude-gate-<short-sha>` で change set を作り、`describe-change-set` の JSON を
`src/domain/governance/deploy-diff-gate.ts` の危険判定に掛ける。危険な変更（`Remove` /
`Import` / `Dynamic` などの未知の action / replacement / KMS・Secrets・Route53・
SecurityGroup・IAM プリンシパルの変更 等）を検出したら非ゼロで終了し、`deploy` へ進まない。

🔴 **ここが認可の資源型を実際に確認する地点である ―― そして 2026-08-13 に実際に
それが起きた。** `--no-execute` の change set 作成は**何も適用しない**ので安全側の
まま、`entry` role → `deploy` role の `CreateChangeSet`/`DescribeChangeSet` 呼び出しを
実際に発生させる。この実行で `cloudformation:DescribeChangeSet` が `AccessDenied` を
返し、その `resource` は次のとおり **stack ARN** を名指しした（原文のまま記録する）:

```
AccessDenied: User: arn:aws:sts::822063948773:assumed-role/OpenReceptionClaudeDeploy-dev/claude-cloud-20260814-0352
is not authorized to perform: cloudformation:DescribeChangeSet
on resource: arn:aws:cloudformation:ap-northeast-1:822063948773:stack/OpenReception-Web-dev/f9c7aab0-8f6f-11f1-be9b-0a2cf2440d9f
because no identity-based policy allows the cloudformation:DescribeChangeSet action
```

**この denial message そのものが証拠である。** `DescribeChangeSet` は changeSet では
なく stack リソースタイプに対して認可される ―― ステップ 4 冒頭で書いた「S16 は
シミュレータの限界」という当時の解釈は誤りで、`claude-deploy-entry.json` の
`ReadOwnChangeSetsForDiffGate`（changeSet ARN スコープ）が実際に stack ARN しか
評価しないこのアクションを一度も認可できていなかったことが原因だった（詳細は
ADR 0009 決定 2）。`claude-deploy-entry.json` は `DescribeChangeSet` を
`ReadOwnDevStacksForDiffGate`（stack ARN の Allow）へ統合する形で訂正済みだが、
**この訂正はまだ実 IAM に適用していない**（ステップ 1 のインラインポリシー再適用が
必要。適用後にステップ 4a と本ステップを再実行し、`DescribeChangeSet` が
`AccessDenied` にならないことを確認すること）。

`ExecuteChangeSet` / `DeleteChangeSet` はこの実行（`--no-execute`）では発火しない
（`deploy` 段の実行でしか呼ばれない）。この 2 アクションの資源型は引き続き未証明
であり、実際に `deploy` を実行して初めて確定する。

**`OpenReception-CfMon-dev` は現時点でアカウントに存在しない**（`Web-dev` と
`WebMonitoring-dev` のみ）。初回はここが CREATE 型の change set になり、全リソースが
`Add` として現れる。

---

## ステップ 9b: 🔴 ゲートがブロックしたときの承認手順（#680）

diff gate は `resourceReplacement` / `resourceRemoval` などを見つけると**必ず止まる**。
これは設計どおりの停止境界であって、不具合ではない。

**ここで `scripts/aws-cloud-deploy.sh` を迂回して素の `cdk deploy` を打ってはいけない。**
迂回すると preflight（資格情報の残時間・品質ゲート記録・ツリーの清潔さ・HEAD が push
済みか）と negative security test 8 本が**まるごと省略される**。要件は
「gate を skip して deploy を成功させることは禁止」である。

代わりに**承認トークン**を使う。`diff` はブロック時に必ず次を印字する:

```
  ⛔ 危険な変更を検出したため自動デプロイを停止します:
    - [resourceReplacement] ServerFnFunctionUrlFFF9E3E1 (AWS::Lambda::Url) action=Modify ...
    - [resourceRemoval] ServerFninvokefunctionA3A7399A (AWS::Lambda::Permission) action=Remove
  承認トークン: OpenReception-Web-dev:1a2b3c4d5e6f7890
```

1. **人間が findings を読む。** 何が置換・削除されるのか、可用性・認可にどう影響するのかを
   実際に確かめる（`aws cloudformation get-template` で現行と synth を突き合わせる等）
2. 承認するなら、そのトークンを `OR_APPROVED_DIFF` に渡して deploy する。
   複数スタックぶんはカンマ区切り

```bash
OR_APPROVED_DIFF="OpenReception-Web-dev:1a2b3c4d5e6f7890" \
  bash scripts/aws-cloud-deploy.sh deploy
```

**トークンはその findings 集合に固定される**（`src/domain/governance/deploy-approval-token.ts`）。
findings が 1 件でも増減・変化すれば値が変わり、**古い承認は自動的に無効になる**。
つまり「前回承認したから」で別の差分を流すことはできない。

- 承認が効くのは **`deploy` のときだけ**。`diff` は素の判定を見せる場所なので
  `OR_APPROVED_DIFF` を無視する
- ワイルドカード（`*` など）は効かない。完全一致のみ
- 承認が効いたときは、何を承認したのかが **findings ごとログに残る**
- トークンは秘密ではない（誰でも計算できる）。これは*認証*ではなく**取り違え防止**であり、
  実行を止める力は IAM 境界（boundary / restriction ポリシー）が持っている

---

## ステップ 8b: 🔴 デプロイに必須の context（未設定だと `diff` / `deploy` が止まる）

`infra/bin/open-reception.ts` の次の 3 つは **未指定でも synth が通る**。通るが、出来上がるのは
**別構成のスタック**で、Secrets Manager 連携も QR の基底オリジンも落ちる。
2026-08-15 に wrapper がこれらを渡しておらず、dev の ServerFn から
`secretsmanager:GetSecretValue` の付与が消えて **dev が 500** になった（ステップ 9c）。

**diff gate では止められない。** `describe-change-set` は「どの property が変わったか」の名前しか
返さず、消えた IAM 文や環境変数を**値として見せない**ので、差分は「26 件の変更」にしか見えない。
したがって防波堤は wrapper に置いてある ―― **未指定なら始めない**。

| 環境変数 | 渡る context | 省くとどうなるか |
| --- | --- | --- |
| `OR_APP_SECRETS_NAME` | `appSecretsName` | Secrets Manager 連携が落ち、**起動が 500** |
| `OR_ORIGIN_VERIFY_SECRET` | `originVerifySecret` | CloudFront 経由の **POST が全滅**（403） |
| `OR_PUBLIC_ORIGIN_OVERRIDE` | `publicOriginOverride` | 発行される **QR が誰にも使えない** |

dev の値は `docs/deploy-aws.md`「dev をゼロから立ち上げる手順」を参照
（**リポジトリには置かない**。`originVerifySecret` は秘密の値そのもの）。

```bash
export OR_APP_SECRETS_NAME=open-reception/dev/app-v2
export OR_ORIGIN_VERIFY_SECRET=...        # 高エントロピー値。履歴・ログに残さない
export OR_PUBLIC_ORIGIN_OVERRIDE=https://dvxkh8nfwl334.cloudfront.net
```

⚠️ `originVerifySecret` は `cdk` の argv に載る＝プロセステーブルから見える。CDK context の
仕組み上避けられないので、**本筋は `originVerifySecretName`（Secrets Manager 名）への移行**（#612）。

---

## ステップ 9e: 🔴 新規の消費側スタックは生産側を先にデプロイする

cross-region 参照は「生産側（`Web-dev` / ap-northeast-1）が us-east-1 の SSM へ
`/cdk/exports/<消費側スタック名>/...` を書き、消費側（`CfMon-dev`）が読む」形で実現されている。

したがって**新規の消費側スタックは、生産側がデプロイされるまで change set を作れない**:

```
Parameters: [ssm:/cdk/exports/OpenReception-CfMon-dev/OpenReceptionWebdev...] cannot be found.
```

wrapper は 3 スタックすべてを gate してからまとめてデプロイするので、消費側の gate が
失敗すると**生産側のデプロイにも到達しない**。2026-08-15 の改名後にこれを踏んだ
（消費側スタック名が変わると SSM のパスも変わるため、旧パスしか書かれていなかった）。

🔴 **「gate できないものを黙って通す」で解決しない。** gate の意味が消える。
代わりに `--only` で**順序を運用者が決める**:

```bash
# 1) 生産側だけ先にデプロイ（新しい SSM export が書かれる）
bash scripts/aws-cloud-deploy.sh diff --only OpenReception-Web-dev
OR_APPROVED_DIFF="..." bash scripts/aws-cloud-deploy.sh deploy --only OpenReception-Web-dev

# 2) そのあと全体（消費側の change set が作れるようになっている）
bash scripts/aws-cloud-deploy.sh diff
OR_APPROVED_DIFF="..." bash scripts/aws-cloud-deploy.sh deploy
```

`--only` は**許可リストの部分集合に限る**（`src/domain/governance/deploy-stack-selection.ts`）。
任意の名前を渡せると層 1（スタック ARN allowlist）を引数で迂回できるため、
許可リスト外は拒否し、解決結果が空でも止める。

---

## ステップ 9d: 🔴 共有 bootstrap で作られた既存スタックの移行（一度きり）

**`OpenReception-Web-dev` は共有 bootstrap（`hnb659fds`）でデプロイされたスタック。**
`orcloud01` の制限ロールで更新すると、失敗時のロールバックが**旧アセットを
`cdk-hnb659fds-assets-*` から取り直そうとし**、層 3（他プロジェクト遮断）がそれを Deny する。

```
Your access has been denied by S3 ... permission to GetObject for cdk-hnb659fds-...
```

つまり**ロールバックが原理的に完了できない**。#680 の設計は「orcloud01 で新規に作る
スタック」前提だった。2026-08-15 にこれを踏み、`UPDATE_ROLLBACK_FAILED` から
抜けられなくなった。

### 手順（移行の間だけ穴を開け、成功したら閉じる）

`scripts/aws-policies/claude-boundary-migration.json` は**通常の境界と 1 箇所だけ違う**
一時ポリシー。共有 assets の**オブジェクト読み取りだけ**を通し、書き込み・削除・
他プロジェクトのデータは通常どおり Deny する（`NotAction: s3:GetObject` の Deny で塞ぐ）。
差分が 1 箇所であることは `src/domain/governance/boundary-migration.test.ts` が固定している。

🔴 **境界と cfn-exec の両方を差し替える。** 同じ Deny が両方にあり、**片方だけ開けても
`explicitDeny` のまま**通らない（2026-08-15 に境界だけ開けて実際に踏んだ）。

```bash
# 1) 一時ポリシーを適用（ここから窓が開く）。**2 本とも**必要。
aws iam create-policy-version \
  --policy-arn arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary \
  --policy-document file://scripts/aws-policies/claude-boundary-migration.json \
  --set-as-default
aws iam create-policy-version \
  --policy-arn arn:aws:iam::822063948773:policy/OpenReceptionClaudeCfnExec-dev \
  --policy-document file://scripts/aws-policies/claude-cfn-exec-migration.json \
  --set-as-default

# 窓が開いたことを必ず確認する（開いていないまま deploy して二度手間になる）
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1 \
  --action-names s3:GetObject \
  --resource-arns "arn:aws:s3:::cdk-hnb659fds-assets-822063948773-ap-northeast-1/x.zip" \
  --query 'EvaluationResults[0].EvalDecision' --output text   # → allowed

# 2) 移行デプロイ（必須 context はステップ 8b）
bash scripts/aws-cloud-deploy.sh diff
OR_APPROVED_DIFF="..." bash scripts/aws-cloud-deploy.sh deploy

# 3) 🔴 成功したら必ず通常へ戻す（窓を閉じる）。**2 本とも**戻す。
aws iam create-policy-version \
  --policy-arn arn:aws:iam::822063948773:policy/OpenReceptionClaudeBoundary \
  --policy-document file://scripts/aws-policies/claude-boundary.json \
  --set-as-default
aws iam create-policy-version \
  --policy-arn arn:aws:iam::822063948773:policy/OpenReceptionClaudeCfnExec-dev \
  --policy-document file://scripts/aws-policies/claude-cfn-exec.json \
  --set-as-default

# 閉じたことを確認する（上と同じ simulate が explicitDeny に戻る）
```

⚠️ managed policy は**バージョンを 5 個までしか保持できない**。窓の開閉を繰り返すと
`LimitExceeded` になるので、古いバージョンは `aws iam delete-policy-version` で掃除する。

**窓の間に何が起きうるか**: サンドボックスが侵害されていた場合、他プロジェクト
（nodi / salon-loop）の Lambda バンドルや CFN テンプレートを**読める**。書き込みはできない。
だから**移行が終わったら即座に閉じる**。閉じたことは `simulate-principal-policy` で
`s3:GetObject` on `cdk-hnb659fds-assets-*/*` が `explicitDeny` に戻ることで確かめる。

**なぜ一度きりで済むか**: 成功したデプロイ以降、スタックは `orcloud01` の assets を参照する
ので、次からのロールバックは共有バケットを見ない。

---

## ステップ 9c: 🔴 `UPDATE_ROLLBACK_FAILED` からの復旧（2026-08-14 に実際に起きた）

初回デプロイは **permissions boundary の自縄自縛**で失敗した。記録として残す。

**何が起きたか**: `claude-boundary.json` の `DenyBoundaryEscape` が
`iam:PutRolePermissionsBoundary` を**条件なし・`Resource:"*"`** で Deny していた。
dev の Lambda 実行ロールは境界の仕組みが入る前（2026-08-06）に**境界なしで**作られており、
初回デプロイは「既存ロールに境界を**付ける**」＝ `PutRolePermissionsBoundary` を必要とする。
自分の境界に自分で止められ、続く rollback も `DeleteRolePermissionsBoundary` が Deny されて
失敗し、`OpenReception-Web-dev` が `UPDATE_ROLLBACK_FAILED` に落ちた。

**`CreateRole` は通る**（境界は CreateRole のパラメータとして渡る）。つまり
「新規ロールなら通るが、既存ロールへの後付けだけ通らない」という穴だった。

**復旧**: Put も Delete も拒否されたロールは**一度も変更されていない**ので、実体は更新前の
ままである。rollback から除外するのが事実に合致する。**admin（`user/CDK`）で実行する**
（deploy role に `ContinueUpdateRollback` は無い）:

```bash
aws cloudformation continue-update-rollback \
  --stack-name OpenReception-Web-dev --region ap-northeast-1 \
  --resources-to-skip <失敗した論理 ID を列挙>
```

失敗した論理 ID は次で拾える:

```bash
aws cloudformation describe-stack-events --stack-name OpenReception-Web-dev \
  --region ap-northeast-1 --output json \
  | jq -r '.StackEvents[] | select(.ResourceStatus=="UPDATE_FAILED") | .LogicalResourceId' | sort -u
```

**恒久対策**（適用済み）: `DenyBoundaryEscape` を 2 文へ割った。
`iam:DeleteRolePermissionsBoundary` は無条件 Deny のまま（外させない）、
`iam:PutRolePermissionsBoundary` は `StringNotEquals iam:PermissionsBoundary = 我々の境界`
のときだけ Deny（＝我々の境界だけは付けられる）。`claude-cfn-exec.json` の
`AllowRoleMutationOnlyWithBoundary` にも `iam:PutRolePermissionsBoundary` を足した。
`src/domain/governance/aws-policy-shape.test.ts` の
「permissions boundary の付け外し」describe がこの性質を固定している。

**残るリスク**: 一度 boundary を付けたあとの更新が失敗すると、rollback が
「boundary を外す」を試みて再び `DeleteRolePermissionsBoundary` で失敗しうる。
これは意図的な受容（外せることの方が危険）で、対処は上記の `--resources-to-skip`。

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
- **`OpenReception-CfMon-dev` は現時点でアカウントに存在しない**（`Web-dev` と
  `WebMonitoring-dev` のみ）。初回デプロイはこのスタックが CREATE 型の change set になる。

---

## トラブルシュート

### 🔴 実際に踏んだ: `aws` CLI がクラウドサンドボックスに無かった（#680）

verify → preflight → diff を初めて通しで実行した試行が 61 秒で死んだ。
`collect_observation` の `aws sts get-caller-identity` が
`/bin/bash: line 1: aws: command not found` で失敗し、その時点の実装はこれを
そのまま「AWS 認証情報を解決できません」と報告していた。`AWS_CREDENTIAL_EXPIRATION` は
未設定、`~/.aws/config` には `[default]` に `s3.payload_signing_enabled` しか無い ――
資格情報側を疑わせる材料が並ぶが、**実際の原因は `aws` バイナリそのものが
入っていなかったこと**だった。`scripts/cloud-setup.sh`（環境ダイアログへ貼る Setup
script）は当時 `gh` / `gitleaks` / `semgrep` / Playwright しか入れておらず、
`grep aws scripts/cloud-setup.sh` は何も返さなかった。

対処（反映済み）:

- `scripts/cloud-setup.sh` に AWS CLI v2 のインストールを追加（`command -v aws` で
  ガード、`|| true` で非必須化）。**環境ダイアログ側の Setup script 欄も貼り替えること**
  ―― このファイルは実行されない、貼る内容の正本でしかない（ファイル冒頭の注記）。
- `scripts/aws-cloud-deploy.sh` の `collect_observation` に、`aws` の有無を
  `aws sts get-caller-identity` より**前**に確認する preflight を追加
  （`src/domain/governance/command-preflight.ts`）。誤って資格情報を疑わせるメッセージを
  出さず、「`aws` が見つからない・`scripts/cloud-setup.sh` を確認せよ」と名指しする。
- Network access の許可ドメインに `awscli.amazonaws.com` の追加が必要
  （`docs/cloud-dev-environment.md` §1。Trusted の既定リストに入っていない可能性が高い、
  Playwright の `cdn.playwright.dev` と同型）。

### 🔴 実際に踏んだ: `verify` がフレッシュな clone でデッドロックしていた（#680）

上の対処後、実際にクラウドセッションで `verify` を単発実行したところ、`npm ci` までは
通ったのに `verify` が exit 1 で終わり、`preflight`/`diff` に一度も到達しなかった。
旧実装は `quality-gate.sh --pr` を先に呼び、`npm run build:open-next` を後に呼んでいた:

```bash
  verify)
    "${ROOT}/scripts/quality-gate.sh" --pr        # ← 先に走る
    ( cd "${ROOT}" && npm run build:open-next )   # ← 到達しない
    ;;
```

フレッシュな clone には `.open-next/` が無い。`set -euo pipefail` の下では:

1. `quality-gate.sh --pr` が「infra WebStack synth」等を検査できず SKIP を報告し、
   green スタンプを書かずに非ゼロで終わる（#640。検査できなかったステップを green として
   記録しない設計そのもの）。
2. `set -e` がここで `verify` を打ち切る。
3. `.open-next/` を作る唯一の手段である `npm run build:open-next` が**一度も実行されない**。
4. 次に `verify` を再実行しても `.open-next/` は相変わらず無いので 1) から繰り返す ――
   **何回リトライしても green スタンプが書けない。**

クラウドエージェント自身の言葉: 「フレッシュな clone で `verify` を単発実行すると、
①が必ず先に失敗し②に到達しないため、この手順の記載通りでは絶対に green スタンプが
書けません」。エージェントはこれを正しく検知し、回避策で誤魔化さずに報告した。

対処（反映済み）: `scripts/aws-cloud-deploy.sh` の `verify)` ケースの順序を
`build:open-next` → `quality-gate.sh --pr` へ反転（ステップ 7 冒頭の記載も合わせて
訂正済み）。ゲートへの入力を**作る**ステップは、ゲートより前に置く。加えて、この
リポジトリがクラウドセッションへ送る委譲プロンプトは元々この順（build → gate）で
書いてきており、wrapper だけが逆順だった ―― フレッシュな container で初めて実行される
まで気づかれなかった。

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
