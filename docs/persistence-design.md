# 永続化層の設計 (DynamoDB 移行)

ステータス: 実装済み（フェーズ 1〜5 完了）/ SDD（仕様駆動開発）
関連: `docs/infrastructure-design.md`, `docs/audit-logging.md`, `src/ARCHITECTURE.md`, `docs/deploy-aws.md`

実装の所在:
- 抽象 / バックエンド: `src/lib/data/{backend,index,memory,dynamodb}.ts`
- ストア（async 化済み）: `src/lib/data-stores/*`, `src/lib/{kiosk,assets,motion,security,voice}/*-store.ts`
- CDK テーブル: `infra/lib/stacks/web-stack.ts`（`DataTable` + GSI1 + TTL + IAM 付与）
- seed: `scripts/seed-dynamodb.ts`（`npm run seed:dynamodb`）

実装上の確定事項（仕様からの差分メモ）:
- DynamoDB のキーは name から導出する（コレクション=`col#<name>`, シングルトン PK=`config`/SK=`<name>`,
  ログ=`log#<name>` / SK=`<timestamp>#<id>`, GSI1=`log#<name>#idx#<value>`）。§4.1 の表は概念図。
- DynamoDB テーブルは WebStack 内に定義（grant/env 配線をローカル化）。prod は RETAIN + PITR + 削除保護。

## 1. 背景と問題

現状、業務データはすべて **プロセス内のモジュール変数**（配列 / `Map`）で保持している。

| ストア | 実体 | ファイル |
|--------|------|----------|
| 部署・担当者 | `let departments`, `let staff` | `src/lib/data-stores/directory-store.ts` |
| 受付セッション | `const sessions = new Map()` | `src/lib/data-stores/reception-store.ts` |
| 受付履歴・監査ログ | `const receptionLogs/auditLogs = []` | `src/lib/data-stores/reception-log-store.ts` |
| 端末レジストリ | `let kiosks` | `src/lib/kiosk/kiosk-store.ts` |
| アセット | `let assets`, `let active` | `src/lib/assets/asset-store.ts` |
| モーション割当 | `let mapping` | `src/lib/motion/motion-store.ts` |
| セキュリティ設定 | `let settings` | `src/lib/security/security-store.ts` |
| 音声設定 | `let settings` | `src/lib/voice/voice-store.ts` |

これは OpenNext で AWS Lambda にデプロイすると破綻する:

- Lambda はリクエストごとに別インスタンス／コールドスタートで起動し、モジュール変数は初期 seed に戻る。
- 同時実行時は複数インスタンスにまたがり、状態が共有されない。
- 監査・受付履歴はメモリ上限（1000 / 5000 件）で**サイレントに破棄**される。

→ インフラ（CloudFront + Lambda + S3）はサーバーレスとして完成しているが、アプリは「ステートレス前提」を満たしていない。**状態を外部ストアに出す**必要がある。

## 2. 目標 / 非目標

### 目標
- すべての業務データを Lambda インスタンス間で共有・永続化する。
- ドメインロジック（検索・状態遷移・バリデーション）は**変更しない**。
- 開発・テストは現状どおり外部依存なしで動く（in-memory のまま）。
- 本番（AWS）は DynamoDB を使う。切替は環境変数 1 つ。
- コスト最小（オンデマンド課金、VPC なし、固定費ゼロ）。

### 非目標
- RDB / リレーション・トランザクション境界の厳密化（現状の単純な CRUD で十分）。
- マルチテナント分離（将来スコープ）。
- 既存の認証・通知サブシステムの変更。

## 3. アーキテクチャ方針

### 3.1 リポジトリ抽象 + バックエンド切替

ストアの公開関数を **async なリポジトリ interface** に再構成し、2 実装を用意する。

```
src/lib/data/
  types.ts                  Result / StoreError 共通型
  repositories.ts           各 Repository interface 定義
  index.ts                  getRepositories(): バックエンド選択ファクトリ（DATA_BACKEND）
  memory/                   in-memory 実装（現行ロジックを async 化して移設）
    directory-repo.ts
    reception-repo.ts
    ...
  dynamodb/                 DynamoDB 実装
    client.ts               DocumentClient（ハンドラ外で 1 度だけ生成）
    keys.ts                 PK/SK エンコード
    directory-repo.ts
    ...
```

- **切替**: `DATA_BACKEND` 環境変数。`memory`（既定, dev/test/CI）/ `dynamodb`（AWS）。
- **fail-closed（#273 inc1）**: デプロイ実行（`AWS_LAMBDA_FUNCTION_NAME` あり）で
  `DATA_BACKEND` 未設定なら throw し、揮発性 memory への黙示フォールバックを拒否する。
  ローカルの production ビルド（`next start` での e2e / lighthouse）はマーカーが無いため
  従来どおり memory。明示的な `DATA_BACKEND=memory` は意図的な選択として許容。
- バリデーション・派生（`validateStaffInput`, `searchStaff`, `deriveReceptionLog`, `transition` 等）は **pure なまま** リポジトリの外（ドメイン or リポジトリ内の同期ヘルパ）に残す。リポジトリは「永続化プリミティブ」に集中する。

### 3.2 非同期化の波及

現在のストア関数は大半が同期。DynamoDB は非同期 I/O のため、**全リポジトリメソッドを `Promise` 化**する。影響:

- 31 のルートハンドラで `await` を付与。`GET` の同期ハンドラは `async` に変更。
- `Result<T>` 型はそのまま（`Promise<Result<T>>` を返す）。HTTP 変換ヘルパ（`result-http.ts`, `http.ts`）は変更不要。

この非同期化は in-memory バックエンドでも適用する（コードパスを 1 本化し、両バックエンドで同一の呼び出し規約にするため）。in-memory 実装は `async` 関数で同期ロジックを包む。

## 4. DynamoDB データモデル（シングルテーブル）

低トラフィック・単純 CRUD のため **1 テーブル / オンデマンド課金** とする。

- テーブル名: CDK 生成（`appEnv.TABLE_NAME` で server Lambda に注入）
- 主キー: `PK` (S, パーティションキー) + `SK` (S, ソートキー)
- TTL 属性: `ttl` (N, epoch 秒) — 受付セッションのみ設定
- GSI1: `GSI1PK` (S) + `GSI1SK` (S) — 受付履歴を receptionId で引く用途
- 課金: `PAY_PER_REQUEST`（キャパシティ管理不要）
- 暗号化: AWS 管理キー（SSE 既定）、PITR 有効（prod）

### 4.1 キー設計とアクセスパターン

| エンティティ | PK | SK | 主なアクセス |
|--------------|----|----|--------------|
| 部署 | `DEPT` | `<deptId>` | `Query PK=DEPT`（全件→アプリで displayOrder ソート）/ `GetItem` |
| 担当者 | `STAFF` | `<staffId>` | `Query PK=STAFF`（全件→検索はアプリ内 `searchStaff`）/ `GetItem` |
| 受付セッション | `RECEPTION` | `<receptionId>` | `GetItem` / `PutItem`、`ttl` 付与 |
| 受付履歴 | `RCPLOG` | `<at>#<logId>` | `Query PK=RCPLOG, ScanIndexForward=false`（新しい順）<br>`GSI1PK=RCPLOG#<receptionId>` で fallback 追記対象を特定 |
| 監査ログ | `AUDIT` | `<at>#<logId>` | `Query PK=AUDIT, ScanIndexForward=false` |
| 端末 | `KIOSK` | `<kioskId>` | `Query PK=KIOSK` / `GetItem` |
| アセット | `ASSET` | `<assetId>` | `Query PK=ASSET`（種別はアプリ内 filter）/ `GetItem` |
| アクティブアセット集合 | `CONFIG` | `ACTIVE_ASSETS` | シングルトン `GetItem`/`PutItem` |
| モーション割当 | `CONFIG` | `MOTION_MAPPING` | シングルトン |
| セキュリティ設定 | `CONFIG` | `SECURITY` | シングルトン |
| 音声設定 | `CONFIG` | `VOICE` | シングルトン |

設計判断:
- 件数が小さい集合（部署・担当者・端末・アセット）は **パーティション 1 つに Query** で十分。ホットパーティション懸念は規模的に無視できる。
- 並び順（displayOrder, priority）や検索（kana/aliases）は **取得後にアプリ側ロジックで処理**し、既存ドメイン関数をそのまま使う。
- 設定系は単一アイテムの上書き。読み取り時に未存在なら**コード上の DEFAULTS を返す**（seed 不要）。

### 4.2 受付履歴の fallback 追記

`markFallbackUsed(receptionId)` は receptionId から履歴 1 件を引く必要がある。GSI1 を使う:

- 履歴アイテムに `GSI1PK = RCPLOG#<receptionId>`, `GSI1SK = <at>` を付与。
- `Query GSI1 PK=RCPLOG#<receptionId>` で対象を取得し `fallbackUsed=true` を `UpdateItem`。

### 4.3 保持期間 (docs/audit-logging.md と整合)

- 受付セッション: `ttl` で短期失効（既定 24h、`RECEPTION_SESSION_TTL_SEC`）。
- 受付履歴・監査ログ: 当面 TTL を設けず保持（将来、保持期間ポリシーを `ttl` で実装可能なよう属性を予約）。メモリ版の MAX 件数破棄は DynamoDB では撤廃。

## 5. CDK 変更

- 新規 `DataStack`（または WebStack 内）に `dynamodb.Table` を定義。
  - `billingMode: PAY_PER_REQUEST`、`partitionKey: PK`、`sortKey: SK`、`timeToLiveAttribute: ttl`。
  - GSI1（`GSI1PK`/`GSI1SK`）。
  - `removalPolicy`: prod=`RETAIN`+PITR、非 prod=`DESTROY`。
- WebStack の `serverFn` に:
  - `table.grantReadWriteData(serverFn)`。
  - 環境変数 `DATA_BACKEND=dynamodb`, `TABLE_NAME=<table>`, `AWS_REGION`（Lambda 標準で利用可）。
- 環境別設定（`environments.ts`）に `data: { pointInTimeRecovery, removalProtection }` を追加。

## 6. 移行フェーズ

1. **仕様書**（本書）。
2. **抽象 + 非同期化（in-memory）**: `src/lib/data/` 導入、ルートを await 化、既存テスト緑。旧 store ファイルは互換 re-export で段階移行。
3. **DynamoDB 実装**: `dynamodb/` 配下、marshalling のユニットテスト。
4. **CDK**: テーブル + 配線 + synth テスト。
5. **シード + ドキュメント**: 初期投入（CSV インポート流用 or seed スクリプト）、`deploy-aws.md` 更新。

各フェーズ末で `npm run verify`（typecheck / lint / test / build）を通す。

## 7. テスト戦略

- **契約テスト**: リポジトリ interface に対する共通テストスイートを作り、in-memory 実装で実行（既存 store テストを移植）。
- **DynamoDB marshalling**: アイテム ⇄ ドメイン型の変換、キー生成を純粋関数として単体テスト。
- **CDK synth**: テーブル / GSI / TTL / IAM 付与を `Template` アサーション。
- 実 DynamoDB に対する結合テストは任意（DynamoDB Local が使える環境でのみ）。CI 必須にはしない。

## 8. リスクと緩和

| リスク | 緩和 |
|--------|------|
| 31 ルートの async 化による回帰 | フェーズ 2 で in-memory のまま全テスト緑を確認してから DynamoDB 着手 |
| 設定シングルトンの未存在 | 読み取り時に DEFAULTS フォールバック（書き込み時に作成） |
| コールドスタートの SDK 初期化コスト | DocumentClient をハンドラ外で生成、`@aws-sdk/lib-dynamodb` を遅延 import |
| 既存 seed データ（mock-data）依存のテスト | in-memory は引き続き seed 利用。DynamoDB は seed 非依存設計 |
