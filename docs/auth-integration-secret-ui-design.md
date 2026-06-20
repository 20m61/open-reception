# 認証方式・外部連携・シークレット状態管理 UI 設計 (issue #93)

管理画面に「ログイン方式」「外部連携（Vonage 等）の接続状態」「シークレットの
登録状態」を確認・管理するエリアを追加するための設計。**機密値そのものは扱わず、
状態のみを扱う**ことを最上位の不変条件とする。

関連: #82（管理者運用コンソール）, #70（Entra 認証）, #80（マルチテナント認可）,
#91（危険操作 UX・監査連携）, #105（個人情報・ライセンス）。

---

## 1. 既存 `/admin/security` との関係（非破壊）

| 領域 | 担当 | 対象 |
| --- | --- | --- |
| `/admin/security`（既存 `SecurityManager`） | 受付端末アクセス制御 | PIN 必須・IP 許可リスト・緊急停止 |
| `/admin/integrations`（本 Issue・新規） | 認証/外部連携/シークレット状態 | ログイン方式・Vonage 連携・secret 状態 |

両者は責務が異なるため、`/admin/security` は**書き換えない**。本 Issue は新エリアを
**追加**するのみ。ドメイン型も `src/domain/security/` に既存
`types.ts`（端末アクセス制御）と分離した `integration-status.ts` を**追加**する。

---

## 2. セキュリティ方針（最優先）

- secret / private key / webhook secret の**平文を UI・API レスポンス・監査・ログに出さない**。
- 値の実在判定は**環境変数 / Secrets Manager 側**で行い、管理画面では
  「設定済み / 未設定 / 要更新」「最終更新日時」「最終更新者」だけを扱う。
- 状態モデル（`SecretStatus` / `SecretStatusRecord`）には **value プロパティを持たせない**
  （型レベルで漏えいを防ぐ）。テストで JSON シリアライズ結果に平文が現れないことを担保。
- 値の登録 API は本増分では提供しない。状態だけを動かす
  （`secret.updated` = 更新済みにマーク、`secret.cleared` = 要再設定にマーク）。
- 接続テストは**本番発信と明確に区別**し、inc1 ではネットワーク発信を行わない
  「設定検証（config check）」に留める。
- フロント bundle に機密を含めない（API レスポンスにも含めないため自然に担保）。

---

## 3. 認可（#80 委譲）

- 読み取り: `canAccessTenant(actor, tenantId, 'read')`（viewer 以上）。
- 書き込み（接続テスト・secret 状態変更）: `canAccessTenant(actor, tenantId, 'write')`
  （tenant_admin 以上。viewer は実行不可）。
- クライアントが送る `tenantId` はそのまま信用せず、actor の RoleAssignment で検証する。
- 他テナントの設定は表示・操作できない（route テストで cross-tenant 403 を担保）。
- actor の解決は中央モジュール `@/lib/auth/actor` の `resolveAdminActor` を使用。

---

## 4. データモデル（`src/domain/security/integration-status.ts`）

純関数 + 型のみ。永続化・env 読み出し・HTTP は持たない。

- `SecretStatus` … key / presence(`configured|missing`) / health(`ok|needs_rotation|unknown`)
  / updatedAt / updatedBy。**value なし**。
- `IntegrationStatus` … id / label / configured / enabled / lastResult(`untested|success|failure`)
  / lastSuccessAt / lastFailureAt / lastErrorSummary（機密を含めない短文）。
- `AuthMethodStatus` … id / label / enabled / issues（機密を含めない設定エラー要約）。
- 純関数: `deriveSecretPresence`（値→bool だけ。値は返さない）, `composeSecretStatus`,
  `applyConnectionResult`。

永続化（`src/lib/security/integration-status-store.ts`）は data backend の singleton
`integration_status` に**状態メタデータのみ**保存する。既存 `security` singleton とは別キー。

---

## 5. API（`src/app/api/admin/integrations/**`）

| メソッド・パス | 操作 | 認可 | 監査 |
| --- | --- | --- | --- |
| `GET /api/admin/integrations?tenantId=` | 認証方式・連携・secret 状態の取得 | read | — |
| `POST /api/admin/integrations/test` | 接続テスト（設定検証） | write | `integration.tested` |
| `PUT /api/admin/integrations/secrets` | secret を「更新済み」にマーク | write | `secret.updated` |
| `DELETE /api/admin/integrations/secrets` | secret を「要更新」にマーク | write | `secret.cleared` |

監査アクションは事前定義済みの語彙（`src/domain/reception/log.ts`）を参照するのみ。
metadata には key・操作結果・actor ラベル（ロール名。PII でない）だけを残す。

---

## 6. UI（`src/components/admin/integrations/**`）

- `IntegrationsManager` … 状態取得 → 3 セクション（ログイン方式 / 外部連携 / シークレット状態）
  を表示。接続テスト導線と secret 状態操作（Danger 確認つき）。
- `SecretStatusField` … secret の状態のみを描画する再利用部品。props に value を持たない。
- `/admin/secrets` は独立ルートを作らず、本画面のセクションへ統合する（Issue の選択肢のうち
  「外部連携詳細内に統合」を採用）。

---

## 7. ナビ配線（オーケストレータが後で実施）

`src/components/admin/navigation.ts` は本トラックでは**触らない**。意図する配線:

- `ADMIN_NAV` の `governance`（ガバナンス）グループに
  `{ href: '/admin/integrations', label: '外部連携', roles: TENANT_ADMINS }` を追加。
  既存 `/admin/security`・`/admin/audit` と同グループに並べる。

---

## 8. increment 計画

- **inc1（本 PR）**: 状態モデル + 状態取得 API + 接続テスト（設定検証） + secret 状態
  操作 + UI + 認可境界/平文非露出/状態遷移のユニットテスト。Vonage 連携のみ。
- **inc2（次増分）**: 実 Vonage への接続確認・テスト発信（実認証情報/実機が要るため #65
  にスタック）。OAuth provider 連携の追加。ローテーション期限の自動検知。
- **inc3**: ユーザー招待・ロール割り当て・最終ログイン/失敗の表示（#82/#70 と連携）。
