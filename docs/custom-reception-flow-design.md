# カスタム受付フロー設計 (issue #100)

来訪目的ごとに、受付端末で表示する「ステップの並び」と「来訪者情報入力フォーム」を切り替えられる
ようにする。本書は increment 1 の設計と、後続増分・既存（KioskFlow）への統合方針を記す。

商用 SaaS / OSS の UI・文言・画面構成・コードは流用せず、機能思想のみを参考にした自前実装である
（Epic #96 / #105 のライセンス・権利方針に準拠）。

## スコープ

### increment 1（本 PR）

- ドメイン純モデル: `src/domain/reception/custom-flow.ts`
  - ステップ種別（`purpose` / `target` / `visitorInfo` / `confirm` / `call`）・入力フィールド
    （`text` / `textarea` / `select` / `checkbox`）・順序・必須/任意・バリデーションを純関数で表す。
  - `confirm` / `call` は必須ステップ。`confirm` は `call` より前という順序整合を強制する。
  - 既定フロー（通常受付）と表示整列ヘルパ（`sortFlowsForDisplay` / `enabledFlowsForDisplay`）。
- 設定永続化: `src/lib/reception/flow-config/**`
  - `getBackend()`（`DATA_BACKEND=memory|dynamodb`）の `Collection` に委譲する
    `DataBackedReceptionFlowRepository`（テナント/サイト境界フィルタ）。テスト用 in-memory 実装も提供。
  - 同一サイト内 `purposeKey` の一意制約は走査で担保（小規模・GSI 最適化は将来増分）。
- Admin 設定 UI / API
  - API: `src/app/api/admin/reception-flows/**`（CRUD）。`resolveAdminActor` + #80 認可
    （`canAccessSite`）。read は site_manager 担当サイトのみ、write は viewer 不可・越境不可。
  - UI: `src/app/admin/reception-flows/page.tsx` + `src/components/admin/ReceptionFlowsManager.tsx`
    （一覧・作成・名称編集・有効/無効・削除。ステップ/入力項目の可視化）。
- Kiosk 用
  - API: `src/app/api/kiosk/flow/route.ts`（kiosk セッションのサイトで「有効な」フローを表示順に返す）。
  - レンダラ: `src/components/kiosk/custom-flow/**`（**スタンドアロン**。`KioskFlow.tsx` には未組み込み）。
- 監査: 事前定義済み `reception_flow.created/updated/deleted`。PII（来訪者入力値）は残さず、
  `purposeKey` / `displayName` / `siteId` / `enabled` / ステップ数 / フィールド数のみ記録する。

### 後続増分（本 PR 外）

- KioskFlow への統合配線（下記「統合方針」）。
- 入力項目・ステップ並びの編集 UI（inc1 は API で可能、画面は名称/有効無効に絞る）。
- 通知ルート（#88）との目的別接続、受付履歴への来訪目的記録（受付セッションへの purpose 反映）。
- DynamoDB キー設計の最適化（PK/SK・GSI）。e2e smoke。

## データモデル

```
StoredReceptionFlow {
  id, tenantId, siteId,           // 境界・採番
  purposeKey, displayName, description?, order, enabled,
  steps: FlowStepKind[],          // 表示するステップの並び（confirm→call 整合）
  fields: FlowField[],            // visitorInfo ステップの入力項目
  completionMessage?,             // 呼び出し完了後の案内文
  createdAt, updatedAt,
}
FlowField { key, label, type: text|textarea|select|checkbox, required, options? }
```

フロー定義はテンプレートであり、来訪者の個人情報を含まない。入力された値は受付セッション側で
最小限に扱う（`src/domain/reception/session.ts`）。

## 認可・境界

- 認可判定は #80 純関数（`canAccessSite`）に委譲し、副作用（永続化・監査）は service 層に閉じる。
- リポジトリは tenantId/siteId フィルタで他テナントのデータを返さない（越境隔離）。
- kiosk 取得（`/api/kiosk/flow`）は kiosk セッションで scope が確定するため admin RoleAssignment
  認可は適用せず、当該サイトの有効フローのみ返す。

## KioskFlow への統合方針（intended・後段でオーケストレータが配線）

`src/components/kiosk/KioskFlow.tsx` は本 PR では**一切変更しない**。統合時の想定:

1. 端末起動時に `GET /api/kiosk/flow` を呼び、有効フロー一覧を保持する。
2. 状態 `selectingPurpose` で `custom-flow/PurposeSelector` を描画し、選択された `KioskFlow` を保持。
   既存の `SELECT_PURPOSE` イベントを発火する（`ReceptionPurposeId` への写像が必要なら purposeKey →
   既存 ID のマッピング、もしくは purposeKey 自体を session.purpose に拡張）。
3. 状態 `inputVisitorInfo` で、選択フローに `visitorInfo` ステップがあれば
   `custom-flow/VisitorInfoForm` を選択フローの `fields` で描画する。送信値（`FlowFieldValues`）を
   既存 `VisitorInfo`（name/company/note）へ写し、`SUBMIT_VISITOR_INFO` を発火する。
   `visitorInfo` を含まないフローは入力を省略してそのまま `confirm` へ進める。
4. `confirm` / `call` は既存の状態機械（`src/domain/reception/state.ts`）にそのまま委ねる。
5. `completionMessage` は `completed` 状態の案内に重ねて表示する。
6. 目的選択間違い・入力が長すぎる場合は、フォームの「戻る」で目的選択へ戻し、通常受付フロー
   （既定フロー）へ切り替えられるようにする（issue #100 UX 方針）。

スタンドアロンの `CustomFlowRenderer` は上記 2〜3 を 1 部品に閉じた参照実装であり、統合時は
状態機械側のイベントに合わせて分解利用してよい。

## nav 配線（intended）

`src/components/admin/navigation.ts` は本 PR では変更しない（他トラックとの競合回避）。
統合時に「受付フロー」項目（`/admin/reception-flows`、ラベル例: 受付フロー）を呼び出しルートの
近くへ追加する想定。

## seed（dev/test/CI のみ）

memory backend に通常来訪 / 面接 / 宅配の 3 目的を、管理既定テナント（`internal` / `default-site`）と
受付端末 scope（`dev-tenant` / `dev-site`）へ投入する。dynamodb では seed は無視され実データを正とする。
