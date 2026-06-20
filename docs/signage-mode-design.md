# 待機中サイネージモード設計 (issue #101)

受付端末（kiosk）が待機状態のとき、時計・案内文・画像・スライドショーなどを巡回表示する
サイネージモードの設計。Epic は #96。関連: 来訪者検知 #79（`src/domain/presence` /
`src/lib/presence`）。

## 目的とスコープ

無人受付は受付開始前の待機時間が冷たく見えやすい。待機時間を会社紹介・受付方法・フロア案内・
緊急連絡先などの案内体験に変える。タップ/操作で受付へ復帰し、操作なし一定時間でサイネージへ
戻る（自動復帰の配線は次増分）。

### increment 1（本増分・自己完結）

- サイネージ設定モデル + 巡回ロジック（純モデル）。
- getBackend ベースの設定リポジトリ（テナント/サイト境界）。
- Admin 設定 UI / API（CRUD・認可・監査）。
- Kiosk スタンドアロン待機ルート `/kiosk/signage`（KioskFlow へは組み込まない）。
- 監査は事前定義済み `signage.updated` を使う。

### 次増分（本増分では扱わない）

- presence 検知（#79）との連携配線（来訪検知で `/kiosk` へ自動遷移、無操作で自動サイネージ復帰）。
- 緊急停止 / 通信断 / 端末失効の優先表示（`/api/kiosk/config` の `active` と統合）。
- VRM アバターの軽い挨拶、動画コンテンツ、BGM。
- iPad 実機での GPU/CPU 負荷計測と最適化（#65 にスタック）。

## ドメインモデル

`src/domain/signage/types.ts`

- `SignageContentType` = `clock | message | image | slides`。
- `SignageItem`: 種別・有効/無効・種別ごとのフィールド（message / imageUrl / slideUrls）・
  個別表示秒数（任意）。
- `SignageConfig`: サイト単位 1 つ。`enabled` / `defaultIntervalSeconds` / `items[]`（配列順序が
  巡回順序）。
- `SIGNAGE_LIMITS`: 間隔 3〜600 秒、項目 30、スライド 50、本文 2000 文字。
- `defaultSignageConfig`: 未保存時の安全な既定（無効・項目なし）。

`src/domain/signage/rotation.ts`（純関数）

- `validateItem` / `validateConfig`: 保存前検証。`enabled` の設定は再生可能項目を 1 つ以上要求し、
  待機画面が空にならないことを保証する。画像/スライド URL は `http(s)` を強制（`isHttpUrl`）。
- `playableItems` / `isPlayable`: 有効かつ内容が揃った項目に絞る（並び順保持）。
- `itemDuration`: 個別秒数 > 既定間隔の優先で解決。
- `nextIndex`: 末尾で先頭へループ。実タイマは持たず、呼び出し側が時間を進める。

## 永続化

`src/lib/signage/**`

- `SignageRepository`（interface）。実装は `BackendSignageRepository`（getBackend の Singleton を
  `signage:<tenantId>:<siteId>` キーで分離）。memory（dev/test/CI）/ dynamodb（本番）の切替は
  getBackend 側（docs/persistence-design.md）。
- `MemorySignageRepository`: 単体テスト用。
- `SignageService`: リポジトリ + 検証 + 認可（#80 `canAccessSite`）+ 監査を束ねる薄い層。
- テナント/サイト境界は全参照で必須。越境データは返さない（防御的に二重チェック）。

## API

- `GET /api/admin/signage?tenantId=&siteId=` — 設定取得（未保存は既定）。
- `PUT /api/admin/signage` — 検証して保存。検証エラーはフィールド別に 400 で返す。
  - 認証: 管理セッション必須（401）。認可: `canAccessSite`（viewer 書込不可・越境 403）。
  - 監査: `signage.updated`（PII なし。`enabled` / `itemCount` / `defaultIntervalSeconds` のみ）。
- `GET /api/kiosk/signage?tenantId=&siteId=` — 端末向け。再生可能項目のみを最小形（id を伏せる）
  で返す。設定なし/無効なら `enabled=false` + 空配列。

## UI

- Admin: `src/app/admin/signage/page.tsx` + `src/components/admin/SignageManager.tsx`
  （`src/components/admin/ui/**` の Section / Field / FormRow / Button を活用）。項目の追加・削除・
  種別変更・秒数・有効/無効を編集し、保存時にサーバ検証エラーをフィールド別表示する。
- Kiosk: `src/app/kiosk/signage/page.tsx` + `src/components/kiosk/signage/**`
  （`SignageDisplay` / `SignageItemView` / `SignageClock`）。各項目の秒数で巡回し、
  タップ/クリック/キー操作で `/kiosk` へ遷移＝受付復帰。受付開始の導線は常に大きく表示する。

## presence 連携（次増分の配線方針・本増分は import 参照のみ）

- 検知状態は `src/domain/presence/state.ts`（`PresenceState`: IDLE→CANDIDATE→ATTRACT→ACTIVE→
  COOLDOWN）の純関数が持つ。
- 次増分で、`ACTIVE` 遷移（来訪検知）を受けて `SignageDisplay` が `/kiosk` へ自動遷移し、
  受付終了・無操作タイムアウトで再びサイネージへ戻る配線を追加する。
- 本増分では明示操作（タップ/クリック/キー）による復帰のみを実装する。

## セキュリティ / プライバシー

- 待機中に来訪者の PII を表示しない。表示内容は運用者が用意する静的コンテンツのみ。
- 監査ログに PII を残さない（`signage.updated` の metadata は数値・真偽のみ）。
- 画像/スライドの外部 URL は `http(s)` の絶対 URL に限定（信頼できるオリジンの運用は #105 / 端末
  認可と合わせて担保）。緊急停止時の優先表示は次増分。

## ライセンス / 権利注意（#105）

- サイネージ用の画像・動画・BGM・アバター素材は、商用利用 / 改変 / 再配布の可否を確認した
  ものだけを設定する（#105 ライセンス・プライバシーチェックに従う）。
- 競合サービスの待機画面デザイン・文言・画像・コードを流用しない。機能思想のみ参考にする。
- 本リポジトリにバンドルするサンプル/プレースホルダは自前のもののみとし、外部素材は同梱しない。
