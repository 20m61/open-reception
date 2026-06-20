# 退館チェックアウトと滞在状態管理 設計 (issue #102)

親 Epic: #96 / 関連: #97（予約）, #98（QR チェックイン）, #89（監査）。

本書は来訪者の **滞在状態（在館 / 退館）** モデルと、受付端末（kiosk）からの **退館チェックアウト**、
管理画面（admin）の **在館状況** を定義する。既存の予約・チェックイン基盤を **import 参照** で活用し、
他トラック（flow / signage）と疎結合に作る。

## 1. スコープ（increment 1）

| 領域 | 内容 |
| --- | --- |
| ドメイン | `src/domain/visit/**` — `StayStatus`・`VisitStay` 純モデルと状態遷移純関数 |
| 永続化 | `src/lib/visit/**` — `getBackend()` ベースの stay store・テナント/サイト境界・サービス層 |
| Kiosk 退館 | `/kiosk/checkout`（スタンドアロン）・`/api/kiosk/checkout/**`（kiosk セッション保護） |
| Admin 滞在状況 | `/admin/stay`（在館者一覧・状態表示）・`/api/admin/stay/**`（認可 + guard） |
| 監査 | 事前定義済み `visitor.checked_out` / `stay.updated` を使用（log.ts は触らない） |

非スコープ（後続増分・他 Issue）: 入館ゲート / スマートロック、顔認証退館、災害一斉通知、バッジ印刷、
予約 QR 退館の本配線（inc1 は受付番号 = stayId / 受付セッション参照で退館）、DynamoDB GSI 最適化。

## 2. 滞在状態モデル（`StayStatus`）

```text
present（在館中）── checkout ──▶ checked_out（退館済み）   ← 終端
       │
       └────────── cancel ────▶ cancelled（取消・誤入力訂正） ← 終端
```

- **present**: チェックイン完了。受付端末で受付したか、予約で来館した来訪者が在館している状態。
- **checked_out**: 退館チェックアウト済み。`checkedOutAt` と滞在時間（`durationMs`）が確定する。
- **cancelled**: 誤登録の取消。滞在実績として数えない（管理操作のみ）。

未退館（overstay）は **独立した永続状態ではなく派生表示** とする（`present` かつ
`checkedInAt` から一定時間経過）。永続状態を増やさず、判定は純関数 `isOverstay(stay, now, thresholdMs)` で行う。
これにより閾値変更が状態マイグレーションを伴わない。

二重退館防止: `checkout` は `present` からのみ許可（終端からの再退館は `invalid_state`）。

### `VisitStay`（永続モデル）

```ts
type VisitStay = {
  id: StayId;            // 受付番号として来訪者へ案内できる短命参照（PII ではない）
  tenantId; siteId;      // テナント/サイト境界（必須）
  status: StayStatus;
  checkedInAt: string;   // 在館起点（ISO）
  checkedOutAt?: string; // 退館時刻（checked_out 遷移時）
  durationMs?: number;   // 滞在時間（退館時に確定）
  // 来訪者識別は参照のみ。PII（氏名/会社名）は VisitStay に保存しない。
  reservationId?: string;   // 予約から来館した場合の参照（#97）
  receptionId?: string;     // 受付セッション参照（#16）
  retentionDays: number;    // 滞在情報の保存期間（運用方針の根拠）
  createdAt; updatedAt;
};
```

## 3. 来訪者識別とプライバシー

- `VisitStay` には **氏名・会社名・メモ等の PII を保存しない**。来訪者の識別は
  予約 token / 受付セッション（`receptionId`）/ 受付番号（`stayId`）の **参照** で行う。
- 退館導線は **受付番号（stayId）** または **在館一覧からの選択** を MVP とする
  （予約 QR 退館は token 解決の後続余地として設計のみ）。
- 退館後は受付端末・管理画面に個人情報を残さない。kiosk 退館完了画面は「退館を受け付けました」のみ表示し、
  一定時間で待機へ戻る（PII 非表示）。
- **監査ログに PII を残さない**: `visitor.checked_out` / `stay.updated` の metadata は
  `status` / `durationBucket`（滞在時間のバケット化）等の非 PII のみ。生の滞在時間や氏名は載せない。

## 4. 保存期間（retention）方針

- 滞在情報は業務証跡として有用だが PII 連結のリスクがあるため **必要最小限・期限付き** とする。
- `retentionDays`（既定 30 日）を `VisitStay` に持たせ、超過分は破棄する運用根拠とする
  （実際の TTL 削除配線は DynamoDB 増分で `getBackend().collection(..., { ttlSeconds })` を使う）。
- 災害時用途に拡張する場合は表示範囲と権限を別途整理する（本増分では扱わない）。

## 5. 認可・境界

- Admin API: 管理セッション必須（401）。`@/lib/admin/guard`（`requireActor` / `assertCanReadSite` /
  `assertCanWriteSite`）で tenantId/siteId 境界を判定（403）。フロントで隠した操作も API 側で 403。
- Kiosk API: kiosk セッション必須（cookie）。scope（tenant/site）は inc1 では dev 既定へ解決する暫定実装
  （#98 `resolveCheckinScope` と同方針。実 kiosk→site 写像は後続増分）。

## 6. increment 計画

- **inc1（本 PR）**: 純モデル + 遷移、stay store/service（getBackend）、kiosk 退館ルート/API、
  admin 在館一覧 read + 退館操作、監査配線、ユニットテスト。永続化は memory（dev/CI）/ dynamo は既存 backend 経由。
- **inc2 以降**: 予約 QR からの退館 token 解決、チェックイン完了時の VisitStay 自動生成配線（#98 confirm と接続）、
  在館サイネージ連携（#101）、滞在時間ダッシュボード、DynamoDB GSI と TTL 削除。

## 7. 意図するナビ配線（本 PR では navigation.ts を編集しない）

`src/components/admin/navigation.ts` の「日常運用」グループへ
`{ href: '/admin/stay', label: '在館状況' }` を追加するのが意図。nav 編集は所有外のため別 PR で行う。
本 PR の `/admin/stay` は直 URL で到達可能。
