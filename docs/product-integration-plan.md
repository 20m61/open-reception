# 統合再設計プログラム 移行台帳 (issue #425 / epic #418)

キオスク・管理画面・プラットフォームを 1 つの循環（提供 → 構成 → プレビュー → 公開 → 実行 →
計測 → 評価）へ統合する #419〜#424 を、**再び局所最適化させないための単一台帳**。

本書の役割は「決めたことを 1 か所に置く」ことであって、設計そのものではない。各 Wave の設計は
Issue と ADR が正で、本書はそこへの索引と移行状態を持つ。実装の着手順・並列トラックは
`docs/loop-queue.md`、ループ運用手順は `docs/loop-workflow.md` を正とする（重複記述しない）。

> **記入規約**: 状態は `未着手` / `進行中` / `新経路稼働` / `旧経路撤去済` の 4 値。
> 「新経路稼働」と「旧経路撤去済」を分けるのは、互換アダプタを残したまま完了扱いにして
> 二重経路を放置する失敗を防ぐため。撤去条件を書かない行は作らない。

---

## 1. Wave の開始条件・終了条件・占有ファイル

`#418` コメントで確定した着手順に対応する。**占有ファイル**は並行トラックが同時に触ってはならない
領域（`docs/loop-workflow.md` の並列オーケストレーション規約の入力）。

| Wave | Issue | 開始条件 | 終了条件 | 占有ファイル |
| --- | --- | --- | --- | --- |
| 0 Baseline | #425 | なし（最初） | 本書が存在し、§3〜§11 の台帳が現物と一致 / baseline 資産が §2 で固定 | `docs/product-integration-plan.md`・`docs/adr/README.md` |
| 1 Foundation | #419 | Wave 0 完了 | `ProductContext` / `EffectiveKioskConfiguration` / resolver 契約 + 契約テストが main に在る → その後 `/api/configuration/effective` と互換アダプタ | `src/domain/product-context/**`・`src/app/api/configuration/**` |
| 2 Lifecycle | #420 | #419 の型・resolver が main | draft/published の版管理と last-known-good / rollback が動く | `src/domain/experience-version/**`・`src/lib/reception/flow-config/**` |
| 3 Admin IA | #421 | #419 / #420 | 1 拠点・1 端末・1 受付体験の編集導線が業務対象中心に統合 | `src/app/admin/**`・`src/components/admin/**` |
| 4 Kiosk UX | #422 | #419（推奨は #421 の後） | `KioskFlow.tsx` 分割 + 新シェルが feature flag 配下で選択可能 | `src/components/kiosk/**` |
| 5 Cross-surface | #423 | #419 / #420 / #421 | platform → admin → preview → kiosk の横断 E2E が green | `tests/e2e/**` |
| 6 AI Loop | #424 | 随時（初回適用は #419） | 各 Wave の Issue/PR/測定に手順が適用されている | `docs/ai-development-loop.md`（#426） |

**並行可否**: Wave 0 と Wave 1 は `docs/` と `src/domain/` で領域が独立するため並行可。
Wave 3 と Wave 4 は admin / kiosk でファイルが分かれるが、`EffectiveKioskConfiguration` の
形を同時に変えると衝突するため、**型変更を伴う場合は直列**にする。

---

## 2. Baseline 固定（Wave 0）

「変えていないものが変わっていないこと」を後から言えるようにするための参照点。基準コミットは
本書を追加した PR のマージコミット。

| 種別 | 現物 | 備考 |
| --- | --- | --- |
| VRT（キオスク待機） | `tests/e2e/kiosk-screenshot.spec.ts-snapshots/`（iPad 縦横・大型ディスプレイ、darwin/linux 各 1） | #361 で決定化済み |
| VRT + axe（主要 5 画面） | `tests/e2e/kiosk-vrt-a11y.spec.ts-snapshots/`（target / purpose / confirm / qr-intro / out-of-hours、linux） | critical / serious ゼロを併せて検査（第 14・15 wave） |
| E2E | `tests/e2e/*.spec.ts` 40 本。横断シナリオは `journey-reception.spec.ts` | #423 はこれを土台に 10 ステップ横断へ拡張する |
| 依存関係マップ | 本書 §3（route）・§4（API） | 生成物ではなく手記入。変更時は同じ PR で更新する |
| KPI | `docs/reception-experience-kpi.md` の定義（分子/分母） | 実測値は §11 を参照（**dev に受付実績が無いため未取得**） |

> **本コンテナの制約**: ブラウザ E2E はこの実行環境では起動できない（第 15 wave で exit 144 を確認）。
> baseline の**再取得**は e2e を実行できる環境で行う。Wave 0 が固定するのは「どのファイルを
> baseline とみなすか」であって、この環境での再撮影ではない。

---

## 3. Route migration matrix

現行の画面ルート（`src/app/**/page.tsx`、47 本）と、#421（管理 IA 再編）・#423（横断導線）での
扱い。**移行先 IA は #421 で確定する**ため、現時点では「統合候補」までを記録する。

### 3.1 `/kiosk` 系（#422 の対象）

| 現行ルート | 役割 | 移行方針 | 状態 |
| --- | --- | --- | --- |
| `/kiosk` | 受付本体（`KioskFlow.tsx` 2900 行超） | #422 で ExperienceShell へ分割。feature flag で新旧切替 | 未着手 |
| `/kiosk/signage` | 待機サイネージ | 新シェルの待機状態へ統合（別ルート維持の是非は #422 で裁定） | 未着手 |
| `/kiosk/checkout` | 退館 | 現状維持 | 未着手 |
| `/kiosk/enroll` | 端末エンロール（`?token=`） | 現状維持（`ProductContext` の権威入力元） | 未着手 |
| `/demo/[token]` | 未認証のデモ共有ページ（#363 Inc3） | 現状維持。#420 の公開モデルとの重複概念は §5 参照 | 未着手 |

### 3.2 `/admin` 系（#421 の対象）

技術モジュール別の 30 画面。#421 は「業務対象中心」への再編なので、以下の**統合候補**を
#421 の入力とする。統合先の名前は未確定（`—` は #421 で決める）。

| 現行ルート群 | 統合候補（業務対象） | 状態 |
| --- | --- | --- |
| `/admin/branding`・`/admin/assets`・`/admin/motions`・`/admin/voice`・`/admin/languages`・`/admin/signage` | 受付体験（1 つの体験エディタの各タブ） | 未着手 |
| `/admin/reception-flows`・`/admin/ai-guidance`・`/admin/staff-response`・`/admin/operating-hours` | 受付体験（振る舞い） | 未着手 |
| `/admin/departments`・`/admin/staff` | 組織・接続先（#373 / #374） | 未着手 |
| `/admin/call-routes`・`/admin/call-routing`・`/admin/integrations` | 取次（ルーティング + 接続先設定） | 未着手（**同名 2 画面は §5 の重複概念**） |
| `/admin/kiosks`・`/admin/devices`・`/admin/sites` | 拠点・端末 | 未着手 |
| `/admin/receptions`・`/admin/reservations`・`/admin/stay`・`/admin/usage`・`/admin/costs`・`/admin/audit` | 運用・実績 | 未着手 |
| `/admin/demo`・`/admin/demo/preview` | プレビュー（#420 のプレビュー経路へ合流） | 未着手 |
| `/admin/security`・`/admin/auth`・`/admin/login`・`/admin/ui-catalog` | 対象外（統合しない） | — |

### 3.3 `/platform` 系（#423 の対象）

| 現行ルート | 移行方針 | 状態 |
| --- | --- | --- |
| `/platform`・`/platform/tenants`・`/platform/tenants/[tenantId]` | 共通コンテキストバー + TenantSwitcher を admin と共有（#423） | 未着手 |
| `/platform/feature-flags` | §7 のレジストリと同期。`EffectiveKioskConfiguration.featureFlags` の由来 | 未着手 |
| `/platform/audit-logs`・`/platform/maintenance`・`/platform/observability`・`/platform/integrations`・`/platform/updates` | 現状維持 | — |

---

## 4. API migration matrix

`src/app/api/**` は 118 ルート（admin 63 / kiosk 31 / platform 21 / staff 2 / demo 1）。
このうち **#419 の resolver が置き換えるのは「端末が構成を読む」経路だけ**で、業務操作
（受付・チェックイン・通話・心拍）は対象外。取り違えると #422 の分割が肥大化する。

### 4.1 置き換え対象（構成読み取り）

移行先はすべて `GET /api/configuration/effective`（`EffectiveKioskConfiguration` の 1 セクション）。

| 現行 API | セクション | 現在のスコープ解決 | 撤去条件 | 状態 |
| --- | --- | --- | --- | --- |
| `GET /api/kiosk/config` | （context・active・maintenance・operatingStatus） | query `kioskId` を直読み | 新経路が active/maintenance/operatingStatus を含み、`/kiosk` が新経路のみを参照 | 未着手 |
| `GET /api/kiosk/branding` | `branding` | **なし**（グローバルストア） | 同上 + テナント別 branding が新経路で解決される | 未着手 |
| `GET /api/kiosk/flow` | `receptionFlow` | kiosk セッション必須 + `resolveDefaultScope()` 固定 | 同上 + 既定スコープ固定の除去（§6） | 未着手 |
| `GET /api/kiosk/directory` | `directory` | **なし**（グローバルストア） | 同上 | 未着手 |
| `GET /api/kiosk/signage` | `signage` | **query `tenantId`/`siteId` を信用**（認証なし） | 同上（越境指定が 403 になること） | 未着手 |
| `GET /api/kiosk/voice` | `voice` | kiosk セッション**任意**（未認証は既定テナント） | 同上 | 未着手 |
| `GET /api/kiosk/motions` | `motions` | kiosk セッション任意 | 同上 | 未着手 |
| `GET /api/kiosk/assets` | `avatar` | kiosk セッション任意 | 同上 | 未着手 |
| （新設） | `operatingPolicy` | — | `resolveKioskOperatingStatusById` を resolver のローダへ寄せる | 未着手 |
| （新設） | `languages` / `integrations` / `featureFlags` | — | 現在は各所で個別取得。resolver のローダへ集約 | 未着手 |

> **この表が #419 の存在理由**: 同じ「テナント・拠点・端末」を、認証なし / query 直読み /
> セッション任意 / 既定スコープ固定の 4 通りで解決している。1 か所（`resolveProductContext`）に
> 集約しないと、越境防止をルートごとに再実装し続けることになる。

### 4.2 置き換え対象外（業務操作・そのまま残す）

`/api/kiosk/receptions/**`（call / cancel / complete / connected / fallback / feedback / status /
timeout / token）・`/api/kiosk/checkin/**`・`/api/kiosk/checkout/**`・`/api/kiosk/stay`・
`/api/kiosk/heartbeat`・`/api/kiosk/health`・`/api/kiosk/session-status`・`/api/kiosk/authorize`・
`/api/kiosk/enroll`・`/api/kiosk/voice-transport/token`。

ただし `ProductContext` の**利用側**にはなる（越境判定を `resolveProductContext` に寄せる）。
これは #419 の後続 increment で行い、本 Wave の契約 PR では配線しない。

---

## 5. 重複概念リスト

同じものを別の名前・別の実装で持っている箇所。統合先を決めずに新機能を足すと、三重になる。

| 概念 | 重複している現物 | 統合方針 | 状態 |
| --- | --- | --- | --- |
| テナント選択 UI | admin 側と platform 側で TenantSwitcher が別実装 | #423 で共通コンテキストバーへ | 未着手 |
| 構成の適用単位 | `KioskConfig`（`src/domain/kiosk/types.ts`）と、branding/voice/motions/assets/signage の個別ストア | `EffectiveKioskConfiguration` に集約（§4.1） | 進行中（#419 契約のみ） |
| 下書き / 公開 | #363 の demo 公開モデル（draft / test / published + version + rollback）と、#420 が定義する受付体験バージョン | #420 で 1 つの版モデルへ。demo 側は先行事例として設計を流用し、**両方を残さない** | 未着手 |
| プレビュー | `/admin/demo/preview`（iframe + Mock 注入）と、#419 の `kiosk-preview` area | 同じ resolver を使う 1 つのプレビューへ | 未着手 |
| 取次設定画面 | `/admin/call-routes` と `/admin/call-routing` | #421 で 1 画面へ | 未着手 |
| 営業状態 | `ServiceOperatingPolicy`（#367）と `MaintenanceWindow`（#290）が別経路で `active` を落とす | resolver の `operatingPolicy` セクションで由来を明示して合成 | 未着手 |
| ロール語彙 | `TenantRole`（`src/domain/tenant/types.ts`）と `AdminRole`（`src/domain/auth/roles.ts`, Entra 写像） | **統合しない**（責務が別）。`ProductRole = TenantRole` として #419 は前者に寄せる | 決定済 |

---

## 6. 暫定 ID・固定値リスト

`kiosk-dev` などの暫定値は、権威判断（認可・スコープ解決）の経路から段階的に除去する。
テスト・seed に残るのは可（むしろ必要）。**除去対象は「本番実行時に評価される経路」のみ**。

| 値 | 出現箇所（本番経路） | 扱い | 状態 |
| --- | --- | --- | --- |
| `kiosk-dev` | `src/lib/kiosk/kiosk-store.ts`（seed）・`src/lib/tenant/store.ts`（seed device）・`src/lib/visit/store.ts`・`src/lib/platform/update-status-store.ts`・`src/components/kiosk/KioskFlow.tsx`・`src/components/admin/KiosksManager.tsx` | seed は維持。**UI/ストアの既定値としての参照を #419 後続で除去**し、端末セッション由来の kioskId に置き換える | 未着手 |
| `DEFAULT_TENANT_ID = 'internal'` | `src/lib/tenant/default-scope.ts` | 単一テナント運用の既定として維持。ただし **`/api/kiosk/flow` が端末解決の代わりに使っている**のは除去対象 | 未着手 |
| `DEFAULT_SITE_ID = 'default-site'` | 同上 | 同上（第 2 wave にこの不一致で待機サイネージが空になる不具合が実在した） | 未着手 |
| 端末セッション未確立時の既定テナント | `/api/kiosk/voice`・`/motions`・`/assets`（`session?.kioskId` が undefined でも応答する） | resolver では **fail-closed**（`unauthenticated`）。可用性への影響は #422 の切替時に計測して判断 | 未着手 |

`kiosk-dev` は上記のほかテスト 14 ファイル・E2E 5 ファイルに出現する（`rg -l 'kiosk-dev'`）。
これらは除去対象ではない。

---

## 7. Feature flag registry

| キー | 定義 | 既定 | 適用点 | 撤去予定 |
| --- | --- | --- | --- | --- |
| `voiceSynthesis` | `TENANT_FEATURE_FLAG_KEYS`（`src/domain/platform/feature-flags.ts`） | true | `/api/kiosk/voice`（`ttsEnabled` を強制 false） | 恒久（テナント機能）|
| `avatarReception` | 同上 | true | `/api/kiosk/motions`・`/api/kiosk/assets` | 恒久（テナント機能）|
| （予定）新 ExperienceShell 切替 | #422 で追加 | 未定 | `/kiosk` の新旧シェル選択 | **移行完了後に撤去**（§9 に撤去期限を記入する）|
| （予定）resolver 互換経路 | #419 後続で追加 | 旧経路 | 構成取得を新旧どちらから読むか | **旧経路撤去と同時に撤去** |

管理面は `/platform/feature-flags`。テナント上書きが無ければ `DEFAULT_TENANT_FEATURE_FLAGS`。
**移行用フラグを追加するときは、この表に撤去条件を同時に書く**（恒久フラグと区別する）。

---

## 8. ADR index

一覧は [`docs/adr/README.md`](adr/README.md) が正（本書に転記して二重管理しない）。
現在 0001 音声 Transport / 0002 TTS キャッシュ境界 / 0003 リアルタイム会話 EC2 Phase 0 の 3 件。

**#418 プログラムで ADR が要る決定**（起票時に ADR インデックスへ追記する）:

- 構成解決の権威（`ProductContext`）とセッション信頼境界 → #419（本 Wave の実装で確定した契約は
  `src/domain/product-context/*.ts` の module doc に記述。設計選択が割れたら ADR を起こす）
- 受付体験の版モデル（draft/published・rollback 単位）→ #420
- 新旧 KioskFlow の切替方式（feature flag の粒度・撤去条件）→ #422

---

## 9. Breaking-change register

公開 API・永続スキーマ・運用手順を壊す変更を、**予告 → 実施 → 撤去**で追跡する。
CLAUDE.md の「重大変更時のみユーザー確認」に該当する行は `要確認` を立てる。

| # | 変更 | 影響 | 予告 | 実施 | 撤去/完了 | 要確認 |
| --- | --- | --- | --- | --- | --- | --- |
| B-01 | `VONAGE_*` env による資格情報供給の廃止（テナント設定 + Secrets Manager へ） | 運用環境の設定移行が必要 | 第 10 wave | 済（#405 Inc3） | — | 済（承認済み）|
| B-02 | `VisitReservation.token` の hash 化 | 既存の生 token 保存は照合不能（永続化は #97 Inc3 で一括移行） | 第 13 wave | 済（#375） | 移行は DynamoDB 化と同時 | 済（承認済み）|
| B-03 | 個別設定 API（§4.1）の廃止 | 外部から直接叩いている利用者が居れば破壊 | **本書（Wave 0）** | 未 | 新経路稼働 + 2 wave 観測後 | 要確認 |
| B-04 | `/api/kiosk/signage` の query スコープ廃止（認証必須化） | 未認証で拠点を指定していた経路が 403 になる | **本書（Wave 0）** | 未 | B-03 と同時 | 要確認 |
| B-05 | 端末セッション未確立時の既定テナント fallback 廃止（fail-closed 化） | エンロール前端末が構成を取得できなくなる | **本書（Wave 0）** | 未 | #422 の切替と同時 | 要確認 |

---

## 10. Rollback playbook

| 事象 | 検知 | 切り戻し | 前提 |
| --- | --- | --- | --- |
| 新 resolver が誤った構成を返す | `configHash` が版と一致しない / `countFallbackSections` の急増 | 互換フラグ（§7）を旧経路へ。個別 API は §4.1 が撤去済でない限り生きている | **B-03 を実施するまで旧経路を消さない** |
| 新 ExperienceShell の不具合 | VRT 差分 / axe critical / E2E red | feature flag を旧 `KioskFlow` へ戻す | #422 が新旧を同居させること |
| 誤った受付体験を公開した | 管理画面の版一覧・KPI 急変 | #420 の rollback（last-known-good 版へ戻す） | append-only な版履歴 |
| 構成に秘匿情報が混入 | resolver が `forbidden_value` で fail-closed（`src/domain/product-context/payload-contract.ts`） | 端末へ配信されない（そもそも組み立てない）。ローダ側を修正 | 契約テストを緩めない |
| 端末が旧版で固まる | `version.revision` の stale 検出 | 端末側の再取得（`OperatingStatusRefresher` と同じポーリング方式を流用） | #420 で配信・同期を実装 |

**切り戻しの原則**: ロールバックは「フラグを戻す」で完了できる形にする。DB マイグレーションを
伴う変更（§9）はフラグで戻せないため、必ず additive 先行 → 二重書き → 切替 → 撤去の順にする。

---

## 11. KPI baseline と目標

定義（分子/分母）は `docs/reception-experience-kpi.md` が正。本書は**プログラム全体の判定に
使う指標だけ**を抜き出す。

| 指標 | 定義元 | baseline | 目標 | 測定方法 |
| --- | --- | --- | --- | --- |
| 30 秒以内 呼び出し開始率 | KPI §2.1 | **未取得** | 悪化させない（Wave ごとに比較） | `summarizeExperience(logs)` |
| 完遂率 | KPI §2.2 | **未取得** | 悪化させない | 同上 |
| ステップ別離脱 | KPI §2.4 | **未取得** | #422 で離脱最大ステップを改善 | 同上 |
| resolver latency / error rate | #419 観測項目 | 新設（値なし） | Wave 1 の実配線時に初回計測 | 実装時に計測点を追加 |
| config payload size | 同上 | 新設（値なし） | 個別 API 合算より増やさない | 同上 |
| fallback 件数 | 同上 | 新設（値なし） | 恒常的な増加をゼロに | `countFallbackSections` |
| VRT 差分 | §2 | スナップショット一致 | 意図した変更のみ差分 | `tests/e2e/kiosk-vrt-a11y.spec.ts` |
| axe critical / serious | §2 | 0 件 | 0 件を維持 | 同上 |

> **baseline が「未取得」である理由を明記しておく**: 受付 KPI は `ReceptionLog.experience` の
> 実績から集計するが、dev 環境には受付実績が無く、本番は未稼働。**数値を仮置きしない**
> （偽の baseline は「悪化していない」の誤判定を生む）。実測できるのは #65 の実機 UAT 以降で、
> それまでは VRT・axe・E2E・契約テストが退行検知の主手段になる。

---

## 12. 更新ルール

- 各 Wave の PR は、**その PR が動かした行の状態を同じ PR で更新する**（後追いしない）。
- 分類が現物と食い違っていたら、気づいた周回で直す（`docs/loop-queue.md` と同じ規約）。
- 本書に「設計」を書かない。設計は Issue と ADR、実装意図はコードの module doc に置く。
