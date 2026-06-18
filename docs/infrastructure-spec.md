# インフラ SPEC: フルサーバーレス・NoOps 音声通知システム (issue #32)

## 1. 概要

open-reception の呼び出し/通知サブシステムを、AWS マネージドサービス中心の
**フルサーバーレス構成**で設計する。限定された拠点（初期 5 拠点程度）からの低頻度な
通知リクエストを受け、テキストを音声化（Amazon Polly）して外部通知（Vonage）へ接続する。

常時稼働コンテナ（Fargate 等）ではなく **Lambda 中心**とし、待機コストを最小化する。
本書はアプリ本体（Next.js 受付/管理）とは別の通知サブシステムの基盤方針であり、
DESIGN（#34）で CDK 実装に落とし込む。

## 2. 設計方針

- Fargate 常時稼働ではなく **Lambda 中心**に移行し、待機コストを発生させない
- Lambda は原則 **VPC 外**に配置し、NAT Gateway の固定費を避ける
- API Gateway で通知リクエストを受ける
- Amazon Polly でテキストを音声化する（文字数課金 = 発生分のみ）
- Vonage で外部通知へ接続する（実通知分のみ課金）
- AWS CDK (TypeScript) でインフラを定義する
- 機密情報は AWS Secrets Manager で保護する
- 主要リソースにコスト管理タグを付与する（[cost-management-tags.md](./cost-management-tags.md)）

## 3. 構成

| 領域 | 採用候補 | 役割 |
| --- | --- | --- |
| API | Amazon API Gateway (HTTP API) | 通知リクエスト受付・認可・スロットリング |
| 処理 | AWS Lambda (Node.js) | 通知処理・音声化・外部通知連携 |
| 音声合成 | Amazon Polly | 読み上げ音声の生成（必要時のみ） |
| 外部通知 | Vonage | 通知・呼び出し連携 |
| 設定管理 | SSM Parameter Store / DynamoDB | 拠点別設定・通知先・音声設定 |
| 機密情報 | AWS Secrets Manager | 外部サービス接続情報 |
| 監視 | CloudWatch Logs / Metrics / Alarm | ログ・メトリクス・アラーム |
| IaC | AWS CDK (TypeScript) | インフラ定義 |
| スケジュール | EventBridge Scheduler | NoOps 定期ジョブ起動 |

### データフロー（通知）

```
拠点(受付/管理) → API Gateway → Lambda(通知) → Polly(音声化) → Vonage(外部通知)
                                   └→ CloudWatch(ログ/メトリクス)
                                   └→ Secrets Manager(接続情報) / SSM(拠点設定)
```

## 4. コスト方針

- API Gateway / Lambda は低頻度前提で従量課金の恩恵を最大化する
- Polly は文字数課金のため、通知発生分のみコスト化する
- Lambda を VPC 外に置き、NAT Gateway 固定費を避ける
- Vonage は実通知発生分のみをコスト対象にする
- CloudWatch Logs は保持期間を設定し、保存コストを抑える
- コスト配分タグ（`Project`/`Environment`/`Component` 等）で環境別・機能別に追跡する

## 5. NoOps 方針

- 週末など低影響時間帯に定期更新ジョブ（依存更新・テスト・静的解析・デプロイ）を実行する
- 実行基盤候補（EventBridge Scheduler + CodeBuild / CodePipeline / 外部 CI）の比較は DESIGN（#34）で行う
  - 本リポジトリのアプリ側は GitHub Actions を使用しない方針のため、インフラ側 CI/CD も
    その方針と整合する手段を選定する
- 失敗時の通知・ロールバック・再実行方針を定義する

## 6. セキュリティ方針

- Lambda の IAM 権限は最小権限とする
- **管理 API と通知実行 API を分離**する（アプリ側の admin/kiosk 分離と整合）
- 拠点ごとに識別子を持たせ、停止・失効できるようにする（アプリ側 kiosk 失効 #18 と整合）
- レート制限・スロットリングを設定する
- ログに機密情報・不要な個人情報を出力しない（[audit-logging.md](./audit-logging.md) と整合）
- 外部サービス接続情報は Secrets Manager で管理し、クライアントに置かない

## 7. アプリ本体との関係

- 受付 UI / 管理 UI / 受付フロー / ディレクトリ / 認可は Next.js アプリ（本リポジトリ）が担う
- 通話/通知の実発信（Vonage, #4）と音声化（Polly）はこの通知サブシステムが担う
- アプリ側の `CallAdapter`（#20）の本番実装が、本サブシステムの通知 API を呼び出す形を想定する

## 8. DESIGN（#34）で詰めること

CDK ディレクトリ構成 / Stack 分割 / Construct 設計 / 環境別設定 / Lambda handler 設計 /
Polly adapter / Vonage adapter / 拠点認可方式 / 監視・アラーム / ログ保持期間 /
コスト管理タグ適用 / CI/CD 自動更新フロー / ローカル開発・テスト方針。

## 9. 受け入れ確認

- [x] 本方針が SPEC として文書化されている
- [x] Fargate 常時稼働ではなく Lambda 中心の構成になっている
- [x] 待機コストを抑える方針が明記されている
- [x] API Gateway / Lambda / Polly / Vonage / CDK の役割が明確である
- [x] DESIGN（#34）作成に進める状態になっている
