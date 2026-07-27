# ループ着手キュー & 残作業マップ

`docs/loop-workflow.md` の運用対象キュー。**独立トラックは並行、統合点は直列、
マージは直列**（理由は workflow の「並列オーケストレーション」節）。

> **本書の分類は仮説であって事実ではない。** 各周回の冒頭で必ず `/issue-ac-mapping`
> （project skill）を通し、AC を実コードへマッピングしてから着手する。過去 3 回、
> 本書の「未実装」「外部待ち」分類が stale で、既に main に在るものを作り直しかけた。
> 分類が実態と違ったら、その周回で本書を直す。

## 現在地（2026-07-27 更新・第 23 wave 消化後）

**統合再設計プログラム #418 の進捗**: Wave 0（#425 台帳・クローズ済）→ Wave 1（#419 契約 +
`/api/configuration/effective` 実配線）→ Wave 2（#420 = 版ライフサイクル・永続化・スナップショット公開・管理 API・反映状況）まで消化。
次は **#422（KioskFlow 分割）**。詳細は第 16〜23 wave の各節。
**ブラウザ e2e はこのコンテナで動き、フルスイート 172/172 が安定して green**
（第 22 wave で実行環境を是正・第 23 wave で干渉を解消）。UI に触る変更は `--e2e` を通すこと。
移行状態の追跡は **`docs/product-integration-plan.md` が正**（本書は着手順・依存 DAG を持ち、
移行台帳は持たない）。

## 旧・現在地（2026-07-27 起票登録時）

**2026-07-23〜26 に統合再設計プログラム #418〜#426（9 件）が起票された**（本書に未登録
だったため 2026-07-27 に登録。下記「統合再設計プログラム」節）。#418 の issue コメントで
**推奨開始順が明示**されている: ①#425 Wave 0（baseline 固定・移行台帳）→ ②#419
（ProductContext 型・resolver 契約・越境防止契約テストの小 PR）→ ③#420 → ④#421 →
⑤#422 → ⑥#423 → ⑦#424。AC マッピング済み（2026-07-27、結果は同節の表）。

**ユーザーの draft PR が 2 件 open**（#427 = Opus 5 自律ループ guardrails +
`docs/experience/README.md`、#428 = Opus 5 operating profile）。いずれもユーザー起票の
ドキュメント PR で、#418 配下の issue は #427 の Experience Engineering 規約
（Journey ID・状態遷移・音声タッチ等価性等）を必須入力とする旨が #418 コメントに在る。
**マージ判断はユーザー**（本ループでは触らない）。

**エピック群の優先順位（#418 統合再設計 / #382〜#392 AI Evolution / #360・#364・#368 残差）
はユーザー判断**。ただし #418 は最新の起票でかつ #424 が AI Evolution 系の関心を包含する
形になっており、着手順が issue 側で確定しているため、**次周回は #425 Wave 0 + #419 を
既定候補とする**（両方ローカル可・破壊なし。異議があればユーザーが interrupt）。

起点確認 2026-07-27: main = `31718c7` で `quality-gate.sh --fast` green
（typecheck / lint / unit 3734 件 PASS）。

## 旧・現在地（2026-07-21 時点）

**2026-07-19 に AI Evolution epic 群（#382〜#392 の 12 件）が追加起票された**（本書に未登録
だったため 2026-07-21 に登録。下記「AI Evolution epic 群」節）。全件 greenfield
（`src/` に Evolution/Opportunity/Signal 系の実装は無関係モジュールのヒットのみ）。
土台として再利用する既存資産は #83 コンソール・#89 使用量/監査・feature-flags・#319 KPI・
#320 満足度・#365 評価ハーネス・#379 コスト画面。

**前フェーズ（2026-07-11 起票の三層棚卸し #313〜#331）は完了・クローズ済み**
（PR #333〜#359、詳細は `docs/handoff-2026-07-12.md`）。

**現在の LOOP は「2026-07-19 に起票された次世代 epic 群（#360 / #364 / #368）を
消化する」フェーズ。** 起票時に 18 件（#360〜#377）が追加され、全件を実コードへ
マッピング済み（結果は下表）。マッピングで判明した重要事項:

- **#374（ルーティング）を「未着手」扱いしない。** `domain/notification/call-route.ts` に
  `CallRoute > CallTargetGroup > CallTarget(channel/priority)` + 管理 UI + API が既に在り、
  AC「Vonage 以外の Provider 追加時に受付ドメインを変更しない」は設計上ほぼ達成済み。
  残差分は `RoutingStep.nextOn` の結果別遷移と Orchestrator に絞れる。
- **#375（QR 招待）も部分充足。** 期限/使用済み/取消の区別（`CheckinFailureReason`）と
  「QR に PII を含めない」は既に充足。残るのは token の hash 化と 3-ref 分離のみ。
- **#362 は AC 違反が現物として存在する。** `KioskFlow.tsx:1055` で
  `usePresenceCamera(presenceActive, startReception)` が検知→`dispatch({type:'START'})` に
  直結している。バグ相当なので配線分離 + 回帰テストで消化できる。
- **#369〜#372 は完全 greenfield。** `src/lib/voice/` は TTS *設定ストア*であって
  音声パイプラインではない。既存資産と誤認しないこと。
- **#367 の「#366 依存」は過剰記述。** Increment 1（ServiceOperatingPolicy）と
  Increment 4（営業時間外 Kiosk UX）は EC2 非依存でローカル完結可能。#366 が要るのは
  EC2 start/stop adapter のみ。

## オープン issue（43 件・2026-07-27 時点）

### 新 epic 群（2026-07-19 起票）

| # | 種別 | 充足状況（根拠） | 分類 |
| --- | --- | --- | --- |
| **#360** | epic | Character-led 受付・会話・低コスト基盤の統合 epic（トラッキング） | — |
| **#361** | ux/kiosk | **部分**: `domain/reception/ui-contract.ts` に状態駆動契約・`AVATAR_STATES`・`REQUIRES_CONFIRMATION_ACTIONS`/`CHAT_FORBIDDEN_ACTIONS` 実装済（AC「音声認識だけで発信されない」ほぼ充足）。未達: `ConversationTurnView` 不在、QR が `CheckinFlow.tsx` の別シェル | ローカル可 |
| ~~#362~~ | ux/kiosk | **クローズ済**（第 2 wave: KioskMode/attract-detector 分離・検知→START 直結廃止） | 完了 2026-07-22 |
| **#363** | admin/demo | **未着手**: `DemoScenario`/studio/preview は 0 ヒット。土台は `ReceptionFlowsManager.tsx`・`src/lib/reception/flow-config/` | ローカル可 |
| **#364** | epic | 日本語リアルタイム会話基盤 epic（トラッキング） | — |
| ~~#365~~ | quality/voice | **クローズ済**（PR #393）。`src/domain/voice/evaluation-*` + `tests/voice-evaluation/`。**#369〜#372 の共通イベント形式が確定** — 正解は刺激側（`nearEndStimuli[]` の `atMs ± toleranceMs`）に固定し観測とマッチング、計測不能は `null`、`strict` で欠落自体を違反に。詳細は `docs/voice-evaluation-harness.md` | 完了 2026-07-22 |
| **#366** | infra/cdk | **未着手**: `infra/lib/stacks/` に realtime 系なし。`docs/adr/` 自体が不在 | **要ユーザー判断（固定費増）**。Phase 0 ADR のみローカル可 |
| **#367** | admin/ops | **未着手**: `operatingHours`/`out_of_hours` は全体 0 ヒット。流用可: `domain/platform/maintenance-window.ts`・`feature-flags.ts` | ローカル可（EC2 adapter 部のみ #366 待ち） |
| **#368** | epic | 組織・接続先・ルーティング・QR 招待の再構築 epic（トラッキング） | — |
| **#369** | voice | **未着手**: `domain/voice/types.ts` は `VoiceProvider = 'browser' \| 'none'`。AudioWorklet/WSS なし | ローカル可（実機計測は #65） |
| **#370** | voice/stt | **未着手**: Transcribe 参照 0。接続先 `domain/staff/search.ts` は在る | ローカル可（mock 先行）/ 実 AWS は外部待ち |
| **#371** | voice/tts | **未着手**: Polly 参照 0。`VrmAvatarViewer.tsx`・`avatar/vrm-pose.ts` は再利用可 | 同上 |
| **#372** | voice/turn | **未着手**: VAD/turn detector なし | ローカル可 |
| **#373** | domain/org | **increment 1 完了**（PR #394 = `src/domain/organization/` の型・階層検証・ディレクトリ・compat reader。additive 限定で既存 `Department`/`staff.departmentId` は無改変）。残: 永続化 repository → Directory API 配線 → 来訪者 UI → tenant 越境 E2E。follow-up は **#396** | ローカル可（継続） |
| **#374** | domain/routing | **部分**: `call-route.ts` にチャネル抽象化・priority・管理 UI 実装済。未達は `ContactEndpoint` union・`nextOn` 遷移・Orchestrator・循環検出・notify/live_bridge 区別 | ローカル可 |
| **#375** | domain/invitation | **部分**: token/usagePolicy/expiresAt/status・`CheckinFailureReason` 実装済。未達は **生 token 保存**（`tokenHash` 0 ヒット）と 3-ref 分離 | ローカル可（hash 化は**スキーマ破壊 → 要ユーザー確認**） |
| **#376** | spike/vonage | **部分**: `vonage-adapter.ts`・`vonage-jwt.ts`・`docs/vonage-call-design.md` 在り。実測部未着手 | ADR はローカル可 / 実測は**外部待ち**→ #65 |
| ~~#377~~ | platform | **クローズ済**（PR #378: developer 専用 `GET /api/platform/costs`・タグ絞り込み・実績/予測・追加依存なしの SigV4 自作署名。レビューで署名を独立実装と照合し一致確認）。follow-up は **#379** | 完了 2026-07-19 |
| ~~#379~~ | platform | **クローズ済**（第 2 wave: 予測失敗理由の伝播・TTL キャッシュ・回帰テスト） | 完了 2026-07-22 |
| ~~#396~~ | domain/org | **クローズ済**（第 2 wave: 防御的回収の削除・scope/publicIds 必須化・`validateOrganizationMembership` 新設） | 完了 2026-07-22 |

### 統合再設計プログラム（2026-07-23〜26 起票 / 2026-07-27 登録・AC マッピング済）

キオスク・管理画面・プラットフォームを 1 つの循環（提供→構成→プレビュー→公開→実行→
計測→評価）へ統合する親 Epic #418 と実行 issue 群。着手順は #418 コメントで確定
（#425 Wave 0 → #419 → #420 → #421 → #422 → #423 → #424）。

| # | 種別 | 充足状況（2026-07-27 マッピング根拠） | 分類 |
| --- | --- | --- | --- |
| **#418** | program | 親 Epic（トラッキング）。子 = #419〜#425、Related #426 | — |
| **#419** | architecture | **increment 2 完了**（第 16 wave = 契約 52 テスト / 第 18 wave = `src/lib/product-context/`（fail-closed な端末束縛解決・全 11 セクションのローダ・暫定 version lookup）+ `GET /api/configuration/effective`。33 テスト）。**残**: `/kiosk` クライアントの新経路切替（#422 と同時）・`kiosk-dev` 除去・グローバルストア（branding/directory/voice/motions/avatar/languages）のテナント対応・旧個別 API の撤去（台帳 §9 B-03） | ローカル可（継続） |
| **#420** | lifecycle | **increment 4 完了**（第 17 = 純ロジック 34 / 第 19 = 永続化・スナップショット公開・管理 API 45 / 第 20 = heartbeat 報告 + 反映状況 API 20 / 第 21 = 管理画面 `/admin/experience-versions` 18。計 117 テスト）。**残**: 実検証チェッカ（asset/motion/call route 到達性）・**端末側の報告送信**（#422 のクライアント切替時）・デモ公開モデル（#363）の統合・ナビ配線（#421） | ローカル可（継続） |
| **#421** | admin ux | **未着手**（業務構造への再編）。現状は技術モジュール別ナビ。土台: `ReceptionFlowsManager.tsx`・`KiosksManager.tsx` ほか admin 画面群 | #419/#420 の後 |
| **#422** | kiosk ux | **部分**: 会話中心化の部品は #361/#364 で先行（`ui-contract.ts`・`ConversationTurnView`・voice-session）。未達: `KioskFlow.tsx`（2900 行超）の責務分割・`EffectiveKioskConfiguration` 一括取得・feature flag 切替シェル | #419 の後（#420/#421 と並行可だが推奨 Wave は #421 の後） |
| **#423** | nav/e2e | **部分**: e2e 資産は厚い（`tests/e2e/` 40+ spec・`journey-reception.spec.ts`）。未達: platform→admin→preview→kiosk の 10 ステップ横断シナリオ・共通コンテキストバー・TenantSwitcher 共通契約 | #419/#420/#421 の後 |
| **#424** | ai loop | **未着手**: `docs/ai-development-loop.md` 不在。土台: 本ループ運用（CLAUDE.md/`docs/loop-workflow.md`/quality-gate）・#427 の experience 規約（draft）。初回適用対象 = #419 と明示 | 各 wave へ順次適用 |
| **#425** | delivery | **Wave 0 完了**（第 16 wave: `docs/product-integration-plan.md` = Wave 開始/終了条件・占有ファイル・route/API 移行マトリクス・重複概念・暫定 ID・feature flag registry・breaking-change register・rollback playbook・KPI baseline、`docs/adr/README.md` = ADR index）。**残**: Wave 1 以降の各 PR で状態列を更新していく運用（台帳自体の追加作業なし） | 完了 2026-07-27 |
| **#426** | docs | **部分**: `docs/product-integration-plan.md`・`docs/adr/README.md` は第 16 wave で新設。未達: `docs/ai-development-loop.md`（#424 本体） | #424 と同時 |

### AI Evolution epic 群（2026-07-19 起票 / 2026-07-21 登録）

自律型プロダクト進化基盤の epic。**全件 greenfield**。既存の #360/#364/#368 wave とは
ファイル領域がほぼ独立（`/platform/evolution` 系）なので独立トラックにできるが、
**既存 epic 群との優先順位はユーザー判断**（本書は依存順のみ定義する）。

| # | 種別 | 充足状況（根拠） | 分類 |
| --- | --- | --- | --- |
| **#382** | epic | 自律進化基盤の統合 epic（トラッキング）。自律レベル L0〜L5・停止条件を定義 | — |
| **#392** | adr/spike | **未着手**: `docs/adr/` 自体が不在。Claude Managed Agents / Agent SDK / AWS 実行基盤の責務境界検証 | ローカル可（ADR 起草）。**実コスト発生する検証は要ユーザー判断** |
| **#383** | governance | **未着手**: 憲章・変更分類・Policy as Code・Kill Switch。`PROJECT_CHARTER.md` は在る | ローカル可。**Increment 0 = 最初に着手**（L0 固定・deny fixture 先行） |
| **#384** | intelligence | **未着手**: 外部シグナル収集は interface + mock 先行、実クロールは外部待ち | ローカル可（mock 先行） |
| **#385** | diagnostics | **未着手**: Scorecard。#319 KPI・#320 満足度・#89 使用量を再利用（重複計測しない） | ローカル可 |
| **#386** | opportunity | **未着手**: Opportunity Registry。#383/#384/#385 の後 | 依存待ち |
| **#387** | experiment | **未着手**: 土台に `domain/platform/feature-flags.ts` 在り。Shadow/Canary/Guardrail | #383 の後 |
| **#388** | development | **未着手**: 隔離環境の自律開発 → Draft PR。main push/merge 権限なしが前提 | #386 の後（外部実行基盤は #392 ADR で裁定） |
| **#389** | evaluation | **未着手**: 独立評価器・Evidence Package・Release Governor | #387/#388 の後 |
| **#390** | memory | **未着手**: Evolution Ledger。Run/Evidence 最小モデルは Increment 1 で先行可 | #383 の後 |
| **#391** | console | **未着手**: `/platform/evolution`。read-only shell は早期実装可、write は各 Policy/API 完成後 | read-only は #383 後に前倒し可 |

**推奨着手順（epic 記載の Increment 準拠）**: #392 ADR + #383 → (#384 ∥ #385 ∥ #390 最小 ∥
#391 read-only) → #386 → #388 → #389 → #387 → 段階昇格。
**ガード**: 本 epic 群は権限・IAM・Secret・監査・課金・PII に触れる設計判断を多く含む。
各 issue の「重大変更時ユーザー確認」条件（CLAUDE.md）への該当が既定で高いことを前提に進める。

### 継続オープン

| # | 種別 | 状態 | 分類 |
| --- | --- | --- | --- |
| **#290** | platform ops | ローカル可能分は消化完了（item1-4）。残: 実 deploy 実行本体 | #195 外部待ち |
| **#196** | perf | バンドル -19%・a11y 1.0/BP 0.96 live 確定・TTFB 50-90ms。残: PSI で perf 値取得 | PSI クォータ待ち |
| **#195** | infra | dev 分完了（Notification/Monitoring 稼働・authorizer 検証済）。残: prod deploy | prod 見送り中 |
| **#4** | feature | Vonage 実通話（基盤・interface 済） | #65 スタック |
| **#31** | feature | VRM 状態別モーション（実描画済・残 idle `.vrma`） | #65 スタック |
| **#65** | 集約 | 実機 UAT / 実認証 / WebKit E2E のスタック先 | 外部リソース待ち |

## 依存 DAG

```
#365 評価基盤 ──┐(先行・並行)
                ├→ #369 Transport ─┬→ #370 STT ─┐
                │                   └→ #371 TTS ─┴→ #372 Turn/Barge-in
#366 Phase0 ADR ─→ #366 Stack ─→ #367（EC2 adapter 部のみ）
                                  #367 Inc1/Inc4 は #366 非依存 ★
#373 Organization ─→ #374 Routing ─→ #4 Vonage Provider
#375 Invitation ───→ #374（RoutingPolicy 解決で合流）
#362 状態分離 ─→ #361 Character-led UI ─→ #363 Demo Harness
                                  #363 は #374 の Mock contract も要求
#376 Spike ─→ #4 MVP2
すべて ─→ #65 実機 UAT

[統合再設計プログラム #418（着手順は issue コメントで確定）]
#425 Wave0(baseline+台帳) ─→ #419 ──┬─→ #420 ──┬─→ #421 ─→ #423
                                    │           └（#423 は #419/#420/#421 に依存）
                                    └─→ #422（#419 のみ依存・推奨は #421 の後）
#424 は各 wave の Issue/PR へ順次適用（初回適用対象 = #419）
#426 は #424/#425 と並行可（Related 扱い・順序指定なし）

[AI Evolution（独立トラック・優先順位はユーザー判断）]
#392 ADR ─┐
#383 Governance ─┬→ #384 Intelligence ─┐
                 ├→ #385 Diagnostics ──┼→ #386 Opportunity ─┬→ #388 Development ─→ #389 Governor
                 ├→ #390 Ledger        │                    └→ #387 Experiment ──→ #389
                 └→ #391 Console(read-only 先行、write は各 Policy/API 後)
```

★ issue 本文の「#367 依存: #366」は過剰記述（上記「現在地」参照）。

**issue 本文に無い実装上の依存**: **#362 → #361**。両者とも `KioskFlow.tsx`（2880 行）を
触るため、先に #362 の presence 配線分離を入れてから #361 の大規模再構成に入る。

## ウェーブ計画

**第 1 wave（3 トラック並行・ファイル衝突なし）**

| トラック | Issue | 触る領域 | 選定理由 |
| --- | --- | --- | --- |
**第 1 wave は消化済み**（2026-07-19〜22）。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | ~~#377~~ → **#379** | PR #378 マージ・#377 クローズ。follow-up #379 が残 |
| B | **#365** | PR #393（レビュー 2 巡で blocking 9 件を修正）。**#369〜#372 の共通イベント形式が確定** |
| C | ~~#373 inc1~~ → **#396** | PR #394 マージ（#373 はオープン継続）。follow-up #396 は **#374 の前に必須** |

**第 2 wave（2026-07-21〜22 消化済み）** — ブランチ `claude/handoff-issues-organization-a0acri`
（web セッション）で実装。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#396** | 完了（防御的回収の削除・scope/publicIds 必須化・`validateOrganizationMembership` 新設）。→ 次は **#374** が #373/#396 の型契約に乗る。membership 書き込みパスで `validateOrganizationMembership` を呼ぶ配線を #374 側で行う |
| B | **#362** | 完了（KioskMode/attract-detector 分離・ATTRACT オーバーレイ・検知→START 直結廃止）。実ブラウザ 8 シナリオ検証 green（`docs/ui-review-2026-07-22.md`）。付随して**サイネージ既定 scope バグ（default vs default-site）を修正**。残: presence E2E の恒久化（`scripts/kiosk-visual-check.mjs` を土台に）・実機は #65 |
| C | **#379** | 完了（予測失敗理由の伝播・認可後 TTL キャッシュ・Cache-Control 削除・Component タグ回帰テスト・コードポイント順ソート）。nit: `request_failed` も 5 分キャッシュされ復旧が遅れ得る（意図確認は次周回） |

第 2 wave 外の付随対応: Dependabot high 2 件（sharp<0.35 の libvips CVE）を `overrides` で解消。

**第 3 wave（2026-07-22 消化済み）** — 同ブランチ・3 トラック並行。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#374** | increment 1 完了（`src/domain/routing/` 新設: ContactEndpoint union・nextOn 遷移・静的循環検出+hop 上限・冪等台帳・Orchestrator・mock provider・CallRoute 非破壊 compat・seed・日本語 describe。テスト 62 件）。**残**: 文章形式ルートビルダー UI・永続化/API 配線・tenant 越境 E2E・Vonage adapter(#4) |
| B | **#361** | increment 1 完了（`ConversationTurnView` を ui-contract に一本化・横向き 35%/65% アバター継続レール・#123 の意図反転テストを明示改訂・`docs/character-led-kiosk-ux.md`）。横向き実ブラウザ検証 green。**残**: QR シェル統一・音声復唱 UI・displayText 多言語結線・VRT/axe |
| C | **#369** | increment 1 完了（`src/domain/voice-transport/`+`src/lib/voice-transport/`: 短命 token(HMAC/jti リプレイ拒否/サーバ権威 claims)・有界キュー・rate limit・lifecycle・fallback イベント・#365 ハーネス適合 eval-bridge・ADR 0001。テスト 123+ 件）。**残**: 実 WSS(API GW WebSocket) infra・Kiosk fallback 配線・AudioWorklet(#65) |

付随: **VRM 実描画検証で #31 の一部を de-stack**（rotateVRM0 欠落による背面向き描画を修正・
自作 idle.vrma 同梱・SwiftShader WebGL2 で .vrma 実再生まで検証。残: 実機負荷・リップシンク #65）。

**第 4 wave（2026-07-22 消化済み）** — 同ブランチ・3 トラック並行。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#370** | increment 1 完了（`src/domain/voice-stt/`+`src/lib/voice-stt/`: partial 安定化(LCP+debounce)・#322 接続の Entity 解決(STT/Entity confidence 分離・Top1/Top3)・低信頼確認遷移・fallback・#365 適合 eval-bridge・Transcribe 接続境界。テスト 58 件）。**残**: 実 WSS+SigV4 の ConnectionFactory・閾値の実機較正・Kiosk UI 配線(#65/次周回) |
| B | **#371** | increment 1 完了（`src/domain/voice-tts/`+`src/lib/voice-tts/`: 生成/再生の責務分離・キャッシュキー・utterance lifecycle(停止時に口パク残存なし)・viseme 中立イベント・connected 中抑止・ADR 0002。テスト 103 件）。**残**: 実 Polly・実キャッシュ配線(S3 メタデータの PII 注記あり)・VRM viewer 配線(#65/次周回) |
| C | **#363** | Inc1 完了（`/admin/demo` Demo Harness: 本番 Kiosk 無改変 iframe + Mock 注入・既定拒否 sandbox・9 シナリオ・監査。テスト 54 件）。**実ブラウザ検証で iframe 表示不能(X-Frame-Options/frame-ancestors/admin chrome/スケール)の統合欠陥 3 件を発見・修正**。**残**: Inc2 3ペイン編集・KioskFlow 注入点 4 件(営業時間外配線・STT アダプタ DI・QR ペイロード注入・取次段階イベント)・Inc3 公開モデル |

**第 5 wave（2026-07-22 消化済み）** — 同ブランチ・3 トラック並行。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#372** | 完了（`src/domain/voice-turn/`: 参照 VAD・日本語ルールの動的無音閾値 turn 判定・backchannel/interruption 分類・barge-in reducer・履歴切り詰め・#365 ci プロファイル SLO 遵守を非チート実証。テスト 68 件）。**残**: `src/lib/voice-turn/` I/O 層・kiosk 配線・実 AEC(#65)。**申し送り**: `duck`/`resume` は #371 `TtsPlaybackController` に未実装（port 定義のみ） |
| B | **#374 残** | 完了（`/admin/call-routing` 文章形式ルートビルダー・永続化 repository・API・**アドレス write-only**(応答は maskedAddress のみ)・越境/viewer 403 テスト。+59 テスト）。**残**: goto_step 遷移編集 UI・Playwright E2E・orchestrator の実行時配線。**nit**(セキュリティレビュー): 入力サイズ上限なし・UI の tenant ハードコード(internal 固定)・description の全サイト label 解決 |
| C | **#361 残** | QR シェル統一完了（CheckinFlow を `checkinConversationTurnFor` シェルで包み、既存状態機械・API 契約は無改変。「読み取りだけで発信しない」は既存遵守を退行防止テストで固定）。**残**: checkin 字幕 i18n・レール CSS 真実源統合・実カメラ(#65) |

**第 6 wave（2026-07-22 消化済み）** — 同ブランチ・3 トラック並行。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#363 注入点** | KioskFlow 外部注入点 4 件を additive に解消（`operatingStatus` prop→`OutOfHoursView`(idle のみ・fail-open・4言語)／`sttAdapterFactory` DI(中立 interface)／`InjectableQrScanner`+`?debugScanPayload=`(**非本番限定**: token の URL 露出防止、セキュリティレビュー W1 対応)／`/call` 応答 `stages[]` 後方互換拡張+`parseCallStages`(key 文字制限・上限8)）。**残**: #367 で ServiceOperatingPolicy 実装し operatingStatus に実データ供給・#370 実 provider を factory へ・demo-studio 側の注入点利用 |
| B | **voice 統合** | #371 に `duck`/`resume` 追加（#372 申し送り解消）+ `voice-session` orchestrator 新設（transport/STT/turn/TTS 合成・障害の単一 fallback 正規化・close 冪等・#365 統合セッション検証 green）。**残**: kiosk UI 配線・実 WSS/Transcribe/Polly(#65) |
| C | **#363 Inc2** | 3ペイン編集スタジオ完了（テンプレート複製→編集→保存(認可+検証+監査)→プレビュー反映・保存済み→組込の解決順・URL/スクリプト等の unsafe テキスト拒否・sandbox 維持）。実ブラウザ検証 14/15 PASS(残 1 は confirm ダイアログの自動 dismiss で非バグ)。**残**: Inc3 公開モデル・注入点(トラック A)を使ったシナリオ再現(営業時間外/STT 失敗) |

第 6 wave の注記: dev モード(`next dev`)の hydration がこのリモートコンテナで不安定（HMR
WebSocket がプロキシで失敗・React ハンドラ未アタッチ）。**実ブラウザ検証は本番ビルド
(`npm run build` + `npm start`)で行うこと**（e2e 規約と同じ）。UI polish 候補: スタジオ左ペインの
ターンチップが縦書き折返しで窮屈・プレビュー見出しとボタンの重なり(1440px)。

**第 7 wave（2026-07-22 消化済み）** — 同ブランチ・3 トラック並行。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#364/#361 voice kiosk 配線+復唱 UI** | `voiceSession?: VoiceSessionFactory` prop で opt-in 配線（未注入時完全不変）。`voiceKioskReducer`+`VoiceKioskStore`+`VoiceReadbackConfirm`（復唱「◯◯様ですね?」・字幕 aria-live・タッチ縮退案内・4言語）。synthetic driver で「発話→復唱→確定」「低信頼確認」「barge-in duck→listening」「障害→縮退」を 60 テストで固定。**残**: `onResolved`→TargetView 実結線・実 duck 信号(#65)・demo-studio への synthetic 組込 |
| B | **#363 注入点統合** | `kiosk-injection.ts` 純関数層（シナリオ→operatingStatus/sttAdapterFactory/qrScanner/`stages[]` 導出）+ preview 注入。営業時間外/STT失敗/QR期限切れ/Vonage発信失敗(段階)が preview で実 UI 再現（実ブラウザ検証済・実 Vonage SDK 非ロード維持）。`/token` は常に非 ok で `client.connect()` 不到達 |
| C | **#374 残** | goto_step 遷移編集 UI（`transition-kind-select`→`transition-step-select`）+ 保存済みルートの orchestrator 実行時配線（`/api/kiosk/call` が段階実行 mock で `stages[]` 供給・未設定/例外は fail-open+ログ・冪等台帳有効）+ nit 3 件解消（入力上限・tenant ハードコード・label の site scope） |

第 7 wave の注記・申し送り:
- セキュリティレビュー: blocking 0。W1(fail-open 無音)は同 wave 内で修正。info: routing step id に charset 検証を掛け `stages[].key` の二重防護に／`executeRoutedCall` の endpoints 取得を `endpointsForPolicyScope` で site 絞りに揃える（いずれも低リスク・次周回の nit）
- demo の `call-failed` は段階表示(dial/ring/connect)が描画後 1 秒未満で失敗 UI へ遷移し視認困難。mock 応答へ人工レイテンシを入れる polish 候補
- サブエージェントが長時間 LLM 停止するケースを観測（2h 無活動）。チェックインで検知し SendMessage 再開で完走した — 再開指示は有効な復旧手段
- **#405(テナント別 CCaaS 設定)は仕様確定済み**（Secrets Manager per tenant・env フォールバック廃止・developer 専用・漏洩/越境防止の blocking AC は issue コメント参照）。Inc1(ドメイン+mock store+CRUD)は外部認証情報不要で着手可能

**第 8 wave（2026-07-22 消化済み）** — 同ブランチ・3 トラック並行。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#405 Inc1** | テナント別 CCaaS 設定完了（`TenantProviderConfig`+redact 済み `SecretValue`+`TenantSecretStore`(mock)+developer CRUD。blocking AC 全充足=値の非露出/write-only/越境不可/server-only を 44+ テストで固定・rules 追記）。敵対的レビュー(blocking 0)の W1 対応で **secret set/clear と config PUT は `assertElevated`(JIT 昇格)必須**に。**残**: Inc2=Secrets Manager 実装+CDK(deploy 前に再確認)・Inc3=`VONAGE_*` env 撤去+call-execution 実結線 |
| B | **voice 実結線** | `onResolved`→`SELECT_TARGET` 実結線（競合規則=後勝ち・`voice-target-binding.ts` に明記）+ demo `voice-staff-visit` シナリオ自動再生（listening→復唱→確定→選択反映）+ call-failed の `/token` に demo 限定 1.2s レイテンシで段階視認可。**残**: selectingTarget 到達時の音声 replay トリガ(ゼロタッチ完全自動化)・department 解決デモ |
| C | **#367 営業時間** | `evaluateOperatingStatus` 純関数(日跨ぎ・境界・休業日 66 テスト)+`/admin/operating-hours` CRUD(認可+監査)+`/api/kiosk/config`・`/kiosk` への `operatingStatus` 供給+closed 中 `/call` 409。実ブラウザで設定→エンロール済み kiosk の OutOfHoursView 表示まで確認。**残**: 専用 `AuditAction`(現状 `site.updated` 代用)・kiosk 側の定期再取得(長時間待機画面の自動切替)・reopenAt 表示を端末 TZ でなくポリシー TZ で整形する polish・#367 epic 本体(サービスレジストリ/Reconciler/EC2 制御)は未着手 |

第 8 wave の注記: 自動コミットレビュー+敵対的レビューの指摘(キー衝突・fail-open 無音・
fixedHolidays 上限・JIT 昇格)は同 wave 内で全て修正済み。/kiosk の実表示検証には
デバイスエンロール(受付 URL 発行→`/kiosk/enroll?token=`)が必要— 手順は
`/api/admin/devices/kiosk-dev/reissue-token`(JSON body に tenantId/siteId)→ URL を開く。

**第 9 wave（2026-07-22 消化済み）** — 同ブランチ・3 トラック並行。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#405 Inc2** | `SecretsManagerTenantSecretStore`(backend 注入・prefix 写像・削除猶予 30 日・値非漏洩)+`PROVIDER_SECRET_BACKEND` 切替(既定 memory・fail-closed)+CDK IAM を `<prefix>/tenants/*` に限定(prefix はランタイムと同一規則で正規化)。新規依存なし。**deploy 未実施 — 実 AWS apply はユーザー確認後**(手順は `docs/tenant-provider-secrets.md`)。**残**: Inc3=`VONAGE_*` env 撤去+`resolveProviderForTenant` の call-execution 実結線・#65 実疎通 |
| B | **#363 Inc3** | 公開モデル完了(draft/test/published 分離・公開先 Kiosk fail-closed 検証・append-only version+rollback・256bit 共有トークン(期限必須+失効+監査値なし)・未認証公開ページ `/demo/[token]` は scenario のみ返却・404 一律で列挙オラクルなし・sandbox 維持)。敵対的レビュー W1 対応でレート制限を**二層化**(トークン単位+全体窓+evict)。**残**: DemoStudio への publish/share UI パネル・専用 AuditAction(`reception.demo_published` 等)の log.ts 追加 |
| C | **voice ゼロタッチ** | `notifyReceptionState` 中継(実 orchestrator は no-op 契約)で selectingTarget 到達時に音声シーケンスを(再)開始 — 取りこぼしゼロ。`voice-department-visit` シナリオ追加(部署解決)。full-auto(タッチ手の自動代行)は単一責務契約維持のため意図的に見送り。**残**: 部署復唱の文言 polish(「営業部様ですね?」→部署用テンプレート) |

第 9 wave の注記: 実ブラウザ検証 7/7 PASS(未認証の公開ページ描画・外部リクエストゼロ・無効
トークンのエラー表示・staff/部署の音声ゼロタッチ自動選択)。検証時の落とし穴: **ポート 3100 に
前 wave の本番サーバが残っていると旧ビルドが応答し新 route が 404 になる** — 検証前に
`next-server` プロセスの起動時刻を確認して kill すること。

**第 10 wave（2026-07-22 消化済み）** — 同ブランチ・3 トラック並行。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#405 Inc3** | `resolveProviderForTenant` 新設(server-only・SecretValue 維持・fail-closed=不整合は Mock)+資格情報供給の env 直読み撤去(`VONAGE_NOTIFY_*`/`VONAGE_SECRET_ARN`/`VONAGE_API_*`/`PRIVATE_KEY`/`APPLICATION_ID`/`ENABLED`)。旧 `getCallAdapter`/`getVonageSessionService` は env-free シム(常に Mock/null)。**破壊的**: 運用で VONAGE_* を使う環境はテナント設定+Secrets Manager へ移行要(`docs/tenant-provider-secrets.md`)。**残**: `resolveCallAdapter` 等の route/store への tenant threading(#4 実装時)・presence 表示(#90/#93)の env 依存を設定 presence へ移行 |
| B | **#363/#367 残** | 専用 AuditAction 7 種+`operating_policy.updated` へ差し替え・監査ラベル追加・DemoStudio に公開/共有パネル(draft→test/publish→version/rollback→共有リンク発行[**一度きり表示**]/失効・viewer 無効化)。セキュリティレビュー **B1**(GET 応答にトークン生値)を同 wave 内修正=GET/PATCH は presence のみ・生値は発行応答限定+回帰テスト |
| C | **aituber-kit 調査** | v1.0.0〜v1.44.1=MIT(pixiv ChatVRM 派生)・v2.0.0 から商用独自ライセンスをファイル実物で確認。**コード移植なし・考え方の参考**方針(ユーザー指示)。`docs/aituber-kit-v1-ui-reference.md` に採用提案: 聞き取り中インジケータ+interim 逐次字幕(#361/#364)・リップシンク感情連動+まばたき抑制(#31)・実音声化時の AnalyserNode 振幅駆動(#5)。当方との本質差はリップシンク駆動源のみ |

実ブラウザ検証: 公開パネルの draft→publish(kiosk-dev)→版履歴→共有リンク発行→未認証閲覧→
失効→無効表示、リロード後のトークン非再表示、監査ラベル表示まで全 PASS。

**第 11 wave（2026-07-22 消化済み）** — 同ブランチ・3 トラック並行。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **聞き取り中 UI(#361/#364)** | 波形インジケータ(idle/speech 2 段階・reduced-motion 静止)+ interim 逐次字幕(`hearPartial`→確定で復唱へ置換・自動送信は不採用)。synthetic driver と実 orchestrator(安定化 `stt.partial` のみ写像)両対応。**残**: 実機の `listenStart`/VAD 結線(#65) |
| B | **リップシンク感情連動(#31)** | `blendExpressionWeights` 純関数(感情中の口重み下限 0.4・blink 抑制・未知表情 fail-safe)+`resolveFrameExpressionWeights`+VRM viewer 結線(既定 neutral で不変)。**残**: auto-blink 実装・実機での係数チューニング(#65)・guidance への intensity 概念 |
| C | **presence 移行(#90/#93×#405)** | integrations presence をテナント設定 presence(`getVonagePresenceForTenant`・値非返却)へ移行し `isVonageConfigured`/`SECRET_KEYS` の VONAGE 項目を撤去。自動レビュー対応で接続テストの presence を認可済み tenantId に一致。**残**: `getVonagePublicConfig`(公開 applicationId・kiosk/staff 供給)のテナント設定移行は #4 tenant threading と同時に |

実ブラウザ検証 5/5 PASS(インジケータ段階遷移・逐次字幕・復唱置換・reduced-motion 静止・
presence 表示)。検証の落とし穴: Playwright の `innerText()`/`getAttribute()` は要素不在時に
auto-wait(既定 30s)でブロックする — ポーリングでは `count()` 先行 + 短 timeout を使うこと。

**第 12 wave（2026-07-23 消化済み）** — 同ブランチ・3 トラック並行。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#367 定期再取得** | `createOperatingStatusPoller`(60s・hidden 中停止・fail-open=失敗時は直前値保持・abort/cleanup 固定・重複 fetch 防止)+`OperatingStatusRefresher` で SSR 初期値+クライアント追随。**実ブラウザでリロードなしの open→closed 自動切替を確認**(エンロール済み kiosk)。**残**: #18 の kiosk セッション配線後に kioskId を渡して端末個別スコープ化 |
| B | **auto-blink(#31)** | seed 注入の決定論純関数(xorshift32・間隔 2〜6s・閉眼カーブ・NaN/時間逆行 fail-safe)を `blinkBaseWeight` に接続。感情中の抑制は既存合成に委譲。実機視認は #65 |
| C | **文言 polish(#361/#364)** | 音声復唱を kind で出し分け(担当者=「◯◯様ですね?」/部署=「◯◯でよろしいですか?」・4 言語)+ CheckinFlow の直書き字幕を dictionary 化(40+ キー、i18n テストでキー完全一致固定) |

セキュリティレビュー blocking/warning 0(info の fetch 重複は同 wave 内修正)。実ブラウザ検証:
部署/担当者の復唱出し分け・営業状態の自動切替・checkin 英語表示を確認。
運用メモ: サブエージェントが「ゲート完了通知待ち」で停止するパターンが頻発 — 再開指示 1 回で
復帰しない場合は worktree の差分を検証(affected テスト+tsc)して直接コミット・引き取りが早い。

**第 13 wave（2026-07-23 消化済み。ユーザー承認「deploy 以外は進めてよい」を受け保留 3 件を解禁）**:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#375 hash 化** | reservationToken を SHA-256(+任意 pepper)の一方向 hash 保存へ移行(照合は timingSafeEqual・発行時のみ平文応答・参照系から平文除去)。QR は発行/再発行応答同梱の `qrDataUrl` で一度きり表示、再表示は 410→再発行案内、**active でも再発行可**(紛失時の唯一の復旧手段)。エンロール token は既に HMAC で対象外。**残**: デモ共有トークンの hash 化(別 issue 候補)・DynamoDB 永続化(#97 inc3)時の一括移行+pepper 確定 |
| B | **#4 threading** | call/token/answer/通知の全 live 呼び出し点をテナント解決へ配線・旧シム撤去・公開 applicationId もテナント設定移行(env 参照ゼロ)。実発信は不到達(既定テナント未設定=Mock)。**残**: #4 MVP1 本体(実資格情報 #65) |
| C | **#366 Phase0** | ADR-0003(代替案比較・**月額見積: t4g.small 約 $14.2/月**(8:00–23:00 稼働・37% 削減)・停止手段)+ RealtimeRuntimeStack(ASG min0/max1・Reconciler Lambda・SSM kill-switch(fail-closed+AllowedPattern)・Route53 は A レコード 1 本限定 IAM)。devDeps に AWS SDK 4 種追加(#105 済・NOTICES 記載)。**deploy 未実施 — ユーザー最終確認後** |

レビュー対応済み: 自動 3 件(kill-switch fail-closed・値正規化・Route53 条件限定)+敵対的 W1/W2/W4
(QR baseUrl のサーバ権威解決統一・Lambda handler の型検査対象化・依存説明の整合)。
**残 follow-up**: W3=bedrock InvokeModel のモデル ARN 限定(deploy 前に)・Reconciler handler の
単体テスト・list/get 応答からの tokenHash 除去(防御的)・migration の pepper footgun 注意。

**第 14 wave（2026-07-23 消化済み）** — 同ブランチ・3 トラック並行。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#361 VRT/axe** | `tests/e2e/kiosk-vrt-a11y.spec.ts`: 主要 5 画面の VRT(baseline 768K・決定化済み)+axe(critical/serious ゼロ)。**依存追加なし**(axe-core は既存 devDep。MPL-2.0 の #105 記録を NOTICES へ)。baseline 更新手順は spec/報告参照。**検出**: サイネージの nested-interactive(serious)— #361 シェル再設計時に解消要 |
| B | **#363 UI polish** | ターンチップの縦書き折返し解消(ellipsis+title)・プレビュー見出しの重なり解消(wrap)・3 ペイン minWidth 再バランス。1280px 実写で確認 |
| C | **follow-up 4 件** | reopenAt をポリシー TZ で整形(fail-safe 付き)・bedrock IAM を anthropic foundation-model 限定(+synth ガード)・Reconciler handler 単体テスト 8 件・予約全応答から tokenHash 除去 |

レビュー(blocking 0)の W1/W2 は同 wave 内修正。**残 follow-up**: signage nested-interactive の src 修正・
新規予約エンドポイント追加時の tokenHash 除去は規約+テスト担保(型強制でない点に注意)・
infra web-stack.test の collection 時 `.open-next` 要求(stub 手順で回避可)。

**第 15 wave（2026-07-23 消化済み）** — 第 14 wave 申し送りの局所 follow-up（PR #416）。結果:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#361 signage a11y** | `SignageDisplay` 外側 div の `role="button"`/`tabIndex` を撤去し非対話コンテナ化＝axe `nested-interactive`(no-focusable-content, serious) を解消。全面タップはポインタ便宜ハンドラで維持・受付導線は signage-start ボタン(focusable)+window keydown に一本化。`kiosk-vrt-a11y.spec` の `nested-interactive` 除外も撤去し serious 全ルール検査へ |
| B | **#375 tokenHash ガード** | 予約 API 全ルート(list/get/create/edit/cancel/revoke/reissueToken/qr)を実呼び出しし応答 body の `tokenHash` 不在を再帰検証する behavioral 回帰ガード(`tokenhash-leak-guard.test`)。view 撤去で FAIL する negative check 済。第 14 申し送り「型強制でない tokenHash 除去忘れ」を捕捉 |

第 15 wave の注記: ~~ブラウザ e2e は本コンテナで exit 144 でブロックされ実行不可~~
**（2026-07-27 第 22 wave で誤りと判明。実際は Playwright が要求する chromium ビルド番号と
プリインストール版の不一致で、`executablePath` を渡せば動く。この stale な申し送りが 5 周にわたって
「UI 変更は検証できない」という誤った前提を作っていた。）** 以下は当時の記録:（sandbox 無効化・明示
`PW_EXECUTABLE_PATH` でもログ生成前に kill）。a11y 変更は品質ゲート(jsx-a11y 含む lint)+ 静的推論で担保し、
除外撤去後の e2e はマージ前 `--full` または e2e 可能な環境で確認する。**残 follow-up**（未消化）:
infra `web-stack.test` の collection 時 `.open-next` 要求(stub 手順で回避可・別パッケージのテスト
ergonomics で defect ではない)。**ユーザー判断待ち(deploy のみ)**: #405 Inc2 の Secrets Manager 有効化
deploy・#366 Stack の deploy(月 $14.2 見積の最終承認)・#4 実資格情報(#65)。

**第 16 wave（2026-07-27 消化済み）** — 統合再設計プログラム開始・2 トラック:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#425 Wave 0** | `docs/product-integration-plan.md`（移行台帳）+ `docs/adr/README.md`（ADR index）新設。台帳は**現物を数えて記入**（画面 47・API 118 = admin 63/kiosk 31/platform 21/staff 2/demo 1）。**マッピングで判明**: 端末の構成取得 8 経路がスコープ解決を 4 通り（認証なし / query 直読み / セッション任意 / `resolveDefaultScope()` 固定）でやっており、これが #419 の存在理由。KPI baseline は**数値を仮置きせず「未取得」と明記**（dev に受付実績が無い。偽 baseline は「悪化していない」の誤判定を生む） |
| B | **#419 契約** | `src/domain/product-context/` 新設（`types.ts`/`context.ts`/`resolver.ts`/`config-hash.ts`/`payload-contract.ts`、52 テスト）。ロール語彙は**新設せず** `TenantRole` + `domain/tenant/authorization.ts` へ委譲。端末実行は session 束縛が権威で query は**無視して記録**（拒否しない=可用性維持）、draft は端末へ配信しない、越境は 403。秘匿/PII 混入は resolver が **fail-closed** で拒否（規約ではなく実行時検査）。実配線なし（#418 コメントの「最初の PR は小さく」に従う） |

第 16 wave の注記:
- **TDD で実バグを 1 件捕捉**: `kiosk_device` 割り当ての actor が `canAccessTenant` を通ってしまい、
  端末トークンで管理プレビューの構成が引けた。管理系領域では端末割り当てを間引いた actor で
  認可判定する形に修正（`withoutDeviceAssignments`）。
- 禁止キー判定は部分文字列ではなく**末尾の語**で一致させる（`tokenEndpoint`/`warn` の誤検出回避。
  camelCase/snake_case/kebab-case を語分解）。
- **#419 の残作業に「ローダの tenant/site 絞り込み」を明記**した。現行の branding/directory は
  グローバルストアを返すため、素通しでローダにすると resolver 経由でテナント越境が起きる。

**第 17 wave（2026-07-27 消化済み）** — #420 increment 1（版ライフサイクル・単独トラック）:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#420 Inc1** | `src/domain/experience-version/`（`types.ts`/`lifecycle.ts`/`deployment.ts`、31 テスト）。**設計判断 2 件**: ①下書き保存は毎回**新 revision を積む**（append-only を貫き、競合検出を revision 比較だけで成立させる）②**rollback も新規採番**（revision を巻き戻すと端末が古い版を新しいと誤認して stale 検出が壊れる）。公開時に `configHash` を再計算せず**引き継ぐ**ことで「プレビューと公開後で同一 hash」を型で担保。反映判定は版番号に加え**指紋も突き合わせ**（同じ revision を名乗る部分反映端末を applied と誤認しない）。rollout 集計は**対象 0 台を complete にしない** |

第 17 wave の注記:
- `docs/product-integration-plan.md` §1 Wave 2 行・§5 重複概念行を同 PR で更新（台帳の自己ルール）。
- **監査は未実装**（#420 AC「公開・ロールバック・承認が監査ログに残る」）。`AuditAction` の追加は
  実際に記録する配線と同じ increment で行う（使われない列挙だけ先に足さない）。
- 版モデルの demo-studio 側からの移行は未着手。**両方を恒久的に残さない**方針は台帳 §5 に記録済み。

**第 18 wave（2026-07-27 消化済み）** — #419 increment 2（resolver の実配線・単独トラック）:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#419 Inc2** | `src/lib/product-context/`（`device-binding.ts` / `section-loaders.ts` / `version-lookup.ts`）+ `GET /api/configuration/effective`。33 テスト。**設計判断 3 件**: ①端末束縛の解決は **fail-closed**（既存 `kiosk-gate`/`maintenance-gate` は fail-open。構成配信で既定スコープへ落とすと未登録端末に既定テナントの構成が配られる）②**グローバルストア（branding/directory/voice/motions/avatar/languages）は既定テナント以外へ fail-closed**（テナント次元を持たないストアを resolver 経由で任意テナントに配らない）③**draft は 404**（下書きストアが無いのに draft を名乗る版を返すと「プレビュー＝下書き」の誤った前提でクライアントが作られる）。`integrations` は常に空を返す契約（秘匿設定を端末構成に載せない） |

第 18 wave の注記:
- 旧個別 API は**残している**（rollback playbook の切り戻し先）。`/kiosk` クライアントの切替は
  #422 と同時。台帳 §4.1 の状態は「進行中」= 新経路稼働・旧経路現役。
- **グローバルストアのテナント対応はマルチテナント運用の前に必須**。現状は「配らない」側に
  倒しているだけで、テナント別 branding は新経路でも解決できない。台帳 §4.1 の注記に記載。
- kiosk→tenant/site 解決が 3 実装（fail-open 2 + fail-closed 1）になった。台帳 §5 に重複概念
  として登録済み。既存 2 つの移行は未着手。

**第 19 wave（2026-07-27 消化済み）** — #420 increment 2（版の永続化と公開の実体化・単独トラック）:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#420 Inc2** | `src/lib/experience-version/`（repository / service / store）+ `GET,POST /api/admin/experience-versions` + 監査 4 アクション + `lib/product-context/configuration-plan.ts`。45 テスト。**設計の中核**: increment 1 の「版は指紋だけを持つ」設計では**公開が成立しない**ことが判明した — 指紋が指す中身（可変ストア）が動いてしまうため。`ExperienceConfigurationSnapshot` を導入し、**下書き保存時に解決済みセクション値ごと固定**、公開版はスナップショットから配る形に変更した。これで「管理画面の保存が端末へ即時反映されない」が初めて実体を持つ |

第 19 wave の注記:
- **指紋が 2 種類になった**。`computeConfigHash`（context+version+内容 = API 応答の `configHash`）と
  `computeSectionsHash`（内容だけ = スナップショット・版比較・ドリフト検出用）。取り違えないこと。
- **版を作っていない拠点の挙動は不変**（live 配信）。版管理を使い始めた拠点だけ「保存＝反映」でなくなる。
  台帳 §9 に **B-06** として登録した（拠点ごとの有効化タイミングは要ユーザー確認）。
- 公開版が無く下書きだけの拠点は **live へ倒さず 404**。未公開の構成を「公開版」として配らないため。
- 管理 API の応答に**スナップショット（構成の中身）を含めない**。中身が要る画面はプレビュー
  （`/api/configuration/effective?version=draft`）を使う — 同じ resolver を通るので公開後と一致する。

**第 20 wave（2026-07-27 消化済み）** — #420 increment 3（反映状況の可視化・単独トラック）:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#420 Inc3** | `lib/experience-version/deployment-store.ts`（端末報告の永続化）+ heartbeat の `?loadedRevision=&loadedConfigHash=&errorCode=&errorRevision=` 受理 + `GET /api/admin/experience-versions/deployments`（端末台帳を母集合に applied/pending/stale/failed を分類・rollout 集計）。20 テスト。**設計判断**: ①端末が報告するのは**内容の指紋**（`version.contentHash`）— API 応答の `configHash` は context に端末 ID を含むため端末ごとに違い、管理側が期待値を 1 つに決められない ②報告は heartbeat と同じく**セッション紐づけ + 未登録端末は破棄**（偽報告の注入を防ぐ）③**エラー報告は稼働中の版（loaded）を消さない**（last-known-good で動き続けるため、両方が同時に意味を持つ） |

第 20 wave の注記:
- **母集合は端末台帳**。報告が無い端末を pending として出さないと「公開できた」と誤認する。
  台帳に無い端末からの報告は集計に含めない。
- **管理画面の UI はまだ無い**（API のみ）。#420 AC の「管理画面で desired/loaded 差分を表示」は
  UI 実装で閉じる。#421 の admin IA 再編と同時にやるのが自然。
- 端末側の報告送信（`/kiosk` から heartbeat にパラメータを付ける）も**未実装**。API は受理できるが
  実際に報告するのは #422 のクライアント切替時。それまで全端末は pending として出る。

**第 21 wave（2026-07-27 消化済み）** — #420 increment 4（版管理の運用画面・単独トラック）:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **#420 Inc4** | `/admin/experience-versions`（`ExperienceVersionsManager` = 取得と操作 / `ExperienceVersionsView` = 純粋表示 / `domain/experience-version/deployment-view.ts` = 並び順と文言）。18 テスト。これで #420 AC「管理画面で desired/loaded 差分を表示」が閉じ、**下書き→承認→公開→反映確認**が画面から一周できる。**設計判断**: ①表示を純粋コンポーネントへ分離し `renderToStaticMarkup` でテスト（本コンテナは e2e 不可のため、表示規則を静的レンダリングで固定する）②端末は**対処が要る順**（失敗→旧版→未反映→反映済み）に並べる ③**代表端末 ID をサーバ側で解決**（`resolveRepresentativeKioskId`）— 画面に `kiosk-dev` を書くと台帳 §6 の暫定 ID を新規に増やすことになるため |

第 21 wave の注記:
- **端末が 1 台も無い拠点では下書きを作れない**（409 `no_device_in_site`）。構成解決に代表端末が
  要るため。版だけ先に作れても意味が無いので、版を作らない側に倒した。
- ナビゲーションへの配線はしていない（直接 URL のみ）。`navigation.ts` は #421 の IA 再編が扱う。
- **実ブラウザ検証は未実施**（本コンテナは e2e 不可）。表示規則は静的レンダリングのテストで担保し、
  実操作の確認は e2e 可能な環境か #65 で行う。

**第 22 wave（2026-07-27 消化済み）** — e2e 実行環境の是正（単独トラック）:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **検証基盤** | `playwright.config.ts` がプリインストール Chromium（`/opt/pw-browsers/chromium`）を自動検出するよう修正。**第 15 wave の「本コンテナで e2e 実行不可」は誤りだった** — 実際は Playwright 1.61.1 が要求する chromium ビルド（1228）とプリインストール版（1194）の不一致で、`executablePath` を渡せば動く。フルスイート実行の結果: **172 件中 160 passed / 4 failed / 8 未実行** |

第 22 wave の注記（重要）:
- **この stale な申し送りが 5 周にわたって「UI 変更はブラウザ検証できない」という誤った前提を作り、
  #422 の着手判断を歪めていた。** 環境の制約を記録するときは、次の周回が再検証できる形
  （再現コマンドと失敗メッセージ）で残すこと。
- **失敗 4 件はいずれも分離実行では PASS** = 機能の壊れではなく、フルスイート時の順序/共有状態
  依存の flake。対象: `capture-screens:109` / `journey-reception:65` / `kiosk-checkout-i18n:45` /
  `kiosk-vrt-a11y:103`。`--full` をマージゲートとして信頼する前に安定化が要る。
- 8 件未実行は maxFailures による打ち切り。

**第 23 wave（2026-07-27 消化済み）** — e2e フルスイートの安定化（単独トラック）:

| トラック | Issue | 結果 |
| --- | --- | --- |
| A | **検証基盤** | 第 22 wave で判明した失敗 4 件を解消。**172/172 passed を 2 回連続で確認**（各 2.8 分）。原因は 2 系統だった: ①`capture-screens` / `journey-reception` が作った端末が**一覧のページネーションで 2 ページ目以降へ押し出され**行を掴めない → 一意な端末名で `device-filter-keyword` を絞ってから掴む ②`kiosk-checkout-i18n` / `kiosk-vrt-a11y` は**既定シード状態（在館者ゼロ・seed の担当者のみ）を前提**にしており、他 spec が残した来訪者・担当者で空状態の文言と画面の高さが変わる → `pristine-state` project を新設し**本 suite より先に**単独実行 |

第 23 wave の注記:
- project 構成が「`pristine-state`（シード前提）→ `chromium-ipad`（本体）→ `flow-mutation`（破壊的）」
  の 3 段になった。**前後で挟む形**で共有状態の干渉を構造的に排除している。
- `--full` を**マージゲートとして信頼できる状態になった**。UI/a11y に触る変更は
  `./scripts/quality-gate.sh --pr --e2e` を通してから PR を出すこと。
- **VRT baseline の落とし穴（第 23 wave で踏んだ）**: スナップショット名は既定で project 名を
  含む。project を分けただけで別名になり、**レビュー済み baseline が孤立してその場の描画が
  新 baseline として自動生成された**（＝退行がそのまま「正」として焼き付く経路）。
  `snapshotPathTemplate` で `chromium-ipad` 名に固定し、自動生成された 5 枚を削除して、
  第 14 wave のレビュー済み baseline と比較し続ける形に是正した（比較結果は一致 = 退行なし）。
  **VRT を別 project へ移すときは baseline の解決先を必ず確認すること。**

**次に着手する候補（2026-07-27 更新）**: **第 24 wave = #422 KioskFlow 分割**。
ブラウザ検証が使えるようになり、フルスイートも安定したので、2900 行の大改修を回帰を実測しながら
進められる。切替が入れば #419 の `kiosk-dev` 除去・#420 の端末側報告・台帳 §9 B-03〜B-05 が
まとめて解禁される。
代替候補: #421 admin IA 再編（`/admin/experience-versions` のナビ配線を含む）／
**グローバルストアのテナント対応**（永続キー変更 = スキーマ破壊なので **要ユーザー確認**）／
#423 横断 E2E ／ AI Evolution epic 群(#382〜#392)。
エピック群の優先順位はユーザー判断（現在地の注記参照）。