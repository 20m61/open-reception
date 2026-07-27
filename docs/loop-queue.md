# ループ着手キュー & 残作業マップ

`docs/loop-workflow.md` の運用対象キュー。**独立トラックは並行、統合点は直列、
マージは直列**（理由は workflow の「並列オーケストレーション」節）。

> **本書の分類は仮説であって事実ではない。** 各周回の冒頭で必ず `/issue-ac-mapping`
> （project skill）を通し、AC を実コードへマッピングしてから着手する。過去 3 回、
> 本書の「未実装」「外部待ち」分類が stale で、既に main に在るものを作り直しかけた。
> 分類が実態と違ったら、その周回で本書を直す。

## 現在地（2026-07-27 更新・第 23 wave 消化後）

> **新規セッションはまず [`docs/handoff-2026-07-27.md`](handoff-2026-07-27.md) を読むこと。**
> 次に何をするか・再調査不要な確定事実・ユーザー判断待ちの一覧がそこにある。

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

**過去 wave の詳細は各ハンドオフに委譲する**（本書に残すと陳腐化して誤誘導するため。§完了アーカイブ）。

| wave | 時期 | 概要 | 記録 |
| --- | --- | --- | --- |
| 1〜15 | 2026-07-19〜23 | 次世代 epic 群（#360/#364/#368）の消化。音声基盤・組織/ルーティング・デモハーネス・営業時間・テナント別 secret・VRT/axe 導入 | `docs/handoff-2026-07-22.md` ほか |
| 16〜23 | 2026-07-27 | 統合再設計 #418 の Wave 0〜2（#425 台帳 / #419 契約と実配線 / #420 版管理・スナップショット公開・反映状況・運用画面）+ **e2e 実行環境の是正と安定化** | **`docs/handoff-2026-07-27.md`** |


**次に着手する候補（2026-07-27 更新）**: **第 24 wave = #422 KioskFlow 分割**。
ブラウザ検証が使えるようになり、フルスイートも安定したので、2900 行の大改修を回帰を実測しながら
進められる。切替が入れば #419 の `kiosk-dev` 除去・#420 の端末側報告・台帳 §9 B-03〜B-05 が
まとめて解禁される。
代替候補: #421 admin IA 再編（`/admin/experience-versions` のナビ配線を含む）／
**グローバルストアのテナント対応**（永続キー変更 = スキーマ破壊なので **要ユーザー確認**）／
#423 横断 E2E ／ AI Evolution epic 群(#382〜#392)。
エピック群の優先順位はユーザー判断（現在地の注記参照）。

## 落とし穴（着手前に必読）

- **#366 は本プロジェクト初の実質的な固定費**。EC2 t4g + Route 53 + EBS + CloudWatch を
  8:00–23:00 常時稼働させる。現状 open-reception の AWS 実績は**月 $0.0005**（2026-07 実測、
  dev のみ・ほぼ無料枠内）なので、コスト構造が質的に変わる。CLAUDE.md の重大変更条件に
  該当 → **Phase 0 ADR で Budget 見積を出して承認を取ってから CDK を書く**。
- **#361 は既存の意図的設計の反転**。`KioskFlow.tsx:1210-1216` のコメントが「選択/入力画面は
  コンテンツが密集し重なるためアバターを出さない」と明記し、`avatar-companion.test.ts` で
  テスト固定されている。#361 の AC はこれを覆すので、既存テストの意図的な書き換えと
  レビュー合意が要る。単なる追加実装ではない。
- ~~#375 の token hash 化~~ → **第 13 wave で消化済み**（SHA-256 + timingSafeEqual）。
  残るのは DynamoDB 永続化（#97 inc3）時の一括移行と pepper 確定。
- **VRT を別 project へ移すと baseline が孤立する**（第 23 wave で実際に踏んだ）。スナップショット名は
  既定で project 名を含むため、その場の描画が新 baseline として自動生成され、退行がそのまま
  「正」として焼き付く。`snapshotPathTemplate` で解決先を固定すること。
- **e2e はこのコンテナで動く**（第 22 wave で是正）。「実行不可」という過去の記録は誤りだった。
  UI/a11y に触る変更は `--pr --e2e` を通す。
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
| 2026-07-19〜23 次世代 epic（第 1〜15 wave） | #360〜#377・#396・#405 ほか | `docs/handoff-2026-07-22.md` |
| 2026-07-27 統合再設計 #418 Wave 0〜2 + 検証基盤是正（第 16〜23 wave） | #425 クローズ / #419・#420 継続 / e2e 172-172 化 | **`docs/handoff-2026-07-27.md`** |
