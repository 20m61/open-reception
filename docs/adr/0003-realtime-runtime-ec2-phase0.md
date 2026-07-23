# ADR 0003: リアルタイム会話 EC2 基盤 Phase 0（EC2 lifecycle・artifact 配布・endpoint・fallback・instance type）

- ステータス: 承認（設計 + インフラ skeleton コードのみ。**deploy は本 increment のスコープ外**）。
- 関連: issue #366（本 ADR の対象）、#360（親）、#364（Voice Epic）、#367（運用コントロールパネル・
  営業時間ポリシーの統合待ち）、#369（Voice Transport）、#34（CDK 詳細設計）、#300（コスト最適化）、
  #315（DR/復旧）
- 関連ドキュメント: `docs/adr/0001-voice-transport.md`（ADR-001, Transport は既決）、
  `docs/cost-management-tags.md`、`docs/infrastructure-design.md`
- 実装: `infra/lib/stacks/realtime-runtime-stack.ts`、`infra/lib/config/environments.ts`
  （`RealtimeRuntimeConfig`）、`infra/lib/config/realtime-schedule.ts`、
  `infra/lambda/realtime-reconciler/handler.ts`

## 背景

現行 AWS 実装は OpenNext の CloudFront + Lambda + S3 + DynamoDB を中心とした完全サーバーレス構成
（`WebStack`）で、待機画面・管理画面・QR・設定 API には適している。一方、長時間の双方向音声ストリーム・
低遅延 WSS・割り込み制御を要するリアルタイム会話処理には向かない（Lambda のコネクション時間制約・
コールドスタート・WebSocket 常時接続の相性の悪さ）。

1 日 10〜50 件の受付を前提に、常時 GPU・EKS・NAT Gateway・常時 Fargate・RDS を避けつつ、EC2 を
**営業時間のみ稼働**させる構成を追加する。issue #366 は次の 6 点（issue 本文の ADR-001〜006 相当）の
決定を Phase 0 として要求している。ADR-001（Transport）は `docs/adr/0001-voice-transport.md` で
既に決定済みのため、本 ADR は ADR-002〜006 を決定し、**月額 Budget 見積**を確定する。

**この決定が重大変更に該当する理由**: 現行 open-reception の AWS 実績コストは **月 $0.0005**
（2026-07 実測、dev のみ・ほぼ無料枠内）。本構成は EC2 を 8:00–23:00 常時稼働させるため、
月額 **十数〜二十数ドル規模の実質的固定費**が初めて発生する。CLAUDE.md の重大変更条件
（コスト増を伴う判断）に該当するため、**実 deploy は本 ADR とは別に、下記見積を添えてユーザーの
最終承認を得てから行う**。本 increment は ADR 確定と `cdk synth` 可能な CDK コードの追加までに
留め、`bin/open-reception.ts` は `config.realtime.enabled`（全環境既定 `false`）が `true` の
場合のみ本 Stack を app に追加するようガードしている。

## 決定

### ADR-002: EC2 lifecycle — ASG `min=0 / max=1`（固定 Instance の start/stop ではない）

**決定**: Auto Scaling Group（`minCapacity=0, maxCapacity=1`）+ Launch Template を採用する。
1 分毎に起動する Reconciler Lambda（EventBridge Rule `rate(1 minute)`）が営業時間ポリシーから
目標 DesiredCapacity(0|1) を計算し、`SetDesiredCapacity` で追従させる（`infra/lambda/
realtime-reconciler/handler.ts`）。

比較した代替案:

| 案 | Pros | Cons | 採否 |
| --- | --- | --- | --- |
| **ASG min=0/max=1**（採用） | EC2 が存在しない間は EC2 課金ゼロ、EBS も terminate と同時に破棄されるため storage 課金も稼働時間分のみ、ASG の自己修復（instance crash 時の自動再作成）をそのまま使える | 起動の都度 AMI ブートから（コールドスタート）、Warm standby ではない | ○ |
| 固定 Instance + start/stop（instance stop/start API） | 停止中も同一 instance が保持されるため再起動が速い（ブート時間のみ、AMI からの再構築不要） | 停止中も EBS storage 課金が 24/7 発生（本見積では約 $0.74/月の差、小さいが構成の単純さは失われる）、ASG の自己修復が使えず単一障害点からの自動復旧に自前のヘルスチェック/再起動処理が要る | ✗（MVP では自己修復を優先） |
| 常時稼働（スケジュールなし） | 実装が最も単純、コールドスタートなし | 固定費が 730h/月 課金（後述の Budget 比較で約 37% 高い）。コスト方針（issue #366）に反する | ✗ |

**理由**: issue #366 の MVP 前提「単一 EC2/ASG max=1 による単一障害点を許容する」「障害時は
音声受付を停止しサイネージ・タッチ・QR確認を継続する」と整合させるには、ASG の自動復旧
（instance crash → 自動的に新 instance を起動）を使える min=0/max=1 が望ましい。起動の都度
コールドスタートになる点は ADR-005（RTO）で扱う。

**CloudFormation 更新との両立**: ASG の DesiredCapacity は CloudFormation 側と Reconciler の
両方から変更されうる。既定では `cdk deploy` の度に CloudFormation が DesiredCapacity をテンプレート
値（0）へ巻き戻すため、`UpdatePolicy.AutoScalingScheduledAction.IgnoreUnmodifiedGroupSizeProperties`
を `true` に設定し（`realtime-runtime-stack.ts` の L1 エスケープハッチ）、Reconciler による
実行時変更を deploy 側が上書きしないようにした。

### ADR-003: artifact 配布 — S3（DockerImageAsset/ECR は後続 increment）

**決定**: Phase 0 では **S3 バケット**（`RealtimeRuntimeStack.artifactBucket`）へ realtime gateway
アプリのビルド成果物を配布する方式を暫定採用する。EC2 instance role に `s3:GetObject` を付与済み。
DockerImageAsset/ECR への移行は、realtime gateway アプリ本体がコンテナ化された後続 increment で
判断する。

比較した代替案:

| 案 | Pros | Cons | 採否 |
| --- | --- | --- | --- |
| **S3 artifact**（採用） | `cdk synth`/テストに Docker daemon が不要（本トラックのようにローカル検証のみの環境でも動く）、実装が単純（zip/tar + systemd） | コンテナの環境一貫性・イメージスキャンの恩恵がない | ○（Phase 0） |
| CDK DockerImageAsset → ECR | ビルド環境の再現性が高い、ECR のイメージスキャンが使える | `cdk synth`/`deploy` に Docker daemon が必要（本 increment のような Docker 無しの検証環境で `cdk synth` が失敗しうる）、realtime gateway アプリ本体がまだ存在せず Dockerfile 自体が未確定 | ✗（Phase 0 は見送り、アプリ確定後に再検討） |

**理由**: 本 increment はアプリ本体（realtime gateway/conversation worker）が未実装のため、
コンテナ化の判断自体が時期尚早。S3 配布は最小の実装コストで CDK skeleton を synth 可能にし、
後続でコンテナ化する際も IAM/Launch Template の変更のみで移行できる（S3 権限を ECR pull 権限に
差し替えるだけ）。

### ADR-004: endpoint — 動的 Public IPv4 + Route 53（EIP は使わない）

**決定**: Launch Template で `associatePublicIpAddress: true` とし、Elastic IP は保持しない。
Reconciler Lambda がスケールアウト完了を検知した際に、起動した instance の Public IPv4 を
Route 53 の A レコードへ `UPSERT`（TTL 60 秒）する。CDK 側では既存 hosted zone（新規ゾーンは
作らない）を `-c realtimeHostedZoneId=... -c realtimeZoneName=... -c realtimeRecordName=...`
で任意指定でき、未指定時は Route 53 リソース自体を作らない（`cdk synth` に実ゾーンが不要）。

比較した代替案:

| 案 | Pros | Cons | 採否 |
| --- | --- | --- | --- |
| **動的 Public IPv4 + Route 53**（採用） | EIP 保有コストがゼロ（未使用 EIP は課金対象、稼働中の動的 Public IPv4 も課金対象自体は同額 $0.005/hr のため差はないが、EIP は「確保しているだけで未アタッチ」の期間に別途課金が発生しうる運用リスクを避けられる）、DNS 名で iPad Kiosk/WebStack からアクセスでき IP 変更を隠蔽できる | DNS 反映まで最大 TTL（60秒）+ Route 53 変更伝播の遅延があるため起動直後は数十秒 ready 判定を待つ必要がある（ADR-005 の RTO に含める） | ○ |
| Elastic IP 固定 | IP が不変、DNS 更新が不要 | ASG がインスタンスを再作成する設計（ADR-002）と相性が悪い（EIP の再アタッチ処理が別途必要になり Reconciler の実装が複雑化する）。EIP 自体の時間課金は動的 Public IPv4 と同額（2024年2月以降）のためコスト上のメリットがない | ✗ |

**理由**: 2024年2月の AWS 料金改定以降、Public IPv4 は EIP か動的かを問わず同一の時間課金
（$0.005/hr）になったため、EIP 固定のコスト優位性は消滅した。ASG の instance 入れ替えと
組み合わせる場合、動的 IP + DNS 更新の方が実装がシンプル（EIP 再アタッチのレース処理が不要）。

### ADR-005: 単一ノード障害時 fallback・RTO

**決定**:

- **fallback**: EC2/ASG の異常（instance crash・health check failure）検知時、音声受付機能を
  `degraded` として扱い、iPad Kiosk はタッチ・QR 確認へフォールバックする（サイネージ・管理・
  QR は WebStack 側で完全に独立して動作し続けるため無停止）。ready 判定（`/health/ready`
  相当、アプリ本体側で実装、本 increment はインフラ skeleton のみで未実装）が通るまでは
  音声受付を利用可能と表示しない。
- **RTO の許容値（MVP）**: 通常の営業開始（8:00 JST）は Reconciler が起動前から待機し、AMI
  ブート＋アプリ起動で **数分〜10 分程度**を許容する（issue #366 の `drainBeforeMinutes: 10` /
  `maxExtensionMinutes: 10` と同オーダー）。営業時間中の instance crash からの自動復旧は、
  ASG の自己修復（min=0/max=1 でも crash した instance は Unhealthy 判定後に新規起動される）
  + 次回 Reconciler 実行（最大 1 分後）でカバーする。**Multi-AZ 冗長化は非スコープ**（issue
  #366 非スコープ節）のため、単一 AZ 障害時は RTO を満たせない（許容する、issue #366 MVP 前提）。
- **緊急停止手段**: `cdk deploy` を経ずに即座に停止できる kill-switch として SSM Parameter
  `/{prefix}/realtime/force-stop` を用意した（`RealtimeRuntimeStack.forceStopParam`）。値を
  `"true"` にすると次回 Reconciler 実行（最大 1 分後）で DesiredCapacity=0 になる。

**この increment のスコープ外（follow-up）**:
- drain（進行中セッションを待ってから安全停止）は `/drain` API がアプリ本体に必要で、本
  increment では実装しない（即時 SetDesiredCapacity(0) のみ）。
- `/health/live` `/health/ready` はアプリ本体側の実装。
- CPU/memory/disk/process/session 数の詳細監視（CloudWatch Agent）は実 AMI 上での実機検証
  （#65）が要るため後続。現状は Reconciler Lambda 自体のエラー率アラームのみ（
  `RealtimeRuntimeStack` の `ReconcilerErrors` Alarm）。

### ADR-006: instance type — `t4g.small` を初期値、負荷試験後に確定

**決定**: `EnvConfig.realtime.instanceType` の初期値は全環境 `t4g.small`（2 vCPU / 2 GiB）。
`t4g.medium`（2 vCPU / 4 GiB）は prod で負荷試験の結果次第の切替候補として Budget のみ
先に確保している。`t4g.nano`（2 vCPU / 0.5 GiB）は Node.js gateway + Transcribe streaming
+ Polly + Caddy の同時実行にメモリ不足の懸念が高く候補から除外した。

負荷試験（実 AWS 環境・実音声ストリームが要るため #65 スタック）が完了するまでは `t4g.small`
を暫定値とし、config 変更のみで `t4g.medium` へ切り替えられるようにしてある（CDK コード変更
不要）。

## 月額 Budget 見積

### 前提

- 稼働時間: 8:00–23:00 JST = **15h/日 × 30日 = 450 instance-hours/月**（issue #366 初期ポリシー）。
- リージョン: ap-northeast-1（東京）。単価は AWS Price List API（`https://pricing.us-east-1.
  amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-northeast-1/index.json`, 2026-07-23 取得）
  の実データ。Route 53 は AWS 公表価格（https://aws.amazon.com/route53/pricing/）、Public IPv4
  は 2024-02 料金改定の公表値（https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/）。
- EBS gp3 20 GiB。ASG が min=0 で instance を terminate する設計のため、volume は稼働時間
  （450h/月）分のみ課金される想定（`deleteOnTermination: true`）。
- Route 53 hosted zone は保守的に「新規作成」を仮定（既存ゾーンを再利用できれば $0.50/月 減る）。

### 内訳（instanceType 別）

| 費目 | 単価 (ap-northeast-1) | t4g.small (450h/月) | t4g.medium (450h/月) |
| --- | --- | --- | --- |
| EC2 compute | small $0.0216/h・medium $0.0432/h | $9.72 | $19.44 |
| EBS gp3 (20GiB, 稼働時間分) | $0.096/GB-月 | $1.18 | $1.18 |
| Public IPv4 (動的, ADR-004) | $0.005/h | $2.25 | $2.25 |
| Route 53 hosted zone（新規想定） | $0.50/月 | $0.50 | $0.50 |
| Route 53 標準クエリ | $0.40/百万クエリ | ~$0.05 | ~$0.05 |
| CloudWatch Alarms（Reconciler 用 3個想定） | $0.10/alarm/月 | $0.30 | $0.30 |
| CloudWatch Logs（Reconciler、低頻度） | 取込 $0.76/GB + 保存 $0.033/GB-月 | ~$0.10 | ~$0.10 |
| EventBridge（1分毎 = 43,200 回/月、Lambda ターゲット） | 実質無視できる規模 | ~$0.05 | ~$0.05 |
| Lambda（Reconciler、無料枠内） | 無料枠 100万req/月・40万GB-s/月 | $0.00 | $0.00 |
| AWS Budgets（1個、無料枠2個まで） | 3個目以降 $0.02/日 | $0.00 | $0.00 |
| NAT Gateway | （不採用のため対象外） | $0 | $0 |
| **合計（概算）** |  | **約 $14.2/月**（既存 Route53 ゾーン再利用時 約 $13.7） | **約 $23.9/月**（既存ゾーン再利用時 約 $23.4） |

### 参考: スケジュールなし（常時稼働）との比較

730h/月・常時稼働の場合、t4g.small で EC2 $15.77 + EBS $1.92 + Public IPv4 $3.65 + その他
約 $1.0 ≈ **$22.3/月**。営業時間限定（8:00–23:00）により約 **37% のコスト削減**になる。

### 参考: NAT Gateway を採用した場合の増分（不採用の根拠）

NAT Gateway は $0.062/h。常時起動なら 730h × $0.062 = **$45.26/月**（データ処理料金別）が
追加される。本構成は public subnet + Session Manager 運用のため NAT 自体が不要（コスト方針
「NAT Gateway なし」と整合）。

### Budget 監視閾値（`EnvConfig.realtime.monthlyBudgetUsd`）

上記見積にバッファを載せ、環境別に AWS Budgets（`RealtimeRuntimeStack` の `MonthlyBudget`）で
実績 80% / 予測 100% 超過時にメール通知する設定を用意した（`budgetAlarmEmail` 未設定時は
通知購読を作らず Budget 本体のみ作成する）。

| 環境 | instanceType 初期値 | monthlyBudgetUsd |
| --- | --- | --- |
| dev | t4g.small | $20 |
| staging | t4g.small | $25 |
| prod | t4g.small（t4g.medium 切替候補） | $30 |

## 停止手段・ロールバック

- **即時停止（deploy 不要）**: SSM Parameter `/{prefix}/realtime/force-stop` を `"true"` に
  更新する（最大 1 分で反映）。
- **スケジュール変更**: `EnvConfig.realtime.schedule` を変更して再 deploy、または（後続
  increment で）運用画面から変更する。
- **完全停止/撤去**: `cdk destroy OpenReception-RealtimeRuntime-<env>`。本 Stack は WebStack
  など既存 Stack に一切依存しない・参照されないため、この Stack だけを安全に削除できる
  （VPC・SG・ASG・Launch Template・S3 artifact バケット・Route 53 レコード・Budget・Reconciler
  Lambda・SSM Parameter が全て本 Stack 内で完結）。
- **ロールバック**: 本 Stack は既存 Stack（`WebStack` 等）を一切変更しない完全な追加であるため、
  ロールバックは本 Stack の `cdk destroy` のみで完了する。他システムへの影響はない。
- **再 deploy**: `cdk deploy OpenReception-RealtimeRuntime-<env>` は冪等（ASG DesiredCapacity は
  Reconciler が実行時に追従するため、deploy の再実行で意図せず起動/停止しない設計 — ADR-002
  参照）。

## この increment の実装範囲

**やったこと（ローカルで `cdk synth`・vitest assertions で検証済み。deploy はしていない）**:

- `infra/lib/config/environments.ts`: `RealtimeRuntimeConfig`（instanceType・スケジュール・
  Budget 等）を全環境に追加。既定 `enabled: false`。
- `infra/lib/config/realtime-schedule.ts`: 営業時間判定の純粋関数（`isWithinBusinessHours` /
  `desiredCapacityFor`）とユニットテスト。
- `infra/lambda/realtime-reconciler/handler.ts` + `infra/lib/constructs/
  realtime-reconciler-function.ts`: ASG DesiredCapacity 調整・Route 53 UPSERT・force-stop
  kill-switch 読み取りを行う Lambda。
- `infra/lib/stacks/realtime-runtime-stack.ts`: VPC（NAT なし・単一 AZ）・Security Group
  （443 のみ・SSH 非開放）・IAM（Session Manager・Transcribe/Polly/Bedrock 最小権限）・
  Launch Template（IMDSv2 必須・EBS gp3 暗号化・arm64）・ASG（min=0/max=1）・EventBridge
  スケジュール・CloudWatch Alarm（Reconciler エラー）・AWS Budgets・任意 Route 53 連携。
- `infra/bin/open-reception.ts`: `config.realtime.enabled` によるガード配線（既定 false）。
- `infra/test/realtime-schedule.test.ts` / `infra/test/realtime-runtime-stack.test.ts`:
  境界値・タグ・SG ルール・ASG 設定・Budget 金額の assertions。

**やっていないこと（次 increment / 外部待ちスコープ）**:

- **実 `cdk deploy`/AWS apply**（本 increment のスコープ外、ユーザーの最終承認後に別途実施）。
- realtime gateway アプリ本体（Node.js gateway・conversation worker・Caddy 設定・systemd unit
  化・S3 artifact への実ビルド成果物配置）。
- `/health/live` `/health/ready` `/drain` API（アプリ本体が要るため）。
- 営業時間の DynamoDB 化（#367 ServiceOperatingPolicy との統合）。
- CloudWatch Agent による CPU/memory/disk/process/session 数の詳細監視（実 AMI・実機検証が
  要るため #65）。
- Component タグ `realtime-runtime` の `src/domain/platform/aws-cost.ts`
  `COST_COMPONENT_FILTERS` allow-list への正式登録（src/ は別トラック占有のため本 increment
  では見送り。`RealtimeRuntimeStack` は `Tags.of(this).add(...)` で直接タグ付けしており、
  Budget の `CostFilters` は機能する。developer 運用画面の Component 絞り込みプルダウンに
  `realtime-runtime` を追加するには src/ 側の 1 行追加が別途必要）。
- Route 53 hosted zone の新規作成/既存流用の最終決定（運用ドメインが未確定のため、CDK は
  `-c realtimeHostedZoneId` 等が未指定なら Route 53 リソースを作らない設計にしてある）。

## 受け入れ確認（issue #366 Phase 0 部分）

- [x] ADR-001〜006 の未決技術選択が解消されている（本書 + `docs/adr/0001-voice-transport.md`）。
- [x] 月額 Budget 見積を提示した（上表）。
- [x] `cdk synth` 可能な CDK コード（VPC/SG/ASG/LaunchTemplate/IAM/EventBridge/Budgets/
  Route53(任意)）を追加した。
- [x] 停止手段（force-stop kill-switch・`cdk destroy`）を定義した。
- [ ] 実 AWS 環境への deploy（**本 increment のスコープ外**。この見積を踏まえてユーザー承認後、
  別 increment で実施する）。
