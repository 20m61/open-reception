# 来訪予約・QR 発行 設計 (issue #97)

管理画面で来訪予約を作成し、来訪者へ送付できる QR を発行するための設計。
QR には氏名・会社名・担当者名などの個人情報を**直接埋め込まず**、サーバ側の予約を
参照する推測困難な `reservationToken` のみを載せる。

本書は increment（増分）方式で実装する。**今回の PR は increment 1（ドメイン + トークン +
リポジトリ interface + in-memory 実装 + API route + 監査 + テスト）まで**。QR の画像描画と
管理画面 UI、DynamoDB 実装は後続増分へ送る（末尾「increment 計画」参照）。

親 Issue: #96 / 関連: #80（テナント境界・認可）, #19/#22（監査ログ）, #105（ライセンス/プライバシー）。

---

## 1. 用語とドメインモデル

| 用語 | 意味 |
| --- | --- |
| VisitReservation | 来訪予約 1 件。来訪者・予定日時・呼び出し先・トークン・状態を持つ。 |
| reservationToken | 来訪者へ渡す参照トークン。QR の payload。推測困難なランダム値。 |
| usagePolicy | 利用制約。`single_use`（1 回利用）/ `same_day`（当日内利用）。 |

`VisitReservation`（`src/domain/reservation/types.ts`）の主なフィールド:

- 境界: `tenantId` / `siteId`（いずれも必須。#80 のブランド付き ID 型に乗せる）。
- 来訪者情報（PII）: `visitorName`（必須）/ `companyName`（任意）/ `note`（任意・最小限）。
- 予定: `visitAt`（ISO 8601）。`same_day` 判定の基準。
- 呼び出し先: `targetType`（`staff` / `department`）+ `targetId`。
- トークン: `token` / `usagePolicy` / `expiresAt`。
- 状態: `status`（後述）/ `usedAt`。
- 保存期間: `retentionDays`（PII 破棄の根拠。実配線は increment 2）。

### 状態遷移

```
active ──cancel──▶ cancelled        （来訪取消）
active ──revoke──▶ revoked          （手動失効 / 再発行で旧トークン無効化）
active ──expire──▶ expired          （有効期限切れ・参照時に反映）
active ──use─────▶ used             （受付完了・single_use の 1 回利用）
{expired, revoked} ──reissue──▶ active （QR 再発行で新トークン・新期限を付与）
```

- 終端は `used` / `expired` / `revoked` / `cancelled`。
- 編集（`applyEdit`）は `active` のみ。
- ライフサイクルはすべて純関数（`src/domain/reservation/lifecycle.ts`）にまとめ、
  副作用なしでテーブルテストに掛ける。永続化・監査・認可は service 層の責務。

---

## 2. トークンと QR payload 仕様

`src/domain/reservation/token.ts`。

- **生成**: Node `crypto.randomBytes(32)`（256bit）を base64url 化（43 文字・URL 安全）。
  個人情報は一切含めない純粋なランダム値。総当り・推測は計算上不可能。
- **一意性**: 256bit のため実運用で衝突しない（テストで 1 万件無衝突を確認）。
- **QR payload**: 画像に載せるのは token を参照する **URL のみ**。

  ```
  <baseUrl>/kiosk/checkin?rt=<token>
  ```

  - クエリ名 `rt`（reservation token）。`buildReservationCheckinUrl` / `parseReservationCheckinUrl`
    で生成・復元する。氏名・会社名・担当者名・予定などの PII は**載せない**。
- **利用制約**: `single_use` は受付完了で `used` へ。`same_day` は `visitAt` の当日内のみ
  受付可（`isUsableAt` 純関数で判定）。有効期限 `expiresAt` を過ぎたものは `expired`。

---

## 3. リポジトリ

`src/lib/reservation/repository.ts`（interface）+ `memory-repository.ts`（in-memory 実装）。

- すべての参照系は `tenantId` / `siteId` を必須にし、**他テナント/他サイトの予約を返さない**。
- `findByToken` も境界一致をマッチ後に検証して越境を防ぐ。
- Result/エラー様式は `src/lib/tenant/repository.ts`（#80）と `src/lib/data/`（永続化抽象）に
  揃える。返り値は防御的コピー（`structuredClone`）。
- 認可判定そのものはリポジトリではなく呼び出し側（service）が #80 の純関数で行う責務分離。
- 本番（DynamoDB シングルテーブル）実装と `getBackend()` 接続は increment 2。

---

## 4. サービス層と API

`src/lib/reservation/service.ts` がリポジトリ・ライフサイクル純関数・監査・認可を束ねる。
route（`src/app/api/admin/reservations/**`）は薄く保つ。

### 認可（#80 を再利用）

- 各操作で `canAccessSite(actor, tenantId, siteId, op)` を呼ぶ。read/write で判定。
- クライアントが送る `tenantId`/`siteId` をそのまま信用せず、actor の RoleAssignment を正とする。
- 失敗は `forbidden`（403）。`viewer` は読み取りのみ、他テナントは全操作不可。

### API 一覧（管理セッション必須）

| メソッド | パス | 用途 | 監査 |
| --- | --- | --- | --- |
| GET | `/api/admin/reservations?tenantId=&siteId=` | 予約一覧 | – |
| POST | `/api/admin/reservations` | 予約作成 + token 発行 | `reservation.created`, `reservation.token_issued` |
| GET | `/api/admin/reservations/:id?tenantId=&siteId=` | 単一取得 | – |
| PATCH | `/api/admin/reservations/:id` | 編集（active のみ） | `reservation.updated` |
| DELETE | `/api/admin/reservations/:id` | キャンセル | `reservation.cancelled` |
| POST | `/api/admin/reservations/:id/revoke` | 失効 | `reservation.revoked` |
| POST | `/api/admin/reservations/:id/token` | QR 再発行（旧トークン無効化） | `reservation.token_reissued` |

`tenantId`/`siteId` は GET/DELETE はクエリ、POST/PATCH はボディで受ける。

### 監査ログ（#19/#22）

既存の `appendAdminAudit`（`src/lib/mock-backend/reception-log-store.ts`）に追記し、
`AuditAction` を `reservation.*` で拡張（`src/domain/reception/log.ts`）。
**metadata に PII（氏名/会社名/メモ）を残さない**。残すのは予約 id・`targetType`・
`usagePolicy`・`status` のみ（テストで PII 非混入を検証）。

---

## 5. セキュリティ / プライバシー

- QR に**個人情報を直接含めない**。token 参照 URL のみ。
- token は **256bit のランダム値**（`crypto`）。推測・総当り不可。
- 原則 **1 回利用（single_use）または当日内利用（same_day）**に制限。`expiresAt` も併用。
- 予約 PII（氏名/会社名/メモ）は**必要最小限**。`retentionDays` で保存期間を持ち、
  超過分の破棄を increment 2 で配線（バッチ / TTL）。
- 監査ログに来訪者 PII を残さない（`docs/audit-logging.md` / `docs/security-checklist.md` V7/V8）。
- secret（管理セッション）は server-only。client へ流出させない。

---

## 6. ライセンス判断ログ — QR 画像描画ライブラリ（採用は increment 2）

`docs/license-privacy-guide.md` §2.1 / §1.3 に従い、QR **画像**描画ライブラリ採用の判断を
記録する。**increment 1 では新規 runtime 依存を追加しない**（token 発行と payload 仕様まで）。

候補の事前調査（採用は increment 2 で最終確認・別途 `npm view <pkg> license` 実行）:

```
- 対象: qrcode (node-qrcode) / 想定 v1.x
- ライセンス: MIT（SPDX: MIT）
- 用途: 管理画面で予約 token の checkin URL を QR 画像（PNG / SVG / DataURL）へ描画・DL
- 商用利用: 可（MIT、許容リスト内）
- 改変 / 再配布: 可（帰属表示）
- 帰属表示: 要（THIRD_PARTY_NOTICES.md に集約予定）
- 個人情報 / 音声 / 映像: 扱わない（描画対象は token URL のみ。PII を載せない）
- 特許: QR コード基本仕様はロイヤリティフリー。装飾 QR / フレーム QR は使わない
- 判断: 暫定採用候補（permissive・依存軽量）。最終採用は increment 2 で SPDX 再確認 +
        transitive ライセンス確認（npx license-checker）後に決定。
```

代替候補（同 MIT）: `qrcode-generator`（純 JS・依存なし）。読み取り（decode）は本スコープ外
（受付端末のカメラ読み取りは別 increment、映像はローカル処理・非保存の原則に従う）。

---

## 7. increment 計画

- **increment 1（本 PR）**: ドメイン型 / トークン生成 / QR payload 仕様 / ライフサイクル純関数 /
  リポジトリ interface + in-memory / 予約 CRUD・失効・再発行 API / 監査 / テスト / 本書。
  **UI・QR 画像・新規依存は追加しない。**
- **increment 2**: QR **画像**描画ライブラリ採用（上記判断ログを確定）+ 管理画面 UI（#85 の
  admin シェル整備後）+ 受付端末のチェックイン（token 検証 → `markUsed`）。
- **increment 3**: DynamoDB シングルテーブル実装 + `getBackend()` 接続 + 保存期間（retention）
  に基づく PII 破棄バッチ / TTL。
- **後続**: カレンダー連携・退館管理（本 Issue 非スコープ）。

---

## 関連ドキュメント

- テナント境界・認可: `docs/multitenant-design.md`（#80）
- 監査ログ・PII: `docs/audit-logging.md`
- ライセンス / プライバシー: `docs/license-privacy-guide.md`（#105）
- ソース構成: `src/ARCHITECTURE.md`
