# 永続化層の設計 (DynamoDB 移行)

ステータス: 実装済み（フェーズ 1〜5 完了）/ SDD（仕様駆動開発）。
**新規エンティティの標準イディオムと list() の境界化は §9（#274 inc1）**。
関連: `docs/infrastructure-design.md`, `docs/audit-logging.md`, `src/ARCHITECTURE.md`, `docs/deploy-aws.md`

実装の所在:
- 抽象 / バックエンド: `src/lib/data/{backend,index,memory,dynamodb}.ts`
- ストア（async 化済み）: `src/lib/data-stores/*`, `src/lib/{kiosk,assets,motion,security,voice}/*-store.ts`
- CDK テーブル: `infra/lib/stacks/web-stack.ts`（`DataTable` + GSI1 + TTL + IAM 付与）
- seed: `scripts/seed-dynamodb.ts`（`npm run seed:dynamodb`）

実装上の確定事項（仕様からの差分メモ）:
- DynamoDB のキーは name から導出する（コレクション=`col#<name>`, シングルトン PK=`config`/SK=`<name>`,
  ログ=`log#<name>` / SK=`<timestamp>#<id>`, GSI1=`log#<name>#idx#<value>`）。§4.1 の表は概念図。
- コレクションの境界クエリ（`Collection.listByIndex`, #274/#284）も **既存 GSI1 を再利用**する
  （GSI1PK=`col#<name>#idx#<value>`, GSI1SK=`<id>`。`CollectionOpts.indexedField` 指定時に put が
  write-through）。名前空間が `log#` と分かれるため衝突しない。**CDK 追加・実デプロイ不要**。
  ただし sparse index のため、indexedField 導入以前に書かれた既存アイテムは再 put（backfill）まで
  listByIndex に現れない（§9.3 の注意参照）。
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

**セキュリティ設定の PIN は資格情報として保存する（#1021 AC3）。**
`SecuritySettings.pin` は**平文とは限らない** —— 新しい書き込みは PBKDF2-SHA256 の記録
（`pbkdf2-sha256$<反復>$<salt>$<hash>`）で、既定値や旧レコードの平文も**次の書き込みで昇格**する。
読み側は旧レコードの平文も検証できる（解釈は `src/domain/security/pin.ts` の 1 箇所に閉じている）。

- 「運用者が PIN を決めたか」は形式からではなく **`pinSetByOperator`（任意）** が持つ。
  昇格すると形式から判定できなくなるため、**昇格前の平文**でこのフラグを確定させる
- 🔴 **下り移行は無い（片道）。** 旧コードは記録を平文として比較するので、
  入れ替え中の短い窓では `pinRequired: true` のサイトの**新規 authorize だけ**が通らない。
  既存の kiosk セッションは `KIOSK_SESSION_SECRET` 署名の cookie で PIN と独立なので**無効化されない**。
  復旧は管理画面から PIN を入れ直すこと（旧コードはそれを平文で保存し直す）
- 🔴 **前進方向にも 1 つある（端末側で見える変化）。** `.env.example` のまま
  `KIOSK_PIN=`（空）で `pinRequired: true` にしていたサイトは、**今日は PIN 欄を
  空のまま「受付を開始する」を押せば通っていた**（空同士が一致していた）。
  この増分の後は空入力が拒否され、組込み既定 `0000` の入力が要る。
  端末側の症状は「**昨日まで通っていた操作で `PIN が正しくありません`**」なので、
  リリース時に運用者へ伝えること。恒久的な対処は PIN を実際に設定すること
- 🔴 **運用者が入力した PIN は、綴りが何であっても保存時に `ITERATIONS` で作り直す。**
  入力を「もう記録の形だから」と素通しすると、通る入力が 1 つも無い状態を作れてしまう
  （かつ未認証経路の計算量を管理操作から引き上げられる）

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
- TTL 属性: `ttl` (N, epoch 秒) — 受付セッションと**試行予算**（下記 4.2）に設定
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

### 4.4 試行予算（`auth-attempts`）の保持（#1021 AC4）

`/api/kiosk/authorize` の試行回数制限が使うコレクション。**この増分の対象は kiosk だけ**で、
`/api/admin/login` は射程外である（独立レビュー 3 周目で撤回。#1165 で設計し直す）。

| 項目 | 内容 |
| --- | --- |
| 保持期間 | **2 時間**（`ttlSeconds`。窓を開き直すたびに延長する） |
| 保存する値 | 窓の開始時刻・窓の中で入場した試行の回数 **のみ** |
| 鍵 | `kiosk-authorize#ip:<sha256(salt ‖ viewer IP)>` または `kiosk-authorize#global` |

🔴 **生の IP は保存しない。** 予算の鍵は「同じ発信元か」を判定できれば足りるので、
値そのものは要らない。IPv4 は空間が小さく、salt 無しの `sha256(ip)` は総当たりで
逆引きできるので、salt を混ぜた不可逆ハッシュにする。

🔴 **salt は設定値ではなく、プロセス起動ごとの乱数である**（`client-identity.ts`）。
一度は `ATTEMPT_KEY_SALT` という env にしたが、**`infra/` にも `docs/deploy-aws.md` にも
配線が無く**、実デプロイではリポジトリに平文で置かれた dev 既定値が使われていた ——
公開既定値の salt は salt ではないので、「逆引きできない」という主張が**配備の現実で偽**だった。
配線し忘れると静かに嘘になる設定を足すより、設定を要らなくする方を採っている。

**代償**（正確に書く）:

- 一次（発信元ごと）の予算は実質**プロセスあたり**になり、同時に生きている実行環境の数だけ緩む。
  **「1 IP あたり 10 回/10 分」とは言えない。**
- 総量の上界を持つ **global cap（60 回/10 分）は影響を受けない** —— 鍵が固定文字列
  `kiosk-authorize#global` で salt を通らないからである。総当たりへの実際の backstop はこちら。
- プロセスが入れ替わると、その分の一次窓が孤児レコードとして残る。上限は
  「実行環境の数 × その環境が見た発信元の数」で、**TTL 2 時間で自然消滅する**。
  鍵空間の増大と書き込み増幅の監視は #1164。

🔴 **PIN / パスワードは一切保存しない。** 記録するのは回数だけで、入力値・成否の内訳は残さない。

🔴 **これは監査ではない。** 「誰の IP か」を後から知る必要がある調査は、
認可済み操作に紐づく高詳細監査（`auditContextFromRequest`）の領分である。
こちらの鍵は salt がプロセス外に存在しないので、**プロセスが終わった時点で照合もできない**。

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

## 9. 永続化イディオムの標準（issue #274 inc1）

§3 の「リポジトリ抽象」は実装過程で 2 系統に分岐した。本節はそれを 1 つに収斂させる
**新規エンティティの標準**を定める（§3 と矛盾しない拡張。既存コードの一括移行はしない）。

### 9.1 現状の 2 イディオム

1. **getBackend() 直呼び store**（`src/lib/data-stores/*`、`src/lib/{assets,kiosk,platform,...}/*-store.ts` 約 20 ファイル）
   — モジュール関数が直接 `getBackend().collection()` を引く。手早いが、永続化詳細
   （collection 名・走査フィルタ）が呼び出し側へ漏れやすく、route が collection を
   直接触る逸脱（例: 旧 `/api/kiosk/checkout`。#274 ① で解消済み）を生みやすい。
2. **repository 三点セット**（tenant は #274 ②、visit は ①、signage は ⑦ で単一実装へ
   統合済み）— `repository.ts`（interface）+ `memory-repository.ts` +
   `backend-repository.ts` + `store.ts`（ファクトリ）。境界が型で明示される一方、backend
   抽象が既に memory/dynamodb 切替を提供しているため **memory 実装が二重投資**になっている。
   残る `src/lib/{reservation,notification}/` の memory 実装は「二重」ではなく**唯一の実装**
   （getBackend 未接続）のため、§9.4 の 7 参照。

### 9.2 新規エンティティの標準（決定）

**repository パターンに収斂する。ただし実装は 1 つだけ持つ**（memory-/backend- の
二重実装はしない）。

```
src/lib/<entity>/
  repository.ts        ドメイン語彙の interface（RepoResult、tenantId/siteId 等の境界引数）
                       + getBackend() の Collection/Singleton/LogStore に委譲する実装
                       （肥大時は data-repository.ts に実装を分離してよい）
  store.ts             プロセス共有ファクトリ（getXxxRepository()）とテスト用 reset
```

- interface は「テナント境界つきのドメイン操作」（`listSites(tenantId)` 等）を語彙にする。
  route / サービスは interface のみに依存し、collection 名や走査フィルタを知らない。
- 実装は 1 つ: memory/dynamodb の差し替えは backend 層（`DATA_BACKEND`）が担うため、
  エンティティごとの in-memory repository は作らない。テストは memory backend + seed で行う。
- 参考実装: `src/lib/tenant/data-repository.ts`、`src/lib/reception/flow-config/repository.ts`。
- **シングルトン設定**（voice/security/motion/i18n/branding 等の単一値設定）は例外とし、
  現行の「store 関数 + Singleton」のままでよい（repository 化の価値が薄い）。

判断根拠:
- Collection 抽象が既に backend 差し替えとテスト容易性（memory backend）を提供しており、
  memory repository の重複実装に維持コストを払う価値がない。実際、新しいコード
  （tenant inc3 以降・flow-config・staff-response-config）は自然にこの形へ収束している。
- interface があることで境界（tenantId/siteId）と契約（RepoResult）が型で明示され、
  #80 のテナント境界強制・#274 の境界クエリ移行を実装差し替えだけで行える。

### 9.3 list() の境界化（inc1 実装済み）

- `Collection.list(options?: { limit })` — 既定 `DEFAULT_COLLECTION_LIST_LIMIT`（500）。
  memory / dynamodb 両実装が上限を強制し、超過分は **warn を出して切り詰める**
  （サイレント欠落しない）。dynamodb は Query の `Limit` に残数を渡し、上限到達で
  ページングを打ち切る。
- 呼び出し側の運用: **構造的に小さい設定系**（部署・端末・アセット等）は既定上限のまま、
  **増加し得る一覧**（担当者・滞在記録・テナント/サイト/デバイス・platform 運用レコード）は
  呼び出し箇所で limit を明示する（例: `STAFF_LIST_LIMIT` / `STAY_LIST_LIMIT` /
  `TENANT_SCOPE_LIST_LIMIT` / `PLATFORM_LIST_LIMIT`）。
- この上限は**安全弁**であり恒久解ではない。上限に近づく集合は境界付きクエリ
  （GSI / 維持カウンタ）へ移行する（#284 と統合設計）。
- **境界付きクエリの標準プリミティブ（#274 ②/#284 で追加）**: `Collection.listByIndex(value,
  { limit })`。`CollectionOpts.indexedField`（**不変フィールド限定**。updateIf は GSI キーを
  更新しない）を指定した collection で使え、dynamo は GSI1（`col#<name>#idx#<value>`）への
  Query、memory は等価フィルタ。読み取り量がスコープ内の件数に比例する。
  - 適用済み: device（indexedField=`tenantId`）。死活集計（device-fleet）は「テナント一覧起点 +
    テナント毎の listByIndex」で集約し、無境界の listAllDevices を廃止した。
  - **backfill の注意**: GSI1 キーは put 時に書くため、導入以前の既存 dynamodb アイテムは
    再 put まで listByIndex に現れない（sparse index）。デプロイ増分で backfill
    （seed 再実行 or 対象アイテムの再保存）を行うこと。memory backend は影響なし。
- `LogStore.list()` は本増分の対象外（受付/監査ログの集計経路は #254 の `listSince` で
  境界化済み。残る全件 list は管理画面表示のみで、境界化は移行増分で扱う）。

### 9.3.1 条件付き作成 `putIfAbsent`（#367 で追加）

- `Collection.putIfAbsent(item): Promise<boolean>` — **不在のときだけ**作成し、既にあれば
  何もせず `false`。`updateIf` に続く 2 つ目の原子的書き込みプリミティブで、全 backend 実装に
  義務がある（memory は `has` → `set` を同期で、dynamodb は `attribute_not_exists(PK)` 付きの
  PutItem）。
- **なぜ必要か**: `get` → 無ければ `put` は原子的でないので、2 人が同時に初回作成すると
  片方が無言で消える。`updateIf` は `attribute_exists(PK)` を必須にする契約なので作成には
  使えない（不在 id への upsert を防ぐため。§9.3 の GSI 注意と同じく意図的な制約）。
  最初の 1 件が緊急停止の設定なら、消えた側は「止めたつもり」のまま残る。
- 適用済み: runtime policy（`src/lib/runtime-policy/store.ts`）。決定論的キー
  （`<tenantId>:<siteId>`）で 1 サイト 1 レコードを持つ store は、同じ理由で作成経路に
  これを使うこと。
- **テスト時の注意**: dynamodb backend のテスト用 FakeDoc は、PutCommand の
  `ConditionExpression` を評価する。評価しない fake だと、条件を落とす変更も
  `attribute_exists` へ反転する変更も緑のまま通り、**本番だけが壊れる**。

### 9.4 既存 store の移行順（段階増分、1 PR = 1〜2 エンティティ、挙動不変）

1. ~~**visitstay**~~ — **済（#274 ①）**。`/api/kiosk/checkout` の getBackend() 直呼びを
   `StayRepository.listPresent`（KioskStayService 経由）へ解消。visit の
   `memory-repository.ts` / `backend-repository.ts` の二重実装は廃止し、
   `src/lib/visit/repository.ts`（interface + DataBackedStayRepository）+ store のファクトリ
   （getStayRepository）へ統合（テストは memory backend + seed で単一実装を直接検証）。
2. ~~**device / kiosk**~~ — **済（#274 ②/#284）**。kiosk-store は `KioskRepository`
   （`src/lib/kiosk/repository.ts` + kiosk-store のファクトリ/互換 API）へ、tenant の
   `memory-repository.ts` は廃止（テストは memory backend + seed で DataBacked 実装を直接検証）。
   死活集計の境界クエリ化は §9.3 の listByIndex（tenantId）で恒久化。kiosk レジストリ自体の
   Device への本統合（Device 起点発番）は docs/site-device-management-design.md の残増分。
3. ~~**platform 系**~~（incident / notice / maintenance-window / update-status / feature-flag
   / elevation-jti）— **済（#274 ③）**。`src/lib/platform/repository.ts` に interface +
   getBackend() 委譲実装（運用レコード 4 種は同型契約 `PlatformRecordRepository<T>`、
   feature-flag / elevation-jti は専用 interface）を集約し、各 `*-store.ts` はファクトリ +
   互換 API（呼び出し側 route は無変更）。elevation-jti はセキュリティ経路（#264/#278）のため
   fail-closed / updateIf CAS / 冪等 revoke の挙動を変えず移設。`PLATFORM_LIST_LIMIT` 維持。
4. ~~**directory**~~（department / staff）— **済（#274 ④）**。
   `src/lib/data-stores/directory-repository.ts`（DirectoryRepository + getBackend() 委譲の
   単一実装）+ directory-store のファクトリ/互換 API（検索・並び替え・CSV インポートは
   domain 純関数と互換 API のまま）。部署別の境界クエリは**採らない**: 規模が小さく
   （STAFF_LIST_LIMIT = 1000 の安全弁で十分）、departmentId は異動で変わる可変フィールドの
   ため §9.3 の indexedField（不変限定）に適さない。上限に近づいたら #284 と統合設計で移行。
5. ~~**reception-store（セッション）**~~ — **済（#274 ⑤）**。
   `src/lib/data-stores/reception-repository.ts`（ReceptionSessionRepository、TTL 付き
   Collection 委譲）+ reception-store のファクトリ/互換 API（状態機械・呼び出し adapter・
   監査/履歴化は互換 API のまま）。id でのみ引く短命データのため一覧 API は持たない。
6. ~~**reception-log-store**~~（LogStore）— **済（#274 ⑥）**。
   `src/lib/data-stores/reception-log-repository.ts`（ReceptionLogRepository /
   AuditLogRepository、getBackend() の LogStore 委譲）+ reception-log-store のファクトリ/
   互換 API。#254 の listSince 範囲クエリ契約（`>= sinceIso` 含む・新しい順）は
   repository の契約テストで固定。全件 list は管理画面表示のみ（§9.3 のとおり境界化は
   別増分）。
7. 既存三点セットの `memory-repository.ts` の機会的廃止 — **対象分は済（#274 ⑦）**。
   - signage: **済**。memory-/backend- の二重実装を廃止し `repository.ts`
     （DataBackedSignageRepository、Singleton 委譲の単一実装）へ統合。テストは memory
     backend + `__resetBackend` で単一実装を直接検証。
   - reservation / notification: **対象外（残置）**。これらの memory 実装は二重実装ではなく
     **唯一の実装**（getBackend 未接続。本番でもプロセス内メモリ）。廃止＝dynamodb 永続化
     への切替であり挙動不変で消せないため、それぞれの永続化増分
     （docs/visit-reservation-design.md / docs/call-route-config-design.md）で §9 標準へ
     移行する際に扱う。

**運用状態（#274 完了時点）**: 移行対象の getBackend() 直呼び store / 二重実装はすべて
§9.2 標準（repository interface + getBackend 委譲の単一実装 + ファクトリ/互換 API）へ
収斂済み。**新規エンティティは §9.2 の標準に従うこと**（シングルトン設定の例外も §9.2）。
残る非標準は reservation / notification の memory 唯一実装のみで、上記 7 のとおり
各永続化増分で扱う。
