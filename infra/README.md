# infra — open-reception AWS CDK

open-reception の AWS インフラを CDK (TypeScript) で定義する。

## 構成

```
infra/
  bin/open-reception.ts          # CDK App エントリ（env=dev|staging|prod を context で選択）
  lib/
    stacks/
      web-stack.ts               # Next.js (OpenNext) ホスティング: CloudFront+Lambda+S3
      # notification-stack.ts     # 通知サブシステム (#32/#34) ← 追加予定
    constructs/
      cost-tags.ts               # コスト管理タグ一括付与
    config/
      environments.ts            # 環境別設定（型付き）
  test/web-stack.test.ts         # synth アサーションテスト
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
- 機密の環境変数は平文コミットしない（[deploy-aws.md](../docs/deploy-aws.md) §5）。
