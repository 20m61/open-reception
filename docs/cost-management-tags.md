# コスト管理タグ方針 (issue #33 / #377)

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
| `web` | Next.js / OpenNext Lambda、DynamoDB、S3、CloudFront |
| `web-monitoring` | Web Lambda / DynamoDB の CloudWatch Alarm・Dashboard |
| `cloudfront-monitoring` | CloudFront 5xx Alarm（us-east-1） |
| `notification` | Lambda / API Gateway / Polly / Vonage 連携 |
| `monitoring` | 通知基盤の CloudWatch Alarm・Dashboard |

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

## 5. developer 運用画面でのコスト可視化 (#377)

`/platform` の AWS コストパネルは、developer 専用 API `/api/platform/costs` から Cost Explorer を参照する。

- `Project` はサーバー側の `AWS_COST_PROJECT_TAG_VALUE`（CDK 既定: `open-reception`）へ固定する。
- 初期 `Environment` はデプロイ環境の `AWS_COST_ENVIRONMENT_TAG_VALUE` へ固定し、画面から `all / dev / staging / prod` を選択できる。
- `Component` は CDK Stack に対応する allow-list からだけ選択できる。
- Component 未指定時は `Component` タグ別、指定時は AWS `SERVICE` 別の実績内訳を表示する。
- 月初から当日までの終了日排他的な実績と、当日から月末までの Cost Forecast を合算して月末見込みを表示する。
- Cost Explorer API 障害、権限不足、Cost Explorer 未有効化、タグ反映待ちは `status: unavailable` として縮退し、他の運用指標は表示を継続する。

CDK は OpenNext server Lambda に以下だけを許可する。Cost Explorer は resource-level permission に対応しないため `Resource: "*"` が必要だが、Action は read-only の2操作へ限定する。

```json
{
  "Effect": "Allow",
  "Action": ["ce:GetCostAndUsage", "ce:GetCostForecast"],
  "Resource": "*"
}
```

### 初回セットアップ

1. AWS Billing and Cost Management で Cost Explorer を有効化する。
2. **Cost allocation tags** で少なくとも `Project` / `Environment` / `Component` を Active にする。
3. CDK を再デプロイし、server Lambda の IAM と環境変数を更新する。
4. developer ロールで `/platform` を開き、固定 Project と Environment / Component の絞り込みを確認する。

請求実績とタグはリアルタイムではない。タグ有効化直後や新規リソース作成直後は、画面にデータが現れるまで時間がかかる。Cost Forecast は履歴不足時に利用できないため、その場合は当月実績だけを表示する。

## 6. 受け入れ確認

- [x] タグ方針が文書化されている（本書）
- [x] 環境別の費用を追跡できる（`Environment`）
- [x] 機能別の費用を追跡できる（`Component`）
- [x] developer 画面で許可済みタグによる絞り込み仕様が定義されている
- [x] Cost Explorer IAM・縮退動作・初回セットアップが定義されている

## 関連

- フルサーバーレス・アーキテクチャ SPEC: issue #32
- CDK 詳細設計 DESIGN: issue #34
- developer AWS コスト可視化: issue #377
- 月額コスト試算: 上記インフラ設計で整理する
