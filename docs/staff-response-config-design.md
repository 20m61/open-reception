# 担当者応答アクション設定 設計 (issue #99)

担当者応答アクション（今行きます / 5分お待ちください / 別担当に回します / 本日は対応できません /
受付電話へ）の **管理画面からの設定** と、**応答実行経路への反映**の設計。

increment 1（#136）でドメイン定義・担当者 UI・受付端末ポーリング・respond エンドポイントを
実装済み。本ドキュメントは increment 2（管理画面での有効/無効・文言上書き）を対象とする。

## レイヤ構成

| レイヤ | モジュール | 責務 |
| --- | --- | --- |
| ドメイン（純関数） | `src/domain/reception/staff-response.ts` | 応答種別・既定文言・状態写像。設定（overrides）を適用した実効定義の解決（`resolveStaffResponseDefinition(s)` / `isStaffResponseEnabled` / `resolvedVisitorMessageFor`）。PII を扱わない。 |
| 永続化 | `src/lib/reception/staff-response-config/{types,repository,service,store,request}.ts` | テナント/サイト境界で「応答種別ごとの有効無効・文言上書き」を保持。`getBackend()` 委譲（memory / dynamodb）。認可は #80 `canAccessSite`。 |
| Admin API | `src/app/api/admin/staff-response/route.ts` | GET（一覧 read）/ PATCH（1 種別 update）。`resolveAdminActor` + service の `canAccessSite`。viewer 書込不可。 |
| Admin UI | `src/app/admin/staff-response/page.tsx`・`src/components/admin/StaffResponseManager.tsx` | 応答種別一覧・有効無効トグル・来訪者文言の編集/既定リセット。`components/admin/ui/**` プリミティブを利用。 |
| 応答実行経路 | `src/app/api/staff/calls/[id]/respond/route.ts`・`src/components/staff/StaffResponseActions.tsx` | 設定を尊重: 無効種別は担当者 UI に出さない・エンドポイントで 409、文言上書きを来訪者表示へ反映。 |

## データモデル

`StoredStaffResponseConfig`（tenant×site で 1 レコード、id = `${tenantId}#${siteId}`）:

```
{ id, tenantId, siteId, overrides: { [action]: { enabled?, messageOverride? } }, createdAt, updatedAt }
```

- **部分保持**: 上書きのある種別だけを `overrides` に持ち、未設定種別はドメイン既定へ
  フォールバックする。何も残らない種別はレコードから削除して既定へ戻す。
- **未保存サイト**: レコードが無ければ全種別が既定（有効・既定文言）で動く。シード不要。
- 文言上書きは最大 120 文字（短く保つ）。空文字 / null で上書き解除。

## 認可（#80）

- 取得（GET / `getView`）: `canAccessSite(read)`。viewer も読める。site_manager は担当サイトのみ。
- 更新（PATCH / `updateAction`）: `canAccessSite(write)`。viewer 不可・他テナント/他サイト越境拒否。
- 応答実行経路（respond）: kiosk/answer トークンで scope が確定するため admin 認可は適用せず、
  `service.resolveOverrides(tenant, site)` で overrides のみ解決する。

## 応答実行経路への反映

`POST /api/staff/calls/:id/respond`:

1. 応答トークンを検証（inc1 同様）。
2. 受付の `kioskId` → `resolveCheckinScope` で tenant/site を解決し、`resolveOverrides` を取得。
3. 無効化された種別なら `409 action_disabled`（フロントで隠した操作も API で拒否）。
4. `resolvedVisitorMessageFor` で実効文言を解決し、`recordStaffResponse(id, action, { messageOverride })`
   に渡す。未設定なら既定文言（inc1 挙動を維持）。

`GET /api/staff/calls/:id/respond?token=`（inc2 で追加）: 担当者 UI が無効種別をボタンに出さない
ために、有効/無効を含む種別メタ（種別・担当者ラベル・トーン・確認要否・有効）のみを返す。
来訪者文言・PII は返さない。`StaffResponseActions` は起動時にこれを取得し、失敗時は
ドメイン既定（`defaultEnabled`）にフォールバックする。

## 監査・プライバシー

- 本増分では設定変更用の `AuditAction` を**新設しない**（`src/domain/reception/log.ts` を触らない方針）。
  実際の担当者応答のみ既存 `reception.staff_responded` で残す（応答種別のみ・PII なし）。
- 設定値（文言）は管理者定義のテンプレートであり来訪者 PII を含まない。

## ナビゲーション（intended）

`/admin/staff-response` のナビ配線（`src/components/admin/navigation.ts`）は本増分では触らない。
intended 位置: 「受付フロー」(`/admin/reception-flows`) と同じ受付系グループの隣（呼び出し先設定
`/admin/call-routes` の近く）。配線はオーケストレータが後続で行う。

## 今後の増分（候補）

- kiosk→tenant/site の実解決（現状 `resolveCheckinScope` は dev scope 暫定）への追従。
- 設定変更の監査（専用 `AuditAction` 追加が許容されれば）。
- 確認文言・確認要否（requiresConfirmation）の管理画面からの上書き。
