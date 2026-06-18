# コスト管理タグ方針 (issue #33)

費用を環境別・機能別に追跡できるよう、open-reception のクラウドリソースに付与するタグ方針を定める。
本方針は AWS CDK によるフルサーバーレス構成（SPEC #32 / DESIGN #34）を前提とする。

## 1. 必須タグ

すべての課金対象リソースに以下を付与する。

| タグキー | 説明 | 例 |
| --- | --- | --- |
| `Project` | プロジェクト識別 | `open-reception` |
| `Environment` | 環境 | `dev` / `staging` / `prod` |
| `Component` | 機能コンポーネント | `reception-api` / `notification` |
| `Owner` | 管理責任者・チーム | `reception-team` |
| `ManagedBy` | プロビジョニング手段 | `cdk` |
| `CostCenter` | 費用負担部門（任意だが推奨） | `cc-1001` |

## 2. 環境ごとのタグ

- `Environment` で `dev` / `staging` / `prod` を区別し、環境別に費用を集計する。
- アカウント分離を行う場合も `Environment` タグは一貫して付与する（横断集計のため）。
- Cost Explorer / AWS Budgets を `Environment` でフィルタし、環境別の月額を追跡する。

## 3. 機能ごとのタグ

`Component` で機能別の費用を追跡する。初期コンポーネント例:

| Component | 対象リソース例 |
| --- | --- |
| `reception-api` | API Gateway / Lambda（受付・呼び出し） |
| `notification` | Lambda / Polly / Vonage 連携 |
| `directory` | 設定ストア（DynamoDB / SSM） |
| `storage` | アセット（S3） |
| `monitoring` | CloudWatch Logs / Alarm |
| `auth` | Secrets Manager / 認可関連 |

## 4. タグ付与漏れを防ぐ方法

1. **CDK で一括付与**: アプリ/スタックのルートで共通タグを付与し、配下リソースへ継承させる。

   ```ts
   import { Tags } from 'aws-cdk-lib';

   Tags.of(app).add('Project', 'open-reception');
   Tags.of(app).add('ManagedBy', 'cdk');
   Tags.of(stack).add('Environment', env);      // 環境別
   Tags.of(stack).add('Component', component);   // スタック=コンポーネント単位
   ```

2. **スタック=コンポーネント単位**で分割し、`Component` をスタック生成時に必須引数にする（付け忘れを型で防ぐ）。
3. **タグ検査の自動化**: デプロイ前に CDK の合成結果（`cdk synth`）を検査し、必須タグ未設定のリソースを検出して失敗させる（CI または `cdk-nag` 等のルール）。
4. **AWS 側の統制**: Organizations の Tag Policy / SCP、AWS Config ルール（`required-tags`）で逸脱を検知する。
5. **コスト配分タグの有効化**: 請求コンソールで上記キーを「コスト配分タグ」として有効化する（有効化しないと Cost Explorer で利用できない）。

## 5. 受け入れ確認

- [x] タグ方針が文書化されている（本書）
- [x] 環境別の費用を追跡できる（`Environment`）
- [x] 機能別の費用を追跡できる（`Component`）

## 関連

- フルサーバーレス・アーキテクチャ SPEC: issue #32
- CDK 詳細設計 DESIGN: issue #34
- 月額コスト試算: 上記インフラ設計で整理する
