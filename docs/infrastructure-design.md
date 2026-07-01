# DESIGN: CDK 詳細設計（通知サブシステム） (issue #34)

[インフラ SPEC（#32）](./infrastructure-spec.md) を受けて、AWS CDK (TypeScript) による
詳細設計を定める。CDK 実装を開始できる粒度を目標とする。

## 1. ディレクトリ構成

```text
infra/
  bin/
    open-reception.ts        # CDK App エントリ（環境ごとに Stack を生成）
  lib/
    stacks/
      notification-stack.ts  # API Gateway + Lambda + Polly/Vonage 連携
      monitoring-stack.ts    # CloudWatch Dashboard / Alarms
    constructs/
      notification-api.ts    # HTTP API + ルート + スロットリング + 認可
      notification-function.ts  # 通知 Lambda（環境変数・権限・ログ保持）
      cost-tags.ts           # 共通タグ付与ヘルパ
    config/
      environments.ts        # 環境別設定（dev/staging/prod）
  package.json
  cdk.json
src/
  server/
    notification/
      handler.ts             # Lambda エントリ（検証→音声化→外部通知）
      polly-adapter.ts       # Amazon Polly 実装
      vonage-adapter.ts      # Vonage 実装
      validation.ts          # 入力スキーマ検証
```

アプリ本体（Next.js 受付/管理）とインフラ（`infra/`）・サーバ処理（`src/server/`）を分離する。

## 2. Stack 分割

| Stack | 責務 | 主リソース |
| --- | --- | --- |
| NotificationStack | 通知 API と処理 | HTTP API Gateway、通知 Lambda、SSM/Secrets 参照、Log Group |
| MonitoringStack | 監視 | CloudWatch Alarms（エラー率/遅延/スロットル）、Dashboard、SNS 通知 |

- Stack = コンポーネント単位（コスト配分タグ `Component` を Stack 生成時の必須引数にする）。
- 環境（dev/staging/prod）ごとに別 Stack インスタンスを生成（`environments.ts`）。

## 3. Construct 設計

- `NotificationApi`: HTTP API + ルート（`POST /notify`）、スロットリング（rate/burst）、認可（拠点トークン検証の Lambda authorizer）。
- `NotificationFunction`: Node.js Lambda。環境変数で SSM/Secrets の参照名を渡す。**VPC 外**配置。ログ保持期間を設定（例: 30 日）。最小権限 IAM（Polly:SynthesizeSpeech、Secrets 読取、SSM 読取、Logs）。
- `CostTags`: `Tags.of(scope).add(...)` を集約し、必須タグ（`Project`/`Environment`/`Component`/`Owner`/`ManagedBy`）を一括付与。

## 4. 環境別設定（environments.ts）

```ts
export type EnvConfig = {
  environment: 'dev' | 'staging' | 'prod';
  logRetentionDays: number;
  throttle: { rateLimit: number; burstLimit: number };
  alarmEmail: string;
};
```

- prod はログ保持・アラーム閾値を厳格化。dev は緩め。
- 設定値はコードで型付けし、付け忘れ・誤設定を型で防ぐ。

## 5. Lambda handler 設計（handler.ts）

1. 入力検証（拠点 ID・通知種別・本文・通知先）。不正は 400。
2. 拠点設定を SSM/DynamoDB から取得（通知先・音声設定）。
3. 必要なら Polly で音声化（`polly-adapter`）。文字数最小化。
4. `vonage-adapter` で外部通知を実行。応答/失敗/タイムアウトを分類。
5. 結果と最小限のメタdata を CloudWatch に記録（PII・secret は出力しない）。
6. 冪等性: リクエスト ID で重複実行を抑止。

## 6. adapter 設計

- `PollyAdapter`: `synthesize(text, voice, language): Promise<AudioRef>`。失敗時はテキスト fallback を上位へ通知。
- `VonageAdapter`: `notify(target, payload): Promise<Result>`。token はサーバ側で短命発行、secret は Secrets Manager。
- アプリ側 `CallAdapter`（#20/#4）の本番実装が、この通知 API（`POST /notify`）を呼ぶ。

## 7. 拠点認可方式

- 拠点ごとに識別子と短命トークンを発行。API Gateway の Lambda authorizer で検証。
- 拠点の停止/失効に対応（アプリ側 kiosk 失効 #18 と整合）。
- 管理 API と通知実行 API を分離（最小権限・スコープ分離）。

## 8. 監視・アラーム

- メトリクス: Lambda エラー数/率、Duration p95、Throttles、API 4xx/5xx。
- アラーム: エラー率・遅延・スロットルが閾値超過で SNS 通知。
- Log Group は保持期間を設定しコストを抑制。

## 9. コスト管理タグ適用

- `CostTags` で必須タグを一括付与（[cost-management-tags.md](./cost-management-tags.md)）。
- `cdk synth` 後にタグ未設定リソースを検査して失敗させる（CI/ローカル）。

## 10. CI/CD 自動更新フロー（比較）

| 方式 | 長所 | 短所 |
| --- | --- | --- |
| EventBridge Scheduler + CodeBuild | AWS 内で完結、NoOps 向き | パイプライン構築コスト |
| CodePipeline | 段階デプロイ・承認 | 設定が重い |
| 外部 CI（非 GitHub Actions） | 既存ワークフローと統合 | AWS 連携の権限設計が必要 |

本リポジトリのアプリ側は **GitHub Actions 不使用**方針のため、インフラ側も
EventBridge Scheduler + CodeBuild を第一候補とし、`cdk deploy` を低影響時間帯に実行する。
失敗時は SNS 通知・前リビジョンへロールバック・再実行を定義する。

## 11. ローカル開発・テスト方針

- `infra/` は `cdk synth` のスナップショット/アサーションテスト（`aws-cdk-lib/assertions`）。
- `src/server/notification` の handler/adapter は unit test（Polly/Vonage は mock）。
  `/notify` の wire schema・入力検証は `src/domain/notification/{notify,notify-validation}.ts`
  に単一定義（#275）。server 側 `types.ts`/`validation.ts` は再輸出のみ。
- アプリ側の `CallAdapter` は既存の MockCallAdapter（#20）で e2e 可能。

## 12. 受け入れ確認

- [x] DESIGN に詳細設計が記載されている
- [x] CDK 実装を開始できる粒度になっている
- [x] Stack と Construct の責務が明確である
- [x] セキュリティ・運用・コスト管理の方針が実装可能な形になっている
