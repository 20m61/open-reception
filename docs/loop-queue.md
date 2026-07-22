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

**第 5 wave（次に着手する）**: #372(Turn/Barge-in、#365 ハーネスの本丸)／ #374 残(ルートビルダー UI
+永続化)／ #361 残(QR シェル統一)／ #363 Inc2 ／ #375 残（token hash 化は**要ユーザー確認**のまま）
／ #366 Stack・#376 実測・#4 は**ユーザー承認/外部待ち**

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
