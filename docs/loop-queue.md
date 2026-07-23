# ループ着手キュー & 残作業マップ

`docs/loop-workflow.md` の運用対象キュー。**独立トラックは並行、統合点は直列、
マージは直列**（理由は workflow の「並列オーケストレーション」節）。

> **本書の分類は仮説であって事実ではない。** 各周回の冒頭で必ず `/issue-ac-mapping`
> （project skill）を通し、AC を実コードへマッピングしてから着手する。過去 3 回、
> 本書の「未実装」「外部待ち」分類が stale で、既に main に在るものを作り直しかけた。
> 分類が実態と違ったら、その周回で本書を直す。

## 現在地（2026-07-21 更新）

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

## オープン issue（35 件）

### 新 epic 群（2026-07-19 起票）

| # | 種別 | 充足状況（根拠） | 分類 |
| --- | --- | --- | --- |
| **#360** | epic | Character-led 受付・会話・低コスト基盤の統合 epic（トラッキング） | — |
| **#361** | ux/kiosk | **部分**: `domain/reception/ui-contract.ts` に状態駆動契約・`AVATAR_STATES`・`REQUIRES_CONFIRMATION_ACTIONS`/`CHAT_FORBIDDEN_ACTIONS` 実装済（AC「音声認識だけで発信されない」ほぼ充足）。未達: `ConversationTurnView` 不在、QR が `CheckinFlow.tsx` の別シェル | ローカル可 |
| **#362** | ux/kiosk | **部分**: `domain/presence/state.ts`(5状態+テスト)・`SignageDisplay.tsx`・`domain/signage/rotation.ts` 実装済。**未達 + AC 違反実在**（`KioskFlow.tsx:1055` の検知→START 直結）。`KioskMode` 型は不在 | ローカル可 |
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
| **#379** | platform | #378 follow-up: 予測失敗理由の伝播（現状 AccessDenied も「履歴不足」と誤表示）・CE 課金抑制（1 view = $0.02、共有キャッシュ不在）・Component タグ回帰テスト・縮退パステスト・canonical header ソート | ローカル可 |
| **#396** | domain/org | #394 follow-up（**#374 の配線前に潰す**）: `buildOrganizationTree` の防御的回収が発火するとクラッシュ（親の `children` から自分を外していない → 無限再帰。現状は到達不能だがミューテーションの唯一の survivor）・`AffiliationQuery.scope` と `resolveActingMembers` の scope が任意のままで越境が漏れる・`toVisitorOrganization` の `publicIds` が任意で安全でない側が既定 | ローカル可 |

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

**第 13 wave（次に着手する）**: #361 残(VRT/axe — testing-library/axe 導入の #105 チェックを先行)／
#363 残(編集スタジオ UI polish: ターンチップ折返し・プレビュー見出し重なり)／ reopenAt 表示の
ポリシー TZ 整形／ **ユーザー判断待ち**: #405 Inc2 の deploy・#375 hash 化・#366 固定費・#4 外部依存

同 wave に **#366 Phase 0 ADR のみ**（`docs/adr/*.md` 新規・コスト増ゼロ）を差し込むのは安全。
CDK 実装と deploy は分離し、Budget 見積を添えてユーザー承認を取る。
**第 3 wave**: #361（KioskFlow 大改修・単独）／ #369
**第 4 wave**: #370 + #371 並行 → #372、#363 Inc1
**第 5 wave**: #366 Stack（**ユーザー承認後**）→ #367、#376 Spike → #4 → #65

## 落とし穴（着手前に必読）

- **#366 は本プロジェクト初の実質的な固定費**。EC2 t4g + Route 53 + EBS + CloudWatch を
  8:00–23:00 常時稼働させる。現状 open-reception の AWS 実績は**月 $0.0005**（2026-07 実測、
  dev のみ・ほぼ無料枠内）なので、コスト構造が質的に変わる。CLAUDE.md の重大変更条件に
  該当 → **Phase 0 ADR で Budget 見積を出して承認を取ってから CDK を書く**。
- **#361 は既存の意図的設計の反転**。`KioskFlow.tsx:1210-1216` のコメントが「選択/入力画面は
  コンテンツが密集し重なるためアバターを出さない」と明記し、`avatar-companion.test.ts` で
  テスト固定されている。#361 の AC はこれを覆すので、既存テストの意図的な書き換えと
  レビュー合意が要る。単なる追加実装ではない。
- **#375 の token hash 化は永続データのスキーマ破壊**。既存 `VisitReservation.token` は
  生値保存で migration 必須 → 要ユーザー確認。ただし他 AC は充足済みなので、
  **hash 化と 3-ref 分離だけを increment 化**すればよくモデル全体の作り直しは不要。
- **#369〜#372 は greenfield**。既存 `src/lib/voice/` を音声パイプラインと誤認しない。

## モデル割り当て指針（オーケストレータ向け）

オーケストレータ（マージ判断・レビュー・競合解決・スコープ裁定）は上位モデルで実行し、
実装トラックは `Agent` の `model` でタスク特性に合わせる:

| 割り当て | 対象 | 例 |
| --- | --- | --- |
| **上位（opus 等）** | 設計判断を伴う UX/情報設計、横断リファクタ、スキーマ設計 | #361（画面再設計・既存設計の反転）/ #373（組織モデル）/ #374（ルーティング抽象）/ #375（招待モデル） |
| **標準（sonnet 等）** | AC が具体的で対象ファイルが特定済みの実装 | #362（配線分離）/ #365（ハーネス）/ #367 Inc1 / #369〜#372（仕様が明確な greenfield）/ #377 |
| **標準（sonnet 等）** | ドキュメント整備・ADR 草案 | #366 Phase 0 / #376 ADR |

- レビュー/検証エージェント（読み取り専用 fan-out）は標準モデルで並行可。
- トラック内で設計疑義が出たら実装を止めてオーケストレータへ報告（トラック側で判断しない）。

## 進め方メモ

- 各トラックは独立 worktree（または `isolation: "worktree"` のサブエージェント）で実装。
- fresh worktree は `node_modules` が無いが `quality-gate.sh` の bootstrap が自己修復する。
  worktree 内でゲートを起動するときは **その worktree 自身の `scripts/quality-gate.sh`** を叩く。
  スクリプトは `cd "$(dirname "$0")/.."` で repo root を解決するため、**main の絶対パスを渡すと
  main のツリーが検証され worktree の変更は一切見られない**（2026-07-19 に実際に 2 トラック空振り
  させた）。「絶対パスで」だけでは不十分。`$(git rev-parse --show-toplevel)/scripts/quality-gate.sh`
  の形で渡すか、出力の `repo:` 行でどのツリーで走ったかを必ず確認する。
- コミット署名は 1Password `op-ssh-sign`（ロック中は失敗 → アンロックして再実行）。
- マージは 1 本ずつ。ゲート green + レビュー blocking なしなら自動マージ（重大変更時のみ確認）。
  後続トラックはマージ後 main を `git pull --ff-only` で取り込んでから整合確認。
- 状態は本ファイルの表で更新していく。**分類が実態と違ったらその周回で直す。**

## 完了アーカイブ

過去フェーズの詳細は各ハンドオフに委譲する（本書には残さない — 陳腐化して誤誘導するため）。

| フェーズ | 範囲 | 記録 |
| --- | --- | --- |
| 初期 DAG / QR チェーン / 管理画面クラスタ / 受付拡張・UX | epic #82 / #96 / #119 とその子 issue | 全クローズ |
| platform console | epic #83（運用 ops は #290 へ切り出し） | `docs/platform-console-design.md` |
| 2026-07-02〜03 自律ループ | #264/#275/#273/#261/#289/#274/#299/#300/#303/#308/#284/#200 | クローズ済 |
| 2026-07-11 三層棚卸し → 07-12/13 消化 | #313〜#331・#342・#348 | `docs/handoff-2026-07-12.md` |
