# infra — open-reception AWS CDK

open-reception の AWS インフラを CDK (TypeScript) で定義する。

## 構成

```
infra/
  bin/open-reception.ts          # CDK App エントリ（env=dev|staging|prod を context で選択）
  lib/
    stacks/
      web-stack.ts               # Next.js (OpenNext) ホスティング: CloudFront+Lambda+S3
      web-monitoring-stack.ts    # WebStack の監視 (#299): Lambda/DynamoDB Alarms + Dashboard
      cloudfront-monitoring-stack.ts # CloudFront 5xx アラーム (#303): us-east-1 専用
      notification-stack.ts      # 通知サブシステム (#32/#34): HTTP API+Lambda+authorizer
      monitoring-stack.ts        # 通知の監視: CloudWatch Alarms / Dashboard / SNS
      realtime-runtime-stack.ts  # リアルタイム会話 EC2 基盤 (#366 Phase 0): ASG+LaunchTemplate
                                  # +EventBridge Reconciler+Budgets。config.realtime.enabled=false
                                  # が全環境既定（deploy 未実施）。ADR: docs/adr/0003-*.md
    constructs/
      cost-tags.ts               # コスト管理タグ一括付与
      notification-function.ts   # 通知 Lambda（NodejsFunction + 最小権限 IAM）
      notification-api.ts        # HTTP API + POST /notify + 拠点 authorizer + throttle
      realtime-reconciler-function.ts # 営業時間 Reconciler Lambda（ASG DesiredCapacity 調整）
    config/
      environments.ts            # 環境別設定（型付き）
      realtime-schedule.ts       # 営業時間判定の純粋関数 (#366)
  lambda/
    realtime-reconciler/handler.ts # Reconciler Lambda ハンドラ本体（esbuild バンドル対象）
  test/
    web-stack.test.ts            # WebStack synth アサーション
    web-monitoring-stack.test.ts # WebMonitoringStack synth アサーション
    cloudfront-monitoring-stack.test.ts # CloudFrontMonitoringStack + cross-region 連携
    notification-stack.test.ts   # Notification/Monitoring synth アサーション
    realtime-runtime-stack.test.ts # RealtimeRuntimeStack synth アサーション (#366)
    realtime-schedule.test.ts    # 営業時間判定のユニットテスト (#366)
```

詳細設計は [`../docs/infrastructure-design.md`](../docs/infrastructure-design.md)、
デプロイ手順は [`../docs/deploy-aws.md`](../docs/deploy-aws.md)。

## 使い方

```bash
# 1) ルートで OpenNext 成果物を生成（WebStack が .open-next/ を取り込む）
cd .. && npm run build:open-next && cd infra

# 2) 依存インストール
npm install

# 3) 合成 / 差分 / デプロイ
npm run synth                       # env=dev
npx cdk synth  -c env=prod
npx cdk diff   -c env=prod
npx cdk deploy OpenReception-Web-prod -c env=prod -c appEnv.ADMIN_PASSWORD=... 
```

## コマンド

| コマンド | 用途 |
| --- | --- |
| `npm run typecheck` | CDK コードの型チェック |
| `npm test` | synth アサーション + config テスト（vitest） |
| `npm run synth` | `cdk synth`（env=dev） |
| `npm run diff` | `cdk diff` |
| `npm run deploy` | `cdk deploy` |

## 注意

- `cdk synth` / `deploy` 前にリポジトリルートで `npm run build:open-next` が必要。
  未ビルドの場合 `WebStack` が明示的にエラーを出す。
- デプロイ先は `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`（既定 `ap-northeast-1`）。
  `OpenReception-CfMonitoring-*` のみ us-east-1（CloudFront メトリクスの発行先）。
  認証情報なしの synth では `CDK_DEFAULT_ACCOUNT` が未解決のため CfMonitoring は
  synth 対象から除外される（cross-region 参照に concrete account が必要）。
- 機密の環境変数は平文コミットしない（[deploy-aws.md](../docs/deploy-aws.md) §5）。
