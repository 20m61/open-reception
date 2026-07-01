# 呼び出し先・通知ルート設定 設計 (issue #88)

受付後に「誰へ・どの順番で・どの手段で」通知するかを、テナント/サイト境界の中で
管理者が設定できるようにする。本書は increment 1 のスコープと、設定ドメインの構造、
認可・監査方針、次増分計画をまとめる。

関連: #80（テナント/サイト境界・認可純関数）, #82（運用コンソール）, #85（管理 IA）,
#99（担当者応答）。通知 *実行* サブシステム（`src/server/notification/**`）とは責務を分離する。

## 責務分離

- 本トラック（`src/lib/notification/**`）= **設定（ルート定義）**。CRUD・認可・監査。
- 既存 `src/server/notification/**` = **通知の実行**（Polly 音声化 / Vonage 接続）。
  実行サブシステムは将来この設定を解決して `NotificationRequest` を組み立てる。
  本増分では両者を結線しない（設定の土台のみ）。
- **schema/型・検証の定義元は `src/domain/notification/**` の 1 箇所**（#275 で集約。
  純粋な型+検証のみ、フレームワーク/AWS SDK import 禁止）:
  - `call-route.ts` / `call-route-validation.ts` … 設定ドメイン（本書のデータモデル）。
    `src/lib/notification/{types,validation}.ts` は既存 import パス互換の再輸出。
  - `notify.ts` / `notify-validation.ts` … `/notify` の共有 wire schema。
    `src/server/notification/{types,validation}.ts` は再輸出（worker 内部専用型
    SiteConfig/VoiceSettings/AudioRef は server 側に残置）。
  - 両側が同一定義を参照することは
    `src/domain/notification/schema-consistency.test.ts` が参照同一性で担保する。

## データモデル

issue #88 のデータモデル方針に従い、固定電話番号に閉じず通知チャネルを抽象化する。

```
CallRoute (id, tenantId, siteId, name, enabled, timestamps)
  └ CallTargetGroup (label)            … フォールバック順をまとめる単位
      └ CallTarget (label, channel, value, priority)
          channel: phone | email | slack | teams | webpush （将来拡張）
```

inc1 では Group/Target を `CallRoute` 内の値として保持する（別エンティティ化は次増分）。
`CallTarget.value`（電話番号・メール等）は機微情報として扱う。

## 認可（#80 純関数に委譲）

- 一覧/取得: `canAccessSite(actor, tenantId, siteId, 'read')`。
  site_manager は担当サイトのルートのみ見える。
- 作成/更新/削除: `canAccessSite(..., 'write')`。viewer は書込不可、他テナント越境は拒否。
- actor は `@/lib/auth/actor` の `resolveAdminActor()` で実ロール解決（route 層で実施）。
- テナント越境の取得/更新/削除は、リポジトリの tenantId フィルタにより `not_found` で隔離する
  （id を知っていても他テナントの存在を露見させない）。

## 監査

- 設定変更を事前定義済みアクション `call_route.created` / `call_route.updated` /
  `call_route.deleted`（`src/domain/reception/log.ts`）で `appendAdminAudit` に記録する。
- **機微値（`CallTarget.value`）は監査に残さない**。残すのは
  `name` / `siteId` / `enabled` / `groupCount` / `targetCount` のみ。

## API

| Method | Path | 説明 |
| --- | --- | --- |
| GET | `/api/admin/call-routes?tenantId=&siteId=` | ルート一覧（siteId 任意で絞り込み） |
| POST | `/api/admin/call-routes` | ルート作成（tenantId/siteId/name + groups 任意） |
| GET | `/api/admin/call-routes/:id?tenantId=` | 単一ルート取得 |
| PATCH | `/api/admin/call-routes/:id` | name / groups / enabled の更新 |
| DELETE | `/api/admin/call-routes/:id?tenantId=` | ルート削除（204） |

未認証は 401、認可違反は 403、境界外/不存在は 404、入力不正は 400。

## UI（`/admin/call-routes`）

`CallRoutesManager` がルート一覧・作成・名称編集・有効/無効・削除を提供する。
非エンジニア向けに、ルートごとにグループ → 呼び出し先（チャネル + 優先順）を
順序つきで可視化する。通知先 value は一覧で伏せ字表示。削除は確認ダイアログを挟む。

## increment 計画

- **inc1（本増分）**: ドメイン型 / repository interface + in-memory 実装 / service（CRUD・認可・監査） /
  REST API / 一覧・作成・名称編集・有効無効・削除 UI / ルート可視化 / ユニットテスト。
- **inc2（次増分）**: グループ/呼び出し先の編集フォーム、通知可能時間帯、メッセージ設定
  （通常/不在/時間外/エラー、音声合成テキスト）、テスト通知/テスト発信導線（#99 と接続）、
  権限に応じた電話番号マスク強化、tenant/site 切り替え UI。
- **inc3 以降**: DynamoDB 実装と `getBackend()` 配線、通知実行サブシステムとの結線
  （ルート解決 → `NotificationRequest`）、最終利用日時/直近成功失敗の集計表示。

## nav 配線（オーケストレータ対応）

`/admin/call-routes`「呼び出しルート」を `src/components/admin/navigation.ts` の
`operations`（日常運用）グループへ追加する想定（`/admin/kiosks` の近傍）。
表示ロールは `TENANT_VIEWERS`（viewer は閲覧のみ、書込は API 側で拒否）。
本トラックでは shared nav を編集せず、配線はオーケストレータがまとめて行う。
