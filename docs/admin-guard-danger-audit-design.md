# 管理画面 権限ガード・危険操作 UX・監査連携 設計 (issue #91)

`/admin` 配下の **権限ガード**（フロント表示制御 + API 最終認可）、**危険操作 UX**（二段確認・
理由入力・確認文言・影響範囲）、**監査連携**（既存 AuditAction での記録・機微値非保存）の
方針を定義する。本書は #91 の increment 1（基盤・適用例 1 箇所）の範囲。

関連: #80（テナント認可基盤 `authorization.ts`）, #85（route guard 雛形・IA）,
#117（実 actor 解決）, #92（危険操作の **視覚的な器** ui/）, #90（platform 各画面）。

## 1. 二層のガード（UX と最終認可を分離）

| 層 | 置き場所 | 役割 | 真実性 |
| -- | -------- | ---- | ------ |
| フロント（UX） | `src/components/admin/route-guard.ts` | 入口・画面・操作導線の **表示制御**（ボタン活性化、確認フロー表示） | 補助。隠すだけ |
| API（最終認可） | `src/lib/admin/guard.ts` → #80 純関数 | `requireActor` / `assert*` で **本物の 401/403** | 正。ここで必ず弾く |

**原則**: フロントで隠した操作でも、API 側が actor を実解決して `assertCanWrite` で 403 を返す。
判定本体は #80 の `canAccessTenant` / `canAccessSite`（純関数）に一元化し、本トラックは
これを呼ぶ薄いラッパだけを足す（認可ロジックの重複定義をしない）。

### 1.1 フロント: `route-guard.ts`（本トラックが拡張・単独編集者）

既存 `canEnterArea` / `isAreaAllowed` は不変。追加:

- `canEnterScreen(actor, screenKey)` / `isScreenAllowed` … 画面単位の表示可否。
  `AdminScreenKey`（`admin:dashboard` / `admin:security`(write) / `admin:audit`(read)）ごとに
  「入場に必要な操作種別（read/write）」を持つ。write 画面は `canWriteAnywhere` が前提。
- `canWriteAnywhere(actor)` … いずれかのテナント/サイトで書き込みロールを持つか（粗い UX 判定）。
- `canActOnTenant(actor, tenantId, op)` / `canActOnSite(actor, tenantId, siteId, op)` …
  #80 純関数への薄い委譲。ボタン活性化・確認フロー表示の細粒度判定に使う。

> `AdminScreenKey` は `navigation.ts`（**別トラックの単独編集者**）のルート定義とは独立。
> 重複・名前衝突を避けるため本トラックは navigation.ts を参照しない。

### 1.2 API: `src/lib/admin/guard.ts`（新規）

- `requireActor()` … `resolveAdminActor()` を呼び、null なら `AdminGuardError(401)`。唯一の I/O。
- `assertCanRead/Write(actor, tenantId)`、`assertCanRead/WriteSite(actor, tenantId, siteId)` …
  不可なら `AdminGuardError(403)` を throw（純粋）。
- `toGuardResponse(err)` … `AdminGuardError` を一貫した `{ error }` + 401/403 へ。
  **それ以外の例外は再 throw**（ガードが本物のバグを飲み込まない）。

route 側の定型:

```ts
try {
  const actor = await requireActor();
  assertCanWrite(actor, tenantId);
} catch (err) {
  return toGuardResponse(err);
}
```

## 2. 危険操作 UX（振る舞い）

危険操作（テナント停止 / 端末無効化 / token 再発行 / 連携・認証方式変更 / シークレット
ローテーション / メンテナンス開始 / フラグ強制変更 / 利用上限大幅変更 / データ削除）は、
実行前に確認フローを通す。**視覚的な器（DangerZone のレイアウト/トークン）は #92 の
`components/admin/ui/` が作る**ため、本トラックは挙動だけを担い、名前衝突を避けて
`DangerActionButton` / `confirm-flow`（≠ DangerZone / ConfirmDialog）とする。

### 2.1 `src/components/admin/danger/confirm-flow.ts`（純ロジック・React 非依存）

`ConfirmRequirement`（`requireImpactAck` / `requireReason` + `minReasonLength` /
`confirmationPhrase`）に対し `ConfirmInput` を `validateConfirm` で検証し、`canConfirm` が
全要件充足を返す。`normalizedReason` は監査へ渡す trim 済み理由を返す。node 環境の vitest で
網羅テスト可能（DOM 不要）。

### 2.2 `src/components/admin/danger/DangerActionButton.tsx`（薄い client wrapper）

`confirm-flow` を使い、二段確認（開く → 影響範囲 ack + 理由 + 確認文言 → 実行）を描画。
全要件充足時のみ `onConfirm({ reason })` を呼ぶ。スタイルは最小限（#92 の器に後で寄せる）。

## 3. 監査連携（既存 AuditAction を使用・機微値非保存）

`src/lib/admin/audit.ts` の `recordDangerAction(input)` が既存 `appendAdminAudit`
（`@/lib/mock-backend/reception-log-store`）へ委譲する。`reason` を metadata に含め、
`sanitizeAuditMetadata` で安全化する:

- `null` / `undefined` / object / array は捨てる（構造体・PII の混入防止）。
- 機微キー（`secret` / `password` / `pin` / `token` / `apikey` / `email` / `name` 等の部分一致）は
  値を `[redacted]` に置換（キーの存在だけ手掛かりとして残す）。
- boolean / number は文字列化。

> **log.ts（`AuditAction`）は読み取り参照のみで編集しない。** 既存 action で表現できない危険操作が
> あれば §5 に列挙し、オーケストレータが後で log.ts へ追加する。

監査に残す項目（#91 の想定。本 increment は action/target/reason/result 相当 + sanitize 済み
metadata を記録。tenantId/siteId/userId/role/ip/requestId 等の完全装備は次増分で actor/
リクエストコンテキストから補う）。

## 4. 適用例（increment 1 は 1 箇所のみ）

`src/app/api/admin/security/route.ts`（ガバナンス系・緊急停止を含む）に適用:

- GET: `requireActor` + `assertCanRead`。PUT: `requireActor` + `assertCanWrite`（viewer は 403）。
- PUT 成功時に `recordDangerAction('security.updated', …)`。PIN 値は metadata に残さない。

## 4.1 適用状況（increment 2: 旧 admin API ルートへの横展開）

inc1 の `requireActor` + `assertCanRead/Write` を、tenantId を URL/body で受け取らない
旧 admin ルートへ一貫適用した。これらは単一テナント運用の既定スコープで動くため、認可
スコープは `guard.defaultAdminTenantId()`（= `buildActorConfig().defaultTenantId`、未設定時
'default'）を使う（security route と同方針）。機能・レスポンス形は不変で、認可前段のみ追加。

| ルート | メソッド | ガード | 監査 |
| ------ | -------- | ------ | ---- |
| `departments/route.ts` | GET / POST | read / write | 既存 `department.created` 維持 |
| `departments/[id]/route.ts` | PATCH | write | 既存 `department.updated` 維持 |
| `departments/[id]/move/route.ts` | POST | write | 既存 `department.reordered` 維持 |
| `departments/reorder/route.ts` | POST | write | 既存 `department.reordered` 維持 |
| `departments/import/route.ts` | POST | write（preview も書込権を要求） | 既存 `department.created` 維持 |
| `staff/route.ts` | GET / POST | read / write | 既存 `staff.created` 維持 |
| `staff/[id]/route.ts` | PATCH | write | 既存 `staff.updated` 維持 |
| `staff/import/route.ts` | POST | write | 既存 `staff.created` 維持 |
| `kiosks/route.ts` | GET / POST | read / write | 既存 `kiosk.created` 維持 |
| `kiosks/[id]/revoke/route.ts` | POST | write（危険操作） | `recordDangerAction('kiosk.revoked')` |
| `kiosks/[id]/restore/route.ts` | POST | write | 既存 `kiosk.restored` 維持 |
| `assets/route.ts` | GET / POST | read / write | 既存 `asset.created` 維持 |
| `assets/[id]/route.ts` | PATCH | write | 既存 `asset.updated` 維持 |
| `motions/route.ts` | GET / PUT | read / write | 既存 `motion.updated` 維持 |
| `voice/route.ts` | GET / PUT | read / write | 既存 `voice.updated` 維持 |
| `receptions/route.ts` | GET | read | （監査出力なし） |
| `audit/route.ts` | GET | read | （監査出力なし） |
| `security/route.ts` | GET / PUT | read / write | inc1 で適用済（`recordDangerAction('security.updated')`） |

既適用の新ルート（`sites` / `devices` / `call-routes` / `reservations` / `integrations` /
`auth`）は本増分の対象外（既に各 route が #80 純関数で境界判定済み）。`platform` 配下は #90。

新規 AuditAction は追加していない（`log.ts` 不変）。端末失効は既存 `kiosk.revoked` を
`recordDangerAction` 経由で記録し、§5 の `device.disabled` 追加は不要と判断した。

検証: `src/app/api/admin/legacy-routes-guard.test.ts` で各ルートの 401 / viewer 書込 403 /
テナント越境 403 / viewer 読込 200 / tenant_admin 通過（≠401/403）を表テストで網羅。

他の各画面（フロント表示制御）への横展開は次増分（#92/#90/#82 と協調）。

## 5. 必要になりうる新 AuditAction（log.ts 編集は本トラックではしない）

increment 1 の適用範囲（security）は既存 `security.updated` で足りる。横展開で危険操作を
網羅する際に不足しうる action を列挙（オーケストレータが log.ts へ追加検討）:

- `tenant.suspended` / `tenant.resumed`（テナント停止/再開）
- `device.disabled`（受付端末無効化。既存 `kiosk.revoked` で代替可なら不要）
- `maintenance.started` / `maintenance.ended`（メンテナンスモード）
- `feature_flag.forced`（機能フラグ強制変更）
- `usage_limit.changed`（利用上限の大幅変更）
- `data.deleted`（汎用データ削除。対象種別は targetType で表現）
- `auth.reauthenticated` / `privilege.elevated`（再認証 / JIT 昇格。UI 方針は次増分）

## 6. increment 計画

- **increment 1（本 PR）**: 二層ガード基盤（route-guard 拡張 + lib/admin/guard）、危険操作
  確認フロー（confirm-flow + DangerActionButton）、監査ヘルパ（recordDangerAction +
  sanitize）、security route への適用例、純関数テーブルテスト。
- **increment 2 以降**: 各 Manager / platform 画面への横展開、TenantSwitcher と
  対象テナント明示、再認証 / JIT 昇格 UI、監査の完全コンテキスト（ip/requestId/before-after）、
  必要な新 AuditAction の log.ts 追加（§5）。
