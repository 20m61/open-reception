# 拠点・受付端末管理 UI 設計 (issue #87)

本書は #87（拠点 Site・受付端末 Device の管理 UI）を increment（増分）方式で実装する
ための設計。基盤は #80（マルチテナント: `docs/multitenant-design.md`）、IA は
#85（管理画面フロント基盤: `docs/admin-frontend-design.md`）に従う。

## 用語と階層

`docs/multitenant-design.md` の定義に準拠する。

- **Tenant**: 導入先企業・組織。境界の最上位。
- **Site**: Tenant 配下の受付設置拠点（本社受付 / 名古屋支店 など）。状態 `active|suspended`。
- **Device**: Site 配下の受付端末。既存 **Kiosk（#18）をテナント境界へ乗せた表現**。
  状態 `active|revoked`（既存 `Kiosk.enabled` に対応）。

関係: **Tenant 1—\* Site 1—\* Device**。

## increment 1（このトラックの範囲・実装済み）

Issue #87 の画面のうち、まず **Site 管理を主**とし、Site⇔Device の紐づけ表示まで実装する。
Device（端末）の作り替えは行わない（既存 kiosks 管理 #18 との二重管理を避ける）。

### 実装範囲

- ルート `/admin/sites`: 拠点一覧・作成・名称編集・有効/停止 UI（`SitesManager`）。
  - Tenant > Site > Device の階層が分かるよう、各拠点に **端末数 / オンライン端末数** を表示。
  - 端末トークン等の機密は表示しない（数の把握のみ）。
- API `/api/admin/sites`（GET 一覧 / POST 作成）・`/api/admin/sites/[id]`（GET / PATCH 更新）。
  - 既存 admin API 様式（`resolveAdminActor` → 401、`tenantId` スコープ、`ServiceResult`→HTTP）。
- サービス層 `src/lib/tenant/site-service.ts`（`SiteService`）。
  - 認可は #80 の純関数に委譲: 一覧/取得は `canAccessTenant`/`canAccessSite`(read)、
    名称・状態更新は `canAccessSite`(write)。
  - **新規サイト作成はテナント全体操作**のため `developer` / `tenant_admin` のみ許可
    （site_manager はサイト単位権限のため不可）。`canAccessTenant(write)` は site_manager でも
    真になりうるので、作成判定は専用の `canManageTenant` で「テナント全体スコープの write」を要求する。
- 永続化: in-memory（`MemoryTenantStore` / `src/lib/tenant/store.ts` の dev seed）。
  単一テナント互換のため `internal` テナント + `default-site`、既存 `kiosk-dev` 対応 Device を投入。
- ナビ: `src/components/admin/navigation.ts` の `operations` グループに `/admin/sites`（ラベル「拠点」）
  を追加（受付端末の前）。表示は TENANT_VIEWERS（viewer も閲覧可）、書込は API 側で再検証。
- 監査: `site.created` / `site.updated` を PII なし（id / name / status のみ）で記録。

### 認可マトリクス（inc1 実装）

| 操作 | developer | tenant_admin | site_manager | viewer |
| --- | --- | --- | --- | --- |
| 一覧/取得 | 全テナント | 自テナント全サイト | 権限のあるサイトのみ | 自テナント（閲覧のみ） |
| 作成 | 可 | 可 | **不可** | 不可 |
| 名称/状態更新 | 可 | 可 | 自サイトのみ | 不可 |

テナント越境（他テナントの Site/Device）は全ロールで拒否（developer 除く）。

## Device / Kiosk 統合方針

現状、端末は 2 系統で表現されている。

- 既存: `src/domain/kiosk/types.ts` の `Kiosk`（id/displayName/location/enabled）+
  `/admin/kiosks`・`KiosksManager`（#18）。token 登録・失効・設定取得まで実装済み。
- 新規: `src/domain/tenant/types.ts` の `Device`（tenantId/siteId 束縛つき・status）。#80 で型のみ定義。

**方針（確定）**: `Device`（テナント境界）を**正**とし、`Kiosk`（旧レジストリ #18）を
Device の一表現として段階的に寄せる（`docs/admin-frontend-design.md`: `devices` ← `/admin/kiosks`）。
`/admin/devices` を主管理画面とし、`/admin/kiosks` は旧フロー（kiosk token 登録・失効）互換の
ため当面残す。Kiosk と Device の対応づけは **id 一致**で行う（dev seed は既存 `kiosk-dev` に
対応する Device を 1 件持つ。新規端末は将来 Device 起点で発番する）。inc1 では作り替えず、
SiteService 内で `DeviceRepository.listDevices(tenantId, siteId)` を Site の紐づけ集計
（端末数・オンライン数）にのみ使う。

### inc3 で通した統合の一歩（実装済み）

二重管理（#18 Kiosk と #87 Device）を解消する非破壊な一歩として、**Kiosk heartbeat →
Device 稼働状態**の read 経路を 1 本通した。

- `GET /api/kiosk/heartbeat?kioskId=...`（#30）が、id 一致の Device の `lastSeenAt` を
  記録する（`DeviceService.recordHeartbeat`）。Kiosk 由来の活動が Device 側のオンライン状態へ
  反映され、`/admin/devices`・`/admin/sites` の稼働表示が実データになる
  （inc2 までは `lastSeenAt` が常に未設定で offline 固定だった）。
- 稼働判定は純関数 `deriveConnectivity` に集約し、`DeviceService`（一覧/詳細の `connectivity`）と
  `SiteService`（`onlineDeviceCount`）で共有。これにより inc1 の「オンライン数 = status 近似」を
  実 heartbeat 由来へ更新した。
- アダプタの安全性: heartbeat は**認可なし**（端末自身の定期確認パス。旧 kiosk heartbeat と同じ）、
  **監査なし**（高頻度・AuditAction を増やさない）、対応 Device が無ければ no-op
  （`{ matched: false }`）。Device 解決は `findDeviceById`（テナント文脈なし）で行い、更新は
  当該 1 件の `lastSeenAt` のみに限定してテナント/サイト境界を崩さない。`updatedAt`（管理メタ）は
  heartbeat では更新しない。記録は best-effort（失敗しても heartbeat 応答は止めない）。
- UI 重複の解消: `KiosksManager`（旧）上部に `/admin/devices` への導線を出し、見出しを
  「受付端末管理（旧）」に変更。token 値などの機密は引き続き露出しない。

**非破壊**: 旧 kiosk API・画面・受付フローは挙動を変えていない。Device 統合は heartbeat 応答に
影響しない補助経路で、Device 側へ片方向に反映するのみ（Kiosk の enabled/失効を Device へ自動
写像する逆方向や、新規端末の Device 化は次増分）。

### #261 で通した統合の二歩目: 実死活の統一表示（実装済み）

PR #260（observability の enabled→heartbeat 化）が二重レジストリ・surface 不整合・無境界
フルスキャン・分母希釈で撤回されたため、issue #261 で以下を**まとめて**設計・実装した。

- **レジストリ統一（AC1）**: 集計は kiosk / Device 両レジストリの **union（id 一致は Device
  優先）** で行い、どちらで登録された端末も漏れなく数える（純関数
  `summarizeFleet` / `src/domain/tenant/device-liveness.ts`）。加えて heartbeat 経路で
  **kiosk レジストリのみの端末を Device へ取り込む**（`DeviceService.adoptKiosk`。
  kiosk レジストリに実在する id 限定 → 無認可 heartbeat からの任意行作成にならない。
  enabled=false は revoked として写像し勝手に有効化しない。既定スコープ
  `resolveDefaultScope()` に紐づけ、監査なし=actor 不在のシステム由来同期）。これにより
  実機が生きている kiosk-only 端末は初回 heartbeat で Device（source-of-truth）に収束する。
- **surface 一致（AC2）**: admin ダッシュボード（#86）と platform オブザーバビリティ
  （#83/#90）は **同一の共有関数 `summarizeDeviceFleet`**（`src/lib/tenant/device-fleet.ts`）
  から端末死活を得る。surface ごとの独自集計は残さない。
- **境界化（AC3）**: `DeviceRepository.listAllDevices()`（テナント横断）は
  **device-fleet の TTL キャッシュ（30 秒）越しにのみ**呼ぶ契約。リクエスト毎の
  フルスキャンはしない（amortized O(1)）。台数が大きく増えた場合の恒久解
  （lastSeenAt GSI / 維持カウンタによる境界クエリ）は次増分。
- **分母是正（AC4）**: `FleetSummary.total` は稼働可能端末（online+offline）のみ。
  maintenance / disabled は別掲カウントとして UI に表示し、意図的な停止で
  オンライン率が希釈されないようにする。総合ステータスの critical 判定も
  「稼働可能端末が全台オフライン」に限定（全台保守中は critical にしない）。
- **false-offline 方針（課題 5）**: heartbeat は best-effort 書込（クライアント 30 秒間隔）。
  オンライン窓 5 分 = 10 周期分のため、単発の書込失敗は次周期が実質リトライとなり
  false-offline にならない。即時リトライは持たない（恒常障害では無意味で、窓が吸収する）。
- **失効の優先**: 旧レジストリで enabled=false にされた端末は、取り込み済み Device が
  active のまま heartbeat を受け続けていても union で **disabled を優先**する
  （逆方向同期が入るまでの穴塞ぎ。失効した端末を online に数えない）。

#### #261 時点の既知の制約（次増分で解消）

- **adoptKiosk の帰属**: 旧 kiosk レジストリはテナントレスのため、取り込み先は
  `resolveDefaultScope()`（internal/default-site）固定。マルチテナントで kiosk を
  運用する場合は誤帰属になる（現状は単一テナント互換運用のみ）。kiosk レジストリの
  テナント化 or Device 起点発番への置き換えで解消する。
- **admin ダッシュボードの集計範囲**: 従来の `listKiosks()`（グローバル）と同じく
  全体集計（単一テナント互換）。テナントスコープの死活集計は実 actor 解決（#85）後に
  `listDevices` ベースへ切り替える。
- **heartbeat の無認可性**: ~~登録済み kioskId を知る第三者が lastSeenAt を更新し「偽 online」を
  作れる~~ → **#284 inc1 で解消**。死活記録（lastSeenAt 更新・adoptKiosk）は、有効な kiosk
  セッション cookie を持ち **セッションの kioskId = クエリの kioskId** のリクエストに限定した。
  応答（active/pinRequired/authorized/serverTime）は従来互換のまま（セッション無し/不一致は
  記録だけスキップ）。エンドポイント自体は引き続き認可なし（#30。未エンロール端末の失効検知・
  緊急停止検知を担うため）。
- **キャッシュの鮮度**: 死活表示は per-instance TTL（30 秒）分の staleness を持つ
  （検知遅延は最大で窓 5 分 + TTL）。監視要件が厳しくなったら TTL 短縮 or 共有カウンタ化。

### #284 inc1: 逆方向同期と heartbeat セッション紐づけ（実装済み）

- **逆方向同期**: `/admin/kiosks` の作成・失効・再有効化の成功時に、`syncKioskToDevice`
  （`src/lib/kiosk/device-sync.ts`）→ `DeviceService.syncKioskState` で Device レジストリへ
  **即時写像**する（#261 までは次の heartbeat の adoptKiosk 待ちだった）。
  - 対応 Device が無ければ adoptKiosk と同型で作成。ただし **lastSeenAt は付けない**
    （管理操作は稼働証跡ではない。heartbeat 前の端末を偽 online にしない）。
  - 既存 Device は **status のみ** enabled から写像（enabled=false → revoked。#283 と同じ規則）。
    name/location は Device 側の編集を正とし上書きしない。status 切替時は保留中エンロール URL
    を無効化（`enrollmentTokenId` 消去 = `setEnabled` と同じ規則）。
  - **best-effort**: 写像失敗で kiosk 管理操作は壊さない（read 時 union が表示を担保し、
    次の heartbeat が収束させる）。監査は既存の kiosk.created / kiosk.revoked / kiosk.restored
    のまま（写像側で AuditAction を増やさず二重記録しない）。
- **heartbeat セッション紐づけ**: 上記「既知の制約」の解消を参照。

## increment 4 以降（次増分・残課題）

- ~~Kiosk の enabled/失効を Device へ写像する逆方向の同期~~（#261 で heartbeat 起点、#284 inc1 で
  /admin/kiosks の作成・setEnabled 時の即時写像を実装済み）。残りは新規端末を Device 起点で
  発番し、kiosk レジストリを Device の射影に置き換える本統合（クライアント `KIOSK_ID` の
  デバイス id 化を含む）。
- 端末台数スケール時の死活集計の境界クエリ化（lastSeenAt GSI or 維持カウンタ。現状は
  TTL キャッシュで走査頻度を抑制）。
- 旧 `/admin/kiosks` の段階的廃止（Device 画面に token 登録・失効フローを移設してから撤去）。
- 複数テナント所属時の **Tenant 切り替え UI** と現在操作中 Tenant/Site の明示（inc1 は `internal` 固定）。
- 実 actor 解決（Entra/Cognito クレーム → AdminUser/RoleAssignment 写像）。inc1 は管理セッション有効なら
  developer 相当の暫定 actor（`resolveAdminActor`、#97 と共通）。
- 永続化の DynamoDB シングルテーブル実装と `getBackend()` 接続（`docs/multitenant-design.md` §データ設計）。

## increment 2 / 3（実装済み・参考）

- inc2: `/admin/devices` ルートと受付端末一覧・詳細（heartbeat / 端末種別 / token 登録状態 /
  メンテナンス表示）。端末の有効/無効切り替え・**token 再発行（確認ダイアログ + 監査）**・
  オフライン最終接続時刻表示。
- inc3: Kiosk→Device 統合の一歩（上記「inc3 で通した統合の一歩」を参照）。オンライン状態を
  実 heartbeat（`Device.lastSeenAt`）由来へ更新（inc1/inc2 の status 近似を解消）。
- 複数テナント所属時の **Tenant 切り替え UI** と現在操作中 Tenant/Site の明示（inc1 は `internal` 固定）。
- 実 actor 解決（Entra/Cognito クレーム → AdminUser/RoleAssignment 写像）。inc1 は管理セッション有効なら
  developer 相当の暫定 actor（`resolveAdminActor`、#97 と共通）。
- 永続化の DynamoDB シングルテーブル実装と `getBackend()` 接続（`docs/multitenant-design.md` §データ設計）。

## 既知の制約

- actor が developer 固定のため、ロール別表示/認可の差は単体テスト（`site-service.test.ts`）で
  網羅し、画面上の差分は実 actor 解決後に効く。
- Site 詳細の個別ページ（`/admin/sites/[id]`）は inc1 では一覧内編集（インライン）に留め、
  詳細画面は次増分。
