# ループ着手キュー & 残作業マップ

`docs/loop-workflow.md` の運用対象キュー。**独立トラックは並行、統合点は直列、
マージは直列**（理由は workflow の「並列オーケストレーション」節）。

> **本書の分類は仮説であって事実ではない。** 各周回の冒頭で必ず `/issue-ac-mapping`
> （project skill）を通し、AC を実コードへマッピングしてから着手する。過去 **4 回**、
> 本書の「未実装」「外部待ち」分類が stale で、既に main に在るものを作り直しかけた。
> 分類が実態と違ったら、その周回で本書を直す。
>
> **4 回目（第 41 wave）**: #367 / #369〜#372 / #374 / #375 の 4 行が「未着手」のまま
> だったが、いずれも PR #401〜#404 / #407 / #414 で実装済みだった。加えて #327 は
> クローズ済みなのに「次に着手」の第一候補として残っていた。
> **stale の直接原因は、分類を書いた周回と実装した周回が別で、実装側が表を直さないこと。**
> 消化したら必ずその周回で該当行を直す（下の「消化した wave」表に足すだけでは不十分）。

## 現在地（2026-07-30 更新・第 77 wave 消化後）

> **#361 をクローズした**（第 76〜77 wave / PR #505・#506）。受入条件 7 件すべて充足。
> 着手時の `/issue-ac-mapping` で **7 AC のうち 6 件が既に充足**と判明し、本書の「`ConversationTurnView`
> 不在」が stale だった（**分類 stale の 5 回目**）。実際に足りなかったのは QR 受付側だけで、
> (a) アバター字幕が locale を無視して ja 固定、(b) 逃げ道が各ターン手書きで契約の
> `checkinEscapeHatchesFor` が消費者ゼロ、の 2 点。
>
> **「消費者ゼロ導出はもう無い」は受付側だけの話だった。** 第 71 wave でそう記録したが、同じ
> `ui-contract.ts` の QR 受付側（`CheckinTurnView`）は一巡していなかった。**「一巡した」と書くときは
> 契約ファイル全体で数える。** QR 側で今も未消費なのは `checkinInputModesFor` /
> `checkinRequiresExplicitConfirmation`（値は正しく、テストで縛られている）。
>
> 次に着手する候補はユーザー判断（下記「次に着手する候補」節・#419 グローバルストアのテナント対応 /
> #421 admin IA 再編 / #423 横断 E2E / AI Evolution #382〜#392）。

## 旧・現在地（2026-07-29 更新・第 62 wave 消化後）

> **新規セッションはまず [`docs/handoff-2026-07-29.md`](handoff-2026-07-29.md) を読むこと。**
> 次に何をするか・再調査不要な確定事実・ユーザー判断待ちの一覧がそこにある。
>
> **判断待ちは 0 件になった**（第 55〜57 wave でユーザー承認取得）。
> **#366 / #405 の月 $14.2 費用は承認済み**、**#363 は実施承認済み**、**#422 inc5 は着手可**。
> 差分 C' は (a) 実施済み・**(b) 音声入力の実装のみ要確認**。
>
> **`--full` はこのリポジトリで初めて全ステップ green になり、マージ時の迂回は不要**
> （PR ゲートは `scripts/hooks/pr-gate-guard.sh` が機械的に強制する）。
> 残件は **#480**（linux の VRT ベースライン。**Linux セッションでしか対応できない**）。
>
> **#422 inc5 は 3 段に引き直した**（ユーザー承認済み）: inc5-a（契約を真にする・**完了**）→
> inc5-b（画面を `ConversationTurnView` へ配線）→ inc5-c（ステッパー廃止等・**inc5 から除外**）。
> **inc5-b の地ならし（残る 3 導出の突き合わせ）は完了**（第 63 wave / PR #489）。
> `gazeTarget` に乖離 2 件（`fallback` が存在しない回答領域を指す / 通信断の `failed` が
> 出ないはずの代替 CTA を指す）。`deriveAvatarEmotion` と
> `requiresExplicitConfirmationFor` は**値が正しく**、縛るテストだけ足した。
> **inc5-b 本体は増分に割って進める。増分 1（主指示の配線）は完了**（第 64 wave / PR #490。
> `conversation-turn.ts` が契約 `MessageKey` → i18n キーの解決を持つ）。
> **増分 2（単一 CTA 3 画面 = 確認 / 失敗・未応答 / 通話中）も完了**（第 65 wave / PR #492）。
> `turnAnswersFor` 経由になり、**代替導線を出すかの判断が画面から消えた**
> （`reception-screens.tsx` の `shouldOfferAlternativeContact` import ごと削除）。
> **増分 3a（用件カード）も完了**（第 66 wave / PR #493）。ラベルの二重管理
> （契約の生リテラル vs 辞書）を解消し、画面から `RECEPTION_PURPOSES` が消えた。
> **増分 3b（待機の入口）も完了**（第 67 wave / PR #494）。QR 受付は「回答」ではなく
> **引き渡し（`handoffs`）**として型で分け、`quick-actions.ts` から入口の定義が消えた。
> **inc5-b の配線は一巡した。** inc5-c はユーザーと仕様を詰めて 3 増分に分割済み
> （設計は `docs/superpowers/specs/2026-07-29-issue-422-inc5c-design.md`）。
> **増分 1（ステッパー廃止 + 字幕の位置づけ化）は完了**（第 69 wave / PR #496）。
> **増分 2（常設要素の領域帰属）も完了**（第 70 wave / PR #497）。契約が 3 領域の語彙と
> ターン要素の帰属を、component の登録簿が実 DOM 要素の帰属を持つ。`data-testid` と
> `data-persistent-region` を登録簿から同時に供給するので**描画側が登録簿を迂回できない**。
> **増分 3（`gazeTarget` の VRM 適用）も完了**（第 71 wave / PR #498）。
> **#422 は第 72 wave でクローズした**（受入条件 7 件すべて充足）。受入条件に対応しない
> 実装範囲 2 項目は #500（段階表示ルール）/ #501（kiosk 専用トークン分離）へ切り出した。
> 残る検証は実機（#65）と linux VRT ベースライン（#480）。
> 視線の実描画確認は headless では不可（WebGL fallback へ落ちる）ため #65 へスタック。
> 前セッション分は [`handoff-2026-07-27.md`](handoff-2026-07-27.md)。

**統合再設計プログラム #418 の進捗**: Wave 0（#425 台帳・クローズ済）→ Wave 1（#419 契約 +
`/api/configuration/effective` 実配線）→ Wave 2（#420 = 版ライフサイクル・永続化・スナップショット公開・管理 API・反映状況）
→ Wave 4 の increment 1〜2（#422 = 端末の構成取得を実効構成の 1 回取得へ一本化 → 構成取得 /
環境監視 / メトリクスのフック分離）→ #420 の端末側の版報告と定期再取得（公開 → 端末取得 → 反映 ACK が一周した）まで消化。
→ #422 increment 3〜4（`renderScreen` の props オブジェクト化 → **受付ジャーニー画面と状態機械の
ファイル分割**）まで消化。`KioskFlow.tsx` は 3196 → **1608 行**。
→ #419 の `kiosk-dev` 除去（**端末 ID はセッションが権威**）まで消化。詳細は第 16〜30 wave の各節。
→ #420 の実検証チェッカ（asset / motion / language）まで消化。
**#427 はユーザー承認を得てマージ済**（`docs/experience/README.md` が体験設計の正本、
`.claude/rules/opus5-autonomous-loop.md` が運用規約）。次の #422 increment 5（新旧 ExperienceShell）は
**その規約の停止境界「主要 Journey / state / fallback の意味を変える仕様判断」に該当する**ため、
着手前にユーザー確認が要る。#363 デモ公開モデルの統合は **ADR 0005 で方針を確定したが、実施は要ユーザー承認**（台帳 §9 B-07）。
第 34 wave で **Journey / 状態モデルと実装の差分を洗い出し**（`docs/experience/state-mapping.md`）、
対応表を機械検証（`src/domain/experience/journey-map.ts`）にした。
**差分 B は第 35〜37 wave で決着**（体験状態は 1 つも増やさずに済んだ）。
**差分 C の「2 つの確認を統合する」提案は ADR 0007 で却下**（前提が誤りだった）。ただし
**差分 C'（音声だけでは受付を完遂できない。`SCREEN_TO_INPUT_MODES` の宣言と実装が
3 分の 2 で食い違う）は実在し、要ユーザー確認**（音声入力を増やすのは Journey の意味に触れる）。
差分 D も要ユーザー確認のまま。**#422 increment 5 の範囲引き直しも仕様判断なので未確定。**
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
  「QR に PII を含めない」は既に充足。~~残るのは token の hash 化と 3-ref 分離のみ~~
  → **hash 化は第 13 wave で完了。残るのは 3-ref 分離だけ**（第 41 wave 確認）。
- **#362 は AC 違反が現物として存在する。** `KioskFlow.tsx:1055` で
  `usePresenceCamera(presenceActive, startReception)` が検知→`dispatch({type:'START'})` に
  直結している。バグ相当なので配線分離 + 回帰テストで消化できる。
- ~~**#369〜#372 は完全 greenfield。**~~ → **第 41 wave に撤回**（PR #401〜#404 で実装済み。
  本物のパイプラインは `src/domain/voice-*` と `src/lib/voice-*` に在る）。
- **#367 の「#366 依存」は過剰記述。** Increment 1（ServiceOperatingPolicy）と
  Increment 4（営業時間外 Kiosk UX）は EC2 非依存でローカル完結可能。#366 が要るのは
  EC2 start/stop adapter のみ。→ **その通りで、実際に PR #407/#414 で消化済み**（第 41 wave 確認）。

## オープン issue（42 件・2026-07-28 時点）

> **第 41 wave の棚卸し**: 本表の分類を実コードへ突き合わせ直したところ、**4 行が実装済みを
> 「未着手」と書いていた**（#367 / #369〜#372 / #374 / #375）。件数も 43 → 42（#327 クローズ）。
> 本書冒頭が自ら警告している「分類は仮説であって事実ではない」の 4 回目の再発。
> **着手前に `/issue-ac-mapping` を通すこと**（表を信じて作り直すのが最大の損失）。

### 新 epic 群（2026-07-19 起票）

| # | 種別 | 充足状況（根拠） | 分類 |
| --- | --- | --- | --- |
| **#360** | epic | Character-led 受付・会話・低コスト基盤の統合 epic（トラッキング） | — |
| ~~#361~~ | ux/kiosk | **クローズ済**（第 76〜77 wave。受入条件 7 件すべて充足）。着手時の再マッピングで旧「`ConversationTurnView` 不在」が **stale** と判明（契約は `ui-contract.ts` に在り #422 inc5-b で配線済み）。第 76 wave で QR 字幕の locale 固定を是正（PR #505）、第 77 wave で QR の逃げ道を `EscapeBar` 共有の常設バーへ統一（PR #506）。確認画面の `checkin-cancel`（「やめる」）は `cancelled` の到達性を保つためユーザー確認のうえ残した | 完了 2026-07-30 |
| ~~#362~~ | ux/kiosk | **クローズ済**（第 2 wave: KioskMode/attract-detector 分離・検知→START 直結廃止） | 完了 2026-07-22 |
| **#363** | admin/demo | **Inc1〜3 実装済**（シナリオ・編集/保存・下書き/テスト/本番公開・共有トークン・未認証閲覧）。第 33 wave で **#420 版モデルとの統合方針を ADR 0005 で確定**。**残**: 統合の実施（§9 B-07。永続スキーマとスコープ語彙を動かすため**要ユーザー承認**） | 要ユーザー確認 |
| **#364** | epic | 日本語リアルタイム会話基盤 epic（トラッキング） | — |
| ~~#365~~ | quality/voice | **クローズ済**（PR #393）。`src/domain/voice/evaluation-*` + `tests/voice-evaluation/`。**#369〜#372 の共通イベント形式が確定** — 正解は刺激側（`nearEndStimuli[]` の `atMs ± toleranceMs`）に固定し観測とマッチング、計測不能は `null`、`strict` で欠落自体を違反に。詳細は `docs/voice-evaluation-harness.md` | 完了 2026-07-22 |
| **#366** | infra/cdk | **未着手**: `infra/lib/stacks/` に realtime 系なし。`docs/adr/` 自体が不在 | **要ユーザー判断（固定費増）**。Phase 0 ADR のみローカル可 |
| **#367** | admin/ops | **大部分実装済**（第 41 wave に訂正。旧「未着手・0 ヒット」は誤り）: `domain/operating-policy/{schedule,tz,text-format,types}.ts` + `lib/operating-policy/{call-guard,kiosk-gate,request,store}.ts` + `app/api/admin/operating-policy/` + `app/admin/operating-hours/` + `components/kiosk/OutOfHoursView.tsx`（PR #407/#414）。**残**: EC2 の start/stop/drain adapter | ローカル可（残りは #366 待ち＝費用増） |
| **#368** | epic | 組織・接続先・ルーティング・QR 招待の再構築 epic（トラッキング） | — |
| **#369** | voice | **実装済（純ロジック + 配線）**（第 41 wave に訂正。旧「未着手」は誤り）: `domain/voice-transport/`（token/lifecycle/queue/rate-limit/fallback/eval-bridge、7 module × 7 test）。`lib/voice-session/orchestrator.ts` から配線済 | ローカル可（実機計測は #65） |
| **#370** | voice/stt | **実装済**（同上）: `domain/voice-stt/`（stabilizer/entity-resolver/fallback）+ **`lib/voice-stt/transcribe-adapter.ts`（`TranscribeStreamingSttProvider`）** + mock provider。旧「Transcribe 参照 0」は誤り | ローカル可 / 実 AWS 疎通は外部待ち |
| **#371** | voice/tts | **実装済**（同上）: `domain/voice-tts/`（cache/queue/lifecycle/viseme/suppression/dynamic-utterances、9 module × 9 test）。Polly は `server/notification/polly-adapter.ts` に在る | ローカル可 / 実 AWS 疎通は外部待ち |
| **#372** | voice/turn | **実装済**（同上）: `domain/voice-turn/`（vad/turn-detector/near-end-classifier/barge-in-controller/history-truncation/stt-integration）。旧「VAD/turn detector なし」は誤り | ローカル可 |
| **#373** | domain/org | **increment 1 完了**（PR #394 = `src/domain/organization/` の型・階層検証・ディレクトリ・compat reader。additive 限定で既存 `Department`/`staff.departmentId` は無改変）。残: 永続化 repository → Directory API 配線 → 来訪者 UI → tenant 越境 E2E。follow-up は **#396** | ローカル可（継続） |
| **#374** | domain/routing | **実装済**（第 41 wave に訂正。旧「未達」列は stale）: `domain/routing/`（endpoint/policy/orchestrator/ledger/describe/compat/seed/provider/mock-provider、9 module × 7 test）。循環検出は `policy.ts`。**残**: 旧 `call-route` との重複解消（台帳 §5 の重複概念＝概念一本化は仕様判断） | 残りは要ユーザー確認 |
| **#375** | domain/invitation | **部分**: token hash 化は第 13 wave 完了。**3-ref 分離は第 42 wave で型と写しを実装し、第 53 wave で `issuedBy` の永続化まで到達**（任意フィールドで加算的・サーバの認可済みコンテキストから導出＝公開 API は非破壊）。**残**: `receptionTarget` / `connectionTarget` の載せ替え。MVP 制約下では `targetType`/`targetId` から導出でき**情報が増えない**ため、公開 API を動かす価値が薄い（要ユーザー確認のまま）・QR 確認画面への発行者表示・監査記録・**本人接続でない招待をどの exception state へ落とすかの体験設計**（`person_unavailable` か新規か。J-OR-03 / J-OR-05 に直結） | 残りは**要ユーザー確認**（公開 API + Journey の意味） |
| **#376** | spike/vonage | **部分**: `vonage-adapter.ts`・`vonage-jwt.ts`・`docs/vonage-call-design.md` 在り。実測部未着手 | ADR はローカル可 / 実測は**外部待ち**→ #65 |
| **#399** | avatar | **本書に未登録だった**（第 41 wave に追加）。`public/avatar/` は README + provenance のみで実 VRM 資産なし。実機 UAT とライセンス条件の判定を含む | **外部待ち**→ #65 |
| **#405** | platform | **本書のオープン表に行が無く、完了アーカイブ行にだけ現れていた**（第 41 wave に追加）。Inc1 実装済: `domain/provider-config/`（config/secret/types/secrets-manager-store + server-only 静的検証）+ `lib/platform/tenant-secret-store.ts`。**残**: Inc2 の保存先判断（Secrets Manager / KMS+DynamoDB）＝ secret 方針 + コスト | **要ユーザー確認**（issue 本文も明記） |
| ~~#377~~ | platform | **クローズ済**（PR #378: developer 専用 `GET /api/platform/costs`・タグ絞り込み・実績/予測・追加依存なしの SigV4 自作署名。レビューで署名を独立実装と照合し一致確認）。follow-up は **#379** | 完了 2026-07-19 |
| ~~#379~~ | platform | **クローズ済**（第 2 wave: 予測失敗理由の伝播・TTL キャッシュ・回帰テスト） | 完了 2026-07-22 |
| ~~#396~~ | domain/org | **クローズ済**（第 2 wave: 防御的回収の削除・scope/publicIds 必須化・`validateOrganizationMembership` 新設） | 完了 2026-07-22 |

> **#369〜#372 は PR #401〜#404（第 3〜6 wave）で実装済み**だった。「`src/lib/voice/` を音声
> パイプラインと誤認しない」という旧・落とし穴は、**本物のパイプラインが `src/domain/voice-*` と
> `src/lib/voice-*` に在る**現在では逆向きの誤誘導になるので撤去した。

### 統合再設計プログラム（2026-07-23〜26 起票 / 2026-07-27 登録・AC マッピング済）

キオスク・管理画面・プラットフォームを 1 つの循環（提供→構成→プレビュー→公開→実行→
計測→評価）へ統合する親 Epic #418 と実行 issue 群。着手順は #418 コメントで確定
（#425 Wave 0 → #419 → #420 → #421 → #422 → #423 → #424）。

| # | 種別 | 充足状況（2026-07-27 マッピング根拠） | 分類 |
| --- | --- | --- | --- |
| **#418** | program | 親 Epic（トラッキング）。子 = #419〜#425、Related #426 | — |
| **#419** | architecture | **increment 4 完了**（第 16 wave = 契約 52 テスト / 第 18 wave = `src/lib/product-context/` + `GET /api/configuration/effective` 33 テスト / 第 24 wave = `/kiosk` クライアントの新経路切替を移行フラグ配下で実施 19 + e2e 5 / 第 30 wave = `kiosk-dev` 除去・端末 ID をセッション権威に 9 + e2e 1）。**残**: 移行フラグ既定の切替（観測後）・グローバルストア（branding/directory/voice/motions/avatar/languages）のテナント対応・旧個別 API の撤去（台帳 §9 B-03） | ローカル可（継続） |
| **#420** | lifecycle | **increment 7 完了**（第 17 = 純ロジック 34 / 第 19 = 永続化・スナップショット公開・管理 API 45 / 第 20 = heartbeat 受け口 + 反映状況 API 20 / 第 21 = 管理画面 18 / 第 26 = 端末側の報告送信 11 / 第 27 = **端末側の定期再取得 + 受付中は適用保留** 10 + e2e 2 / 第 31 = 実検証チェッカ（asset / motion_mapping / language_fallback）18。計 156 テスト）。**ライフサイクル（公開 → キオスク取得 → 反映 ACK）が一周した。** / 第 32 = 取次到達性の検証 13。計 169 テスト）。**残**: デモ公開モデル（#363）の統合・ナビ配線（#421） | ローカル可（継続） |
| **#421** | admin ux | **部分**（業務構造への再編は未着手）。第 45 wave で AC「既存管理機能を失わない」に反していた `/admin/experience-versions` の**ナビ未登録**を是正し、同種の取りこぼしを検出するメタテストを追加。**残**: 重複ナビの統合（`受付端末`/`受付端末（拠点別）`・`呼び出しルート`/`取次ルート`）は**概念一本化＝仕様判断**、業務構造への再編本体は #419/#420 の後 | 重複統合は要ユーザー確認 / 再編本体はローカル可 |
| **#422** | kiosk ux | **increment 4 完了**（第 24 wave: `useEffectiveConfiguration` で構成取得 7 経路 → `/api/configuration/effective` 1 回取得へ一本化。移行フラグ `effectiveConfiguration`・新経路失敗時は旧経路へ自動フォールバック。19 unit + 5 e2e / 第 25 wave: `useKioskConfiguration`・`useKioskDeviceStatus`・`useExperienceMetrics` へ分離 / 第 28 wave: `renderScreen` の props オブジェクト化 / 第 29 wave: `reception-screens.tsx`・`flow-state.ts` へ分割し **3196 → 1608 行**）。会話中心化の部品は #361/#364 で先行。**残**: 新旧 ExperienceShell の切替・ステッパー最小化・常設要素の 3 領域整理・ConversationTurn への接続 | #419 の後（#420/#421 と並行可だが推奨 Wave は #421 の後） |
| **#423** | nav/e2e | **部分**: e2e 資産は厚い（`tests/e2e/` 40+ spec）。第 46 wave = 管理 API 認可網羅の静的検証 / 第 74 wave = 対象テナント context の安全側フォールバックを e2e 固定 / **第 83 wave = 別実装 TenantSwitcher の表示統合**（意味は統合しない。母集合・未選択の有無・永続化と監査・反映方法が別。重複していたのは表示だけで、`AdminShell` の固定表示と admin 側の単一所属表示が逐語的に同一かつ排他レンダリング＝片方直しても気づけない形だった。両方が同じ `data-testid="tenant-switcher"` だった点も解消）。**第 84 wave = context 優先順位の契約**（`src/domain/tenant/context-scope.ts`。`route > sticky > none`、ただし**どちらも server resolved の許可集合で濾す**＝#419「クライアントが送る識別子は権威にしない」の形。`differsFromSticky` で食い違いを UI へ伝え、route が sticky を書き換えない＝「暗黙の切り替わり」を作らない）。**第 85 wave = 配線**（`resolveViewingContext` が契約の消費者。`/platform/tenants/[tenantId]` でヘッダに「表示中: <名前>」を出し、sticky と別なら「（選択中と別）」を併記。**select は sticky を示し続ける**＝プルダウンの意味を嘘にしない、**route は sticky を書き換えない**）。**残**: 共通コンテキストバー `Platform > Tenant > Site > Kiosk > Version` / platform→admin→preview→kiosk の 10 ステップ横断シナリオ / URL・cookie・server resolved context の優先順位定義 / 越境・失効 context のエラー UX。**意味の一本化（admin にも全テナント横断を出すか等）は仕様判断＝要ユーザー確認** | ローカル可（継続。意味統合は要確認） |
| **#424** | ai loop | **増分 1〜3 完了**（第 78〜80 wave）: `docs/ai-development-loop.md` / Issue・PR テンプレート / **change-risk classifier**（`src/domain/governance/change-risk.ts` = 停止境界 8 種を変更パスから判定する純関数。`scripts/change-risk.ts` が git から集めて `quality-gate.sh` が毎回**報告のみ**で呼ぶ）。**残**: schema diff チェック / 追跡 ID / kill switch・変更量上限 / 定期評価レポート / プロンプト・ツール実行の監査ログ / **元 issue への計測書き戻し**（KPI 実データが要るので稼働環境待ち）。受入条件は 6 件中 0 件が充足 | ローカル可（継続。計測系は稼働環境待ち） |
| **#425** | delivery | **Wave 0 完了**（第 16 wave: `docs/product-integration-plan.md` = Wave 開始/終了条件・占有ファイル・route/API 移行マトリクス・重複概念・暫定 ID・feature flag registry・breaking-change register・rollback playbook・KPI baseline、`docs/adr/README.md` = ADR index）。**残**: Wave 1 以降の各 PR で状態列を更新していく運用（台帳自体の追加作業なし） | 完了 2026-07-27 |
| ~~#426~~ | docs | **クローズ済**（第 78〜79 wave）。作成対象 3 件すべて存在: `docs/product-integration-plan.md`（第 16 wave）/ `docs/adr/README.md`（同）/ `docs/ai-development-loop.md`（第 78 wave）。受入条件「各 PR が基準文書または ADR を参照する」「設計変更時に文書更新を要求する PR チェック項目がある」は PR テンプレートの該当節で充足 | 完了 2026-07-30 |

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
| 24 | 2026-07-27 | #422 increment 1: 端末の構成取得を `EffectiveKioskConfiguration` の 1 回取得へ一本化（移行フラグ配下・自動フォールバック付き）+ ADR 0004 | 本書 + `docs/product-integration-plan.md` §4.1 / §7 / `docs/adr/0004-kiosk-experience-migration-flag.md` |
| 25 | 2026-07-27 | #422 increment 2: 構成取得 / 環境監視 / 体験メトリクスを `KioskFlow` からフックへ分離（挙動不変・e2e 177/177 で固定） | 本書 |
| 26 | 2026-07-27 | #420 increment 5: 端末が読み込んだ版を heartbeat で報告（反映状況画面が全台 `pending` だった片肺を解消） | 本書 |
| 27 | 2026-07-27 | #420 increment 6: 端末が構成を定期再取得し、**受付進行中は適用を保留**して次セッションから新版を使う | 本書 |
| 28 | 2026-07-27 | #422 increment 3: `renderScreen` の 29 位置引数を props オブジェクト化 | 本書 |
| 29 | 2026-07-27 | #422 increment 4: `reception-screens.tsx`（画面 1487 行）と `flow-state.ts`（状態機械 88 行）へ分割。`KioskFlow.tsx` 3196 → 1608 行 | 本書 |
| 30 | 2026-07-27 | #419: `kiosk-dev` 固定値をクライアントから除去。**死活記録・版報告・失効検知が実端末で初めて機能するようになった**（従来は全て seed 端末の設定を見ていた） | 本書 |
| 31 | 2026-07-27 | #427 マージ（体験設計の正本）+ #420 実検証チェッカ（asset / motion_mapping / language_fallback） | 本書 |
| 32 | 2026-07-27 | #420 取次到達性の公開前検証（**実行時が使う `RoutingPolicy` 側**を検査。port 注入で domain は純関数のまま） | 本書 |
| 33 | 2026-07-27 | #363 統合方針を ADR 0005 で確定 + 台帳 §5/§6/§9 B-07 へ登録（**実施は要ユーザー承認**） | `docs/adr/0005-...md` |
| 34 | 2026-07-27 | #422 の前提整備: Journey / 状態モデルと実装の差分洗い出し + 対応表の機械検証 | `docs/experience/state-mapping.md` |
| 35 | 2026-07-27 | #322 の残り: 担当者検索の 0 件計測を端末 → サーバ → KPI 集計 → 管理画面まで繋ぐ | 本書 |
| 36 | 2026-07-27 | 通信断とサーバ失敗を同じ「呼び出しに失敗しました」で伝えていた件を是正（`failureReason`。状態は増やさない） | `docs/experience/state-mapping.md` |
| 37 | 2026-07-27 | **差分 B を決着**（状態を 1 つも増やさず）。第 34 wave の誤判定を訂正: `visitor_detected` / `recognizing` / `choosing_method` は**3 つとも元から実装済み**だった。未登録語彙を検出するメタテストを追加 | `docs/experience/state-mapping.md` |
| 38 | 2026-07-27 | #327 follow-up: **常設の逃げ道バーが全画面で日本語固定**だった件を是正（English を選んだ来訪者が受付中ずっと「戻る/最初に戻る」を見ていた）。allowlist のドリフト 2 件も解消 | `scripts/check-cjk-literals.ts` |
| 39 | 2026-07-28 | **カスタム受付フローで逃げ道が消え、行き止まりになっていた**件を是正（#455 レビューが発見）。逃げ道バーを画面分岐の外へ出し、入れ忘れの余地を構造から無くした | `docs/loop-queue.md` |
| 40 | 2026-07-28 | #327 follow-up: **通信断バナー**（失敗時フォールバックの入口）と端末利用不可・カスタムフロー主 CTA を多言語化。`?heartbeatMs=` で通信断表示を E2E から検証できるようにした | `docs/loop-queue.md` |
| 41 | 2026-07-28 | **キューの棚卸し**（文書のみ）。実装済みを「未着手」と書いていた 4 行（#367 / #369〜#372 / #374 / #375）を実コードで訂正。未登録だった #399 / #405 を追加。件数 43 → 42 | `docs/loop-queue.md` |
| 42 | 2026-07-28 | #375 inc1: 招待モデル（発行主体 / 受付対象 / 接続先）の分離を**型と写しだけ先行**（呼び出し元はまだ無い）。1 参照が 3 つの問いに同時に答えている構造を解いた。接続先の語彙は #374 に合わせた | `src/domain/reservation/invitation.ts` |
| 43 | 2026-07-28 | #327 follow-up: **通話中の状態表示**（locale を受け取っていたのにここだけ日本語固定）と**カスタム受付フローの 2 画面**（locale 未受領）を多言語化。allowlist を 3 件縮小 | `scripts/check-cjk-literals.ts` |
| 44 | 2026-07-28 | #327 follow-up: **補助チャットドロワー**を多言語化（担当者検索 0 件時に開く＝来訪者が困っている時に出る画面）。モック LLM の既定応答も対象。allowlist を 3 件縮小し、**来訪者向けの実際の翻訳漏れは解消** | `scripts/check-cjk-literals.ts` |
| 45 | 2026-07-28 | #421 の一部: **第 21 wave で作った `/admin/experience-versions` がどこからも辿れなかった**件を是正。ナビ未登録のルートを検出するメタテストを追加（作る周回と IA を触る周回が別なので規律では抜ける） | `src/components/admin/navigation.ts` |
| 46 | 2026-07-28 | #423 の一部: **管理 API の認可ガード網羅を静的検証**。既存テストはルートを手で列挙しており、新しい admin/platform ルートを足しても気づかない構造だった（認可境界なので影響が重い） | `src/app/api/admin/authz-coverage.test.ts` |
| 47 | 2026-07-28 | **`--full` ゲートを実際に通した**（10 周回 `--pr` だけで回していた手順違反の解消）。postcss の脆弱性（高・既存 override が修正版を塞いでいた）と lighthouse の Chrome 未検出を是正 | `scripts/quality-gate.sh` |
| 48 | 2026-07-28 | dev 依存の脆弱性 3 件を semver 互換で解消（js-yaml / body-parser / brace-expansion の一部）。**brace-expansion の残りは修正版が存在せず、5.x へ寄せると eslint が壊れることを実測**して断念・記録 | `package-lock.json` |
| 49 | 2026-07-28 | セッション・ハンドオフを作成（第 37〜48 wave）。**境界内の作業がほぼ尽きたこと**と、判断待ち 7 件が #418 Wave 4 を塞いでいることを明示 | `docs/handoff-2026-07-28.md` |
| 50 | 2026-07-28 | **ADR 0006**: 体験設計の未定義 2 件を決定（`privacy_blocked` の定義 / QR スキャン＝第 3 の入力手段）。正本・対応表・実装へ反映。挙動は不変 | `docs/adr/0006-experience-state-model-gaps.md` |
| 51 | 2026-07-28 | **ADR 0007**: 差分 C の「確認の統合」を却下（前提が誤り）。ただし**等価性ギャップは別の理由で実在**（差分 C'）。音声の露出面を固定する回帰テストを追加 | `docs/adr/0007-voice-touch-confirmation-boundary.md` |
| 52 | 2026-07-28 | **ADR 0008**: 差分 D は「今は統合しない」。並存コストを実測したら**修正の伝播漏れ**で、実害 1 件（QR 受付が 403/400/その他を「通信に失敗しました」と表示）を是正 | `src/domain/checkin/failure.ts` |
| 53 | 2026-07-28 | #375 inc2: **QR を誰が発行したかがどこにも記録されていなかった**件を是正（レコードにも監査にも無く、`appendAdminAudit` は actor を固定値で書いていた）。加算的・サーバ導出で公開 API は非破壊 | `src/lib/reservation/service.ts` |
| 54 | 2026-07-28 | ハンドオフを第 53 wave まで更新。**判断待ち 7 → 3 件**（4 件を ADR で決着）。新たに**差分 C'（音声だけでは受付を完遂できない）**が要ユーザー確認として浮上 | `docs/handoff-2026-07-28.md` |
| 55 | 2026-07-28 | **Claude Code 環境の整理**（無関係プラグイン 6 件削除 / 本プロジェクト向け 3 件追加）+ **PR ゲートのフック強制**（`gh pr create`=`--pr` / `gh pr merge`=`--full` を green 記録なしでブロック）+ `visual-checks` skill | PR #473 |
| 56 | 2026-07-28 | **`--full` をこのリポジトリで初めて全ステップ green にした**。gitleaks 誤検知 2 件（履歴走査なので `.gitleaksignore` に指紋で受容）/ semgrep 3 件 / VRT ベースライン 7 枚。加えて**無操作オーバーレイ由来の e2e フレークを根治**（`?inactivityMs.<state>=`）。#477 #478 は**実装不要**と判明 | PR #479 |
| 57 | 2026-07-28 | 差分 C' の (a): `inputModes` の宣言を実装されている手段だけに限る（`voice` だけでなく `text` も過剰宣言だった）。(b) 音声入力の実装は要ユーザー確認のまま | PR #481 |
| 58 | 2026-07-29 | #366: リアルタイム基盤の可用性から音声受付の提示可否を決める純ロジック（ADR-005 の判定を実行可能な仕様として先に固定）。**今 deploy しても EC2 は何も起動しない**ことを確認 | PR #483 |
| 59 | 2026-07-29 | #369: マイク入力 → 送出チャンクの変換（Float32→PCM16 / ダウンサンプル / 20ms チャンク化）。ADR・token API・4段検証・backpressure は**既に充足済み**だった | PR #484 |
| 60 | 2026-07-29 | #363: デモ用途の版を**指定端末にだけ**配る（ADR 0005 手順 1 = additive）。デモ版を publish すると本番端末の配信先が消えるため draft のまま配る | PR #485 |
| 61 | 2026-07-29 | #422 地ならし: 逃げ道アクションの判断を契約へ一本化（二重実装 + `confirming` の食い違いを解消） | PR #486 |
| 62 | 2026-07-29 | #422 inc5-a: 既定 answers / message を画面の実挙動に一致させる。**未消費 6 導出のうち調べた 4 つすべてで乖離**（うち 1 件は存在しない CTA を返す構造的乖離） | PR #487 |
| 63 | 2026-07-29 | #422 inc5-b 地ならし: 残る 3 導出を実挙動へ突き合わせ。`gazeTarget` の乖離 2 件と `answers` の取りこぼし 1 件（**通信断で果たせない約束の CTA**）を修正。`deriveAvatarEmotion` / `requiresExplicitConfirmationFor` は値が正しく、縛るテストのみ追加 | PR #489 |
| 64 | 2026-07-29 | #422 inc5-b 増分 1: 5 画面の主指示（`screen__title`）を契約経由へ配線。契約 `MessageKey` → i18n キーの対応が**テストの中にしか無かった**のを本番経路へ出した（`conversation-turn.ts`）。文言は不変 | PR #490 |
| 65 | 2026-07-29 | #422 inc5-b 増分 2: 単一 CTA 3 画面（確認 / 失敗・未応答 / 通話中）を `turnAnswersFor` 経由へ。**「通信断では代替導線を出さない」判断の二重実装を解消**（画面から `shouldOfferAlternativeContact` が消えた）。ラベル・testId は不変 | PR #492 |
| 66 | 2026-07-29 | #422 inc5-b 増分 3a: 用件カードを契約経由へ。**ラベルの二重管理**（契約の生日本語リテラル vs i18n 辞書。ja では一致していたが辞書だけ直すとズレる）を解消し、画面から `RECEPTION_PURPOSES` が消えた | PR #493 |
| 67 | 2026-07-29 | #422 inc5-b 増分 3b: 待機の 5 入口を契約へ統合。**QR 受付は状態機械を進めないので「回答」ではなく「引き渡し」として型で分けた**（嘘の intent で安全不変条件を無意味にしない）。用件の先取りは `presetPurpose`。`quick-actions.ts` から入口の定義が消え、逃げ道だけが残った | PR #494 |
| 68 | 2026-07-29 | #422 inc5-c の設計を固める。**AC 4 つのうち 1 つ（landscape 基準化）は #361 で既に充足**、VRM も表情は適用済みで残るのは `gazeTarget` だけと判明しスコープが絞れた | PR #495 |
| 69 | 2026-07-29 | #422 inc5-c 増分 1: ステッパー廃止 + 字幕へ位置づけを織り込み（3 状態 × 5 locale）。**VRT が退行を検出** — ステッパーは右上の常設ボタンと本文の緩衝帯も兼ねており、撤去で見出しが潜った。`.screen-anim > .screen__title` に余白を確保 | PR #496 |
| 70 | 2026-07-29 | #422 inc5-c 増分 2: 常設要素 7 件の領域帰属を登録簿化（案内 2 / ヘルプ 5）。`persistentRegionProps` が testId と領域を同時に供給し、描画側が手書きで迂回できない形にした。e2e で実 DOM と突き合わせ（登録簿だけあってズレていれば無意味なので消費者を置く）。見た目は不変 | PR #497 |
| 71 | 2026-07-29 | #422 inc5-c 増分 3: `gazeTarget` を VRM 頭部オフセットへ適用。**レイアウトで向く方向が変わる**（横向きは右レール、縦向きは真下）ので `gazeOffsetFor(target, layout)` が両方を取る。既存ポーズへ加算するので呼吸・頷きは失われない。**契約の消費者ゼロ導出が無くなった** | PR #498 |
| 72 | 2026-07-29 | #422 AC「VRT で主要状態を固定」のギャップを埋める: 結果系 4 状態（通話中・未応答・失敗・代替案内）を追加し 5 → 9 状態へ。**通話中はパネルごと mask して VRT を無意味にしかけた** — PII は本文の担当者名だけなので `.result-panel__message` へ絞った。**#422 の受入条件 7 件がすべて充足** | PR #499 |
| 73 | 2026-07-29 | #500: 常設要素の「いつ出すか」を `isPersistentVisible(key, state)` へ一本化。逃げ道・チャットは既存導出へ委譲し二重定義を作らない。**実際に移せた分岐は `CheckoutLink` の 1 箇所だけ**だったが、これまで構造に埋もれていた「言語切替・退館は待機のみ」が明示され、契約の主張を実 DOM と突き合わせる e2e が付いた | PR #502 |
| 75 | 2026-07-30 | #501: 管理画面が受付端末向けサイズ（`--font-body` 20px 等）を継承する #330 item4 の根治。**色ではなくサイズが問題**（色は意図的に共通で、分離すると二重管理になるだけ）。`:root` は受付端末向けに据え置き、`[data-area='admin'\|platform']` が下げる**方向が重要** — 逆にすると mobile の text autosizing で `rem` 基準（html の font-size）自体が動き kiosk の実寸が変わる（実測 16px→20px。VRT が 3 度検出） | PR #504 |
| 91 | 2026-07-31 | `kiosk-checkin-subtitle-i18n:47` の flaky を `systematic-debugging` で追った。**根因は未特定のまま、次に起きたら診断できる状態にして止めた**（当て推量の修正をしない）。棄却した仮説: 「headless にカメラが無く `CameraQrScanner.start` が `camera_denied` で即座に `scanning` から抜ける」→ **実測で棄却**（camera-grant の 1.5s 後に 5 回とも `scanning=1 / cameraError=0`。headless Chromium でも getUserMedia は成功し `scanning` は安定状態）。ローカル 12 連射でも 0/12 で再現せず（唯一の失敗は fixture の `/api/admin/login` ECONNRESET＝既知の別件）。調査を止めていたのは**失敗メッセージが `element(s) not found` だけで、実際どの状態に居たか分からない**こと。`checkin-shell` の `data-checkin-state`（実装済み・テストが見ていなかった）を先に表明させ、失敗時に `Expected: "scanning" / Received: "..."` が出るようにした。あわせて `kiosk-checkin.spec.ts` の「mock scanner 起動中」という**事実に反する注記 2 箇所**を訂正（e2e は scanner を注入しておらず実 CameraQrScanner が動く） | PR #521 |
| 90 | 2026-07-30 | #424「API schema の diff チェック」。`change-risk` は「公開 API のパスを触った」ことは見るが**何が消えたか**は見ない。実際に壊れるのは削除・改名で、しかも**壊れる相手はリポジトリの外**（配布済みの受付端末が `/api/kiosk/*` を叩き続ける。同一リポジトリ内の呼び出し元は typecheck が捕まえるが端末は捕まえない）。170 経路のスナップショット（`docs/api-surface.txt`）と突き合わせ、**削除・改名で落ちる**。追加と削除を分けて報告するのが要点で、「スナップショットが違う」とだけ言うと更新が全部同じ重みになり破壊的変更がレビューで埋もれる。**走査が空を返したら落ちるトリップワイヤ付き**（0 本なら常に「差分なし」で通る検査になる）。動的セグメントは `[]` へ正規化（変数名の変更は URL 形状を変えないので差分にしない）。**config の schema diff は見送り** — 単一の宣言的定義が無く、作るなら定義の一元化が先 | PR #520 |
| 89 | 2026-07-30 | #424 増分 4: **kill switch と 1 周回の変更量**。**止める資格が違うので扱いを分けた** — kill switch（`.loop-halt` / env）は人間の明示操作で偽陽性が原理的に無いので**その場で abort**（実測 4.9s。`step` でサマリに FAIL を積むだけだと残りを走り切ってしまい「10 分使う前に止める」目的を果たさない。abort なので green 記録にも到達せず PR / マージも通らない）。**変更量は報告のみ** — 大きい変更が自動的に悪いわけではなく、FAIL にすると override が習慣化して増分 3 で避けた「赤を無視する習慣」を作る。目安 40 ファイル / 1500 行は**通常の周回では鳴らない水準**（暴走の検出であって大きさの禁止ではない）。超過時は PR 本文に分割しない理由を書く欄を用意。`.loop-halt` は gitignore（コミットすると全員のゲートが止まる）。**コスト上限は積み残し** — 1 周回のコストを観測する経路が無い（§8 の計測書き戻しと同根） | PR #519 |
| 88 | 2026-07-30 | #423「developer ロール時のみ platform への切替導線を表示」。**admin ⇄ platform を行き来する UI がどこにも無く**、developer は URL 直打ちしか手段が無かった（ヘッダは `テナント管理` / `プラットフォーム運用` と**現在地を書くだけ**）。`resolveAreaSwitch` は方向で条件を変える — admin → platform は developer のみ、**platform → admin は無条件**（platform に居る時点で developer が保証され、developer は admin にも入れる。戻り導線に条件を付けると判定ミスが**戻れない画面**を生む）。**導線は認可ではない**ので、非表示が保護でないことを e2e で明示（非 developer が URL 直打ち → `/admin` へ戻される）。肯定/否定を**別サーバで両側固定**した — 片側だけだと「常に出る」実装でも「常に出ない」実装でも通る | PR #518 |
| 87 | 2026-07-30 | **platform e2e を実効させた**（候補 1・A 案採用）。`platform-developer` project + 2 本目の Next サーバ（`PORT+1` / `OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer`）で developer をそのプロセスに閉じる。**実測 299s → 310s（+10s / +3.5%）** — 懸念していた「起動 ~60s」ではなく、project 間に依存を張らないので並行で吸収される。**走らせた瞬間に第 85 wave の配線の欠陥が出た**: 一覧 → 詳細は `next/link` のクライアント遷移で、**App Router は共有 layout を再レンダリングしない**ため server layout から prop で渡していた pathname が stale になり、「表示中」はハードロード時しか出ていなかった（純関数は正しく、unit では検出不能）。`usePathname` へ移し静的メタテストで固定。あわせて「platform 主要画面」のスクショを分離し、**撮る前に居場所を表明**させた（それまで admin を `platform-*.png` として撮り続けていた） | PR #517 |
| 86 | 2026-07-30 | 候補 1 の AC マッピング（文書のみ）。**第 85 wave の自分の引き継ぎに誤り 2 件**を発見して訂正: (a) developer セッションは **helper では張れない**（`passwordRole` はプロセス env・email allowlist は password セッションに適用不可）→ サーバを分けるしかない。(b) 走り出すのは **4 本ではなく 3 本**（2 件目のテナントを作る API が無い＝第 74 wave の制約が有効）。実現手段（project + webServer 分離）と、A（既定 config・腐らないが重い）/ B（専用 config・軽いが腐る）の選択、および**まず `--full` の伸びを実測する**ことをキューへ記録 | `docs/loop-queue.md` |
| 85 | 2026-07-30 | #423 の配線: platform ヘッダに「表示中テナント」を出し、契約の消費者ゼロを解消（`resolveViewingContext`）。**sticky 未選択でも URL がテナントを名指ししていれば出す** — ここを `differsFromSticky` だけで判断すると「全テナント横断」と表示しながら 1 テナントの詳細を見ている状態が残る。**e2e で既存の blind spot を発見**: platform は developer 専用で `loginAsAdmin` は developer にならないため `/platform/*` は `/admin` へリダイレクトされる。`capture-screens.spec.ts` の「platform 主要画面」は撮るだけで検証しないので**ずっと admin を撮っていた**。新規 e2e は到達不能時に理由付き skip（消して腐らせない） | `src/lib/platform/selected-tenant.ts` |
| 84 | 2026-07-30 | #423 の一部: **context 優先順位の契約**を固めた。着手時に**実害を特定** — platform のヘッダは Cookie の選択を出すが `/platform/tenants/[tenantId]` の本文は URL のテナントを出すので、**ヘッダが本文と別のテナント（または「全テナント横断」）を示し得る**。`resolveContextScope` は `route > sticky > none` で解決し、**両方を server resolved の許可集合で濾す**（#419 の教訓）。`differsFromSticky` を返して UI が食い違いを明示できるようにし、route は sticky を書き換えない（#423 AC「画面移動で対象が暗黙に切り替わらない」）。**意図的に未配線** — 配線＝食い違い時に何を表示するかは UX 判断なので要ユーザー確認 | `src/domain/tenant/context-scope.ts` |
| 83 | 2026-07-30 | #423 の一部: **別実装 TenantSwitcher の表示を統合**。admin と platform は母集合（actor の accessibleTenants vs developer 専用 API）・未選択の有無（admin は常に 1 つ / platform は「全テナント横断」）・永続化（server action vs **監査に残す API**）・反映（`router.refresh()` vs フルリロード）がすべて違い、**素朴に一本化すると壊れる**（第 33 wave の「別語彙で完結した並行実装 ≠ 壊れた実装」）。実際の重複は表示だけで、`AdminShell` の固定表示と admin の単一所属表示が testid・inline style・文言まで逐語的に同一、しかも**排他レンダリングなので片方を直しても気づけない**形だった。あわせて**両方が同じ `tenant-switcher` testid** だったのを分離（意味の違う 2 つに同じ selector が当たると、片方向けの e2e がもう片方に当たって通る）。再発防止の静的メタテスト付き | `docs/loop-queue.md` |
| 82 | 2026-07-30 | 定期全体チェックの棚卸し。**「計画が未整備」は自分が同一セッションで作った stale だった** — #318 はクローズ済みで `docs/quality-gate.md` に方式・記録形式・FAIL 時の重大度・ツール追従・SKIP=FAIL まで文書化済み。実際に欠けているのは**実行**（`gate-runs.md` の実記録が 0 件。Routine 作成は文書が明記するとおりユーザー判断）。ループ側の実バグを 1 件修正: **定期実行が文書のみのブランチで走ると回すべきステップを省略していた** → `--strict` が scope 省略を無効化（`effectiveScope`。倒す方向は docs→code の一方通行） | `docs/quality-gate.md` |
| 81 | 2026-07-30 | **開発速度の施策**（ユーザー承認済み）。`--full` 実測 598s の内訳を取り、**文書のみの周回で build/e2e/lighthouse/sast を省略**（ソースを入力に取るので入力が変わらない）= **598s → 152s**。判定は純関数 `change-scope.ts`（allowlist の補集合で厳しい方へ倒す。未知のファイルは自動で全ステップ実行へ。変更ゼロも code）。**typecheck/lint/unit/secrets は docs でも回す**＝判定器のバグに対するトリップワイヤ。有効性の担保は指紋側なので省略はそのツリー限り。あわせて読み取り専用コマンドを共有 allowlist へ（安全判定モデル停止時に `rg` が無く 30 分止まった）、内側ループは `npx vitest run <path>`（0.3s / `npm test` は 95s）、署名は 1Password アンロック依頼より先に ssh-agent の生存確認、を明文化 | `docs/quality-gate.md` |
| 80 | 2026-07-30 | #424 増分 3: **停止境界の機械判定**。`CLAUDE.md` と rules が列挙する「人間承認が必要な変更」8 種を、これまで人間/AI が覚えて手で判定していた。変更パスから導出する純関数 + git 収集 CLI + ゲートへの報告ステップ。**偽陽性に倒す**（偽陽性は人が一目で流せるが偽陰性は境界を素通りさせる）。**ゲートを FAIL させない**のも意図的で、偽陽性で赤くすると赤を無視する習慣がつく。検証: #506（実際に承認を取った変更）で発火し、文書 PR では発火しない。**ドッグフーディングで偽陽性を 1 件つぶした** — npm script を足しただけで「新規依存」が出たので、依存木が動いたかは lockfile で判定するよう変更 | `docs/loop-queue.md` |
| 79 | 2026-07-30 | #424 増分 2 / #426 クローズ: Issue テンプレート 2 種と PR テンプレート拡充。AI 提案側は **observation（出どころ付き）/ hypothesis / 反証条件**を必須欄にした（反証条件が埋まらない提案は検証ではなく思い込みになる）。PR 側は仮説・計測・ロールバック・基準文書 ADR 参照・人間承認が必要な変更を追加し、**VRT は閾値内でも実物を見た**というチェック項目も入れた（第 77 wave で実際に隠れた）。#426 は受入条件 3 件を充足しクローズ | `docs/loop-queue.md` |
| 78 | 2026-07-30 | #424 増分 1 / #426: `docs/ai-development-loop.md` を新設。10 フェーズを**実在する仕組みへ写像**し、fitness functions（認可網羅・ナビ未登録検出・journey-map・server-only・CJK リテラル・契約と表示の一致・常設要素 3 領域・locale 網羅）を棚卸しした。**理想を現状として書かない**ため受入条件 6 件を「充足 0 件」として §9 に明記。検証中に自分の記述 2 件が誤りと判明（ZAP は `--full` に無く `url-quality-gate.sh` 側 / 台帳の節番号）。**文書も参照されなければ消費者ゼロと同じ**なので `CLAUDE.md` と `loop-workflow.md` から導線を張った | `docs/loop-queue.md` |
| 77 | 2026-07-30 | #361 AC2: **QR 受付の逃げ道を常設バーへ一本化**（ユーザー承認済み）。各ターンが `CANCEL`/`exit` を手書きし契約の `checkinEscapeHatchesFor` は消費者ゼロだった。契約を後退のみ（`RESET` 1 語）に絞り、`CHOOSE_MANUAL`/`USE_MANUAL` は「別レールへの前進」としてコンテンツ主 CTA へ残す（#325 が `useFallback` をバーから外したのと同じ判断）。バー実装は `EscapeBar` として受付と共有＝2 つ持たせない。**QR の idle でもバーを出す**（kiosk 待機から降りた 1 つ下なので戻る先が実在）。**VRT が本物の退行を捕まえた** — バーは `sticky bottom` 前提なので行 flex の子にすると右側の縦カラムになり「見やすさ設定」に重なる。しかも初回は `maxDiffPixelRatio: 0.02` に隠れて **pass していた**（閾値内でも実物を見ること） | `docs/loop-queue.md` |
| 76 | 2026-07-30 | #361 AC2: **QR 受付のアバター字幕だけが日本語固定**だった件を是正。`CheckinShell` は見出し・リードを `makeT(locale)` で訳していたのに、字幕は契約の ja 既定文言をそのまま渡していた（English を選んだ来訪者は英語の見出しの隣で日本語の字幕を読む）。`checkinSubtitleFor` を component 層に置き 16 ターン × 4 言語を解決。**override は speech/subtitle/fallbackText を同時に置き換える**ので読み上げも直る。あわせて #361 の AC を再マッピングし、キューの「`ConversationTurnView` 不在」が stale だったのを訂正 | `docs/loop-queue.md` |
| 74 | 2026-07-29 | #423 の一部: 対象テナント context の安全側フォールバック（存在しない id / 壊れた値 / 画面移動）を e2e で固定。純関数 `resolveActiveTenantId` は unit 済みだが**cookie → server 解決 → 画面表示の経路が未検証**だった。テナント作成 API が無いため実テナント間の越境 e2e は不可 | PR #503 |


**次に着手する候補（2026-07-30 更新・第 87 wave 消化後）**

> **候補 1「platform e2e を実効させる」は第 87 wave で完了。** A 案（既定 config に project +
> 2 本目の webServer）を採用。決め手は実測で、**+10s / +3.5% しか伸びない**（依存を張らないので
> 2 本目の起動は並行で吸収される）。方式は `docs/quality-gate.md`「`platform-developer` が
> 別サーバな理由」を正本とする。
>
> 残っている制約: **`platform-viewing-context.spec.ts` の 4 本目（sticky と別テナント）はまだ
> skip**。2 件目のテナントを作る API が無い（`src/app/api/platform/tenants/` に POST 無し・
> `createTenant` は repository 層のみ、seed は `internal` の 1 件）。第 74 wave の
> 「テナント作成 API が無いため実テナント間の越境 e2e は不可」が引き続き有効で、
> **#423 の「越境 context のエラー UX」も同じ壁の向こう**にある。テナント作成 API は
> platform の write ＝ JIT 昇格・監査を伴う設計判断なので、着手するなら要ユーザー確認。

> **❌「`Site > Kiosk > Version` を context 契約へ揃える」は前提が成立しない**（第 88 wave の
> AC マッピングで判明。**この行は分類 stale の 6 例目**）。`resolveContextScope` と同じ形
> （route > sticky、権威で濾す）を site/kiosk へ広げようとしたが、**route 層も sticky 層も
> 存在しない**:
> - `/admin` 配下に**動的セグメントが 1 つも無い**（`/admin/sites/[siteId]`・
>   `/admin/devices/[deviceId]` などは無く、全ページが平坦な一覧/管理画面）。
> - site/kiosk の sticky Cookie も無い。`DevicesManager` の `siteId` は**ローカル React state**
>   で、画面を跨ぐと消える（一覧フィルタを URL へ載せる `use-query-params`(#94) も使っていない）。
>
> いま契約だけ作れば**消費者ゼロの契約**になる（本書が繰り返し警告してきた形）。先に要るのは
> 「site/kiosk を画面を跨いで保持する対象にするのか」という IA 判断で、それは **#421 の
> テナント→拠点→端末→受付体験の再編そのもの**。順序は #421 → context 契約。

0. **`kiosk-checkin-subtitle-i18n:47` の根因（未解決・第 91 wave で計装だけ入れた）。**
   次に `--full` で再発したら、失敗メッセージが**実際の状態を名指しする**のでそこから再開する。
   棄却済みの仮説（カメラ失敗で scanning から抜ける）を再度立てないこと — 実測で否定済み。
   残る候補: 隣接する `camera-grant` / `camera-deny` の押し間違い（レイアウトシフト）、
   何らかの理由で `CAMERA_GRANTED` が dispatch されない、無操作リセット（60s なので考えにくい）。
1. **#421 admin IA 再編**（重複ナビの統合＝概念一本化は要ユーザー確認なので除く）。
   ここで site/kiosk が「画面を跨ぐ対象」になって初めて context 契約に意味が出る。
   **第 87 wave の教訓を必ず持ち込む**: 共有 layout の props はクライアント遷移で更新されない。
   context の解決はクライアント側（`usePathname`）か、遷移ごとに再評価される経路で行う。
2. **#424 の残り**（増分 4 = kill switch / 変更量は第 89 wave で完了）。残るチェックリストは
   config・API schema の diff チェック / 追跡 ID / 定期評価レポート生成 / プロンプト・ツール実行の
   監査ログ / **1 周回のコスト上限**（コストを観測する経路が無く、§8 の計測書き戻しと同根）。
   棚卸しは `docs/ai-development-loop.md` §9 にあるので**再調査不要**。
3. **#423 の残チェックリスト**（依存が軽い順）:
   - platform のテナント詳細 → そのテナントの admin へ遷移。**admin の選択中テナントを書き換える
     かが論点**（#423 AC「画面移動で対象が暗黙に切り替わらない」と正面から当たる）。要設計。
   - admin の拠点・端末詳細 → draft/published プレビュー、および preview からの復路（#420 依存）。
   - AC「視覚回帰は iPad landscape と **desktop admin** を対象にする」… **未充足**。現状 VRT は
     kiosk のみ（`kiosk-vrt-a11y` / `kiosk-screenshot`）で admin の baseline は 1 枚も無い。

**ユーザー操作待ち（継続）**: 週次 Routine の作成。`docs/gate-runs.md` の実記録は 0 件で定期実行が一度も回っていない。方式・記録形式・FAIL 時の重大度は `docs/quality-gate.md`「定期運用（#318）」に完全に文書化済みで、同節が自動作成を禁じている。**これが設定されるまで scope 省略の担保はトリップワイヤのみ。**

**旧・次に着手する候補（2026-07-27 更新・第 37 wave 消化後）**: **差分 B は決着済み**
（`docs/experience/state-mapping.md` §5 B の表）。第 35〜37 wave で 6 項目すべてを処理し、
**体験状態は 1 つも増やさずに済んだ**（3 つは元から実装済み、2 つは計測配線と文言分岐で解決、
1 つは README の定義待ち）。残る未対応は `no_match`（計測は通っているので状態化不要）と
`privacy_blocked`（**README に定義文が無く判断できない = 要ユーザー確認**）の 2 つ。
残る差分は **C（音声とタッチの確認を 1 状態機械へ）と D（QR 受付の統合）だけで、
どちらも仕様判断＝要ユーザー確認**。よって体験設計まわりで境界内に残る作業は無い。

> **#327 はクローズ済み**（2026-07-12・`state_reason: completed`）。第 38 wave の
> `/issue-ac-mapping` で判明。本書と handoff が「次は #327 の i18n 移行」を第一候補に
> していたのは stale な分類だった。ただし**受入条件は満たしきれていなかった**ので、
> follow-up として第 38 wave で常設逃げ道バーの i18n 化を実施した（下記）。

**旧・次に着手する候補（第 29 wave 時点）**: **#422 increment 5 = 新旧
ExperienceShell の切替**（移行フラグは ADR 0004 のとおり構成取得とは**別キー**にする）、または
**#419 の `kiosk-dev` 除去**。台帳 §9 B-03〜B-05 は移行フラグの既定を新経路へ倒して
観測してから。#420 の残り（実検証チェッカ・デモ公開モデルの統合）はいつでも着手可。
代替候補: #421 admin IA 再編（`/admin/experience-versions` のナビ配線を含む）／
**グローバルストアのテナント対応**（永続キー変更 = スキーマ破壊なので **要ユーザー確認**）／
#423 横断 E2E ／ AI Evolution epic 群(#382〜#392)。
エピック群の優先順位はユーザー判断（現在地の注記参照）。

## 落とし穴（着手前に必読）

- **#366 は本プロジェクト初の実質的な固定費**。EC2 t4g + Route 53 + EBS + CloudWatch を
  8:00–23:00 常時稼働させる。現状 open-reception の AWS 実績は**月 $0.0005**（2026-07 実測、
  dev のみ・ほぼ無料枠内）なので、コスト構造が質的に変わる。CLAUDE.md の重大変更条件に
  該当 → **Phase 0 ADR で Budget 見積を出して承認を取ってから CDK を書く**。
- ~~#361 は既存の意図的設計の反転~~ → **決着済み**（#361 クローズ・2026-07-30）。選択/入力画面でもアバターを出す判断は `deriveAvatarPresence` の `companion` として契約に入り、`avatar-companion.test.ts` もその前提で書き換わっている。
- ~~#375 の token hash 化~~ → **第 13 wave で消化済み**（SHA-256 + timingSafeEqual）。
  残るのは DynamoDB 永続化（#97 inc3）時の一括移行と pepper 確定。
- **VRT を別 project へ移すと baseline が孤立する**（第 23 wave で実際に踏んだ）。スナップショット名は
  既定で project 名を含むため、その場の描画が新 baseline として自動生成され、退行がそのまま
  「正」として焼き付く。`snapshotPathTemplate` で解決先を固定すること。
- **e2e はこのコンテナで動く**（第 22 wave で是正）。「実行不可」という過去の記録は誤りだった。
  UI/a11y に触る変更は `--pr --e2e` を通す。
- **`KioskFlow` の副作用はフックへ出した**（第 25 wave）。設定取得は `useKioskConfiguration`、
  heartbeat は `useKioskDeviceStatus`、体験メトリクスは `useExperienceMetrics` が所有する。
  **これらの state を `KioskFlow` に再び置かない**（分割が巻き戻る）。
- **kiosk 配下の新規ファイルに生 CJK リテラルを置かない**（#327 の機械検証が落ちる）。
  `KioskFlow.tsx` は allowlist 済みなので、未移行の既定文言をフックへ移すと違反になる。
  第 25 wave では待機リードの ja 既定文言を `KioskFlow` 側に残して回避した（移行本体は #327）。
- **区別は「状態を増やす」以外の方法でも付けられる**（第 36 wave）。通信断とサーバ失敗を
  分けるのに `failed` を割らず、`failureReason` を添えて文言だけ変えた。遷移表を増やすと
  逃げ道・timeout・戻るの組み合わせが倍になり、増えた状態ごとに同じ検証が要る。
  **状態を増やす前に「同じ状態の中の説明」で足りないかを見る。**
- **「状態が無い」と「計測できない」は別**（第 35 wave）。差分 B を「Outcome metrics が測れない」と
  一括りにしたが、0 件率は端末側で既に数えており（`searchZeroHitCount`）、欠けていたのは
  サーバへの配線と集計だった。**状態を増やす前に、その指標が本当に状態を要求するのか確かめる。**
- **並行実装は「壊れている」とは限らない**（第 33 wave）。デモ公開は旧 kiosk レジストリと
  旧スコープ語彙（`siteId` にテナント ID）で**一貫して閉じており**、UI の端末候補も同じ母集合なので
  現時点の実害は無い。統合予定の subsystem に互換対応だけを積むと債務が深まるため、
  **その場しのぎの修正はせず方針（ADR 0005）を固定した**。「別語彙で完結した並行実装」と
  「壊れた実装」を区別すること。
- **取次モデルは 2 つ並存している**（第 32 wave に確認）。実際の呼び出しが使うのは
  `RoutingPolicy`/`ContactEndpoint`（#374）で、受付フローの `callRouteId` が指す `CallRoute`（#88）は
  **admin の編集と永続化のみ**（`executeRoutedCall` は参照しない）。「取次が設定できている」ことの
  検査は前者で行う。台帳 §5 に重複概念として登録した。
- **検証の severity は「実行時に本当に壊れるか」で決める**（第 31 wave）。`language_fallback` は
  当初 error にしたが、`sanitizeLanguageSettings` が実行時に必ず補正するため端末は壊れない。
  壊れないもので公開を止めると運用が理由なく止まる → 全て warning へ直した。逆に http: アセットは
  混在コンテンツでブラウザにブロックされ**黙って表示されない**ので error のまま。
  **常に鳴る警告も作らない**（アバター未使用の拠点で毎回モーション警告が出る形だったので、
  アバター設定済みの拠点だけに絞った）。
- **`kiosk-dev` 固定値は「動いているように見えて実は無効」の典型だった**（第 30 wave）。
  クライアントが `?kioskId=kiosk-dev` を送り、実エンロール端末（ランダム UUID）のセッションと
  食い違うため、**死活記録も版報告も丸ごとスキップ**され、有効性は全端末が seed 端末の設定を
  読んでいた（個別の失効が効かず、seed を無効化すると全端末が止まる）。
  **クライアントが送る識別子は権威にしない**（サーバがセッションから解決する）。
- **kiosk コンポーネントを切り出すときは生 CJK リテラルの有無を先に測る**（#327 の検証は
  `KioskFlow.tsx` を allowlist する一方、**新規ファイルは例外なく検査する**）。残る生 CJK は
  13 箇所 / 5 コンポーネント（`KioskAuthorizeView` 4 / `KioskUnenrolledView` 3 /
  `KioskCheckingView` 1 / `EscapeHatchBar` 1 / `CustomVisitorInfoView` 1 / `KioskFlow` 本体 2）で、
  **これらは端末ゲート系＝ KioskFlow に残す側**。受付ジャーニー画面は全て i18n 済みで、
  第 29 wave でそのまま切り出せた。allowlist を広げて回避しないこと。
  > 第 28 wave は「`renderScreen` が `CustomVisitorInfoView` を参照するので分割は #327 待ち」と
  > 記録したが**誤り**だった（参照関係を確認せず仮定した）。実際には `renderScreen` の参照先は
  > 全て i18n 済みで、依存は無かった。**「依存がある」と書くときは参照を実際に引くこと。**
- **`--full` を実際に通す**（第 47 wave）。CLAUDE.md は「マージ前は `--full`」を要求しているが、
  第 37〜46 wave は `--pr` だけで 10 本マージしていた。通してみたら **2 件 FAIL** した:
  postcss の高危険度脆弱性（**既存の override `>=8.5.10` が修正版 8.5.18+ の解決を塞いでいた**）と、
  lighthouse の Chrome 未検出。**重いゲートは「重いから後で」で飛ばすと、飛ばしている間に
  実際に赤くなる。**
- **`brace-expansion` の残存脆弱性は現状「直せない」**（第 48 wave に実測）。advisory の対象は
  `<=5.0.7` で、**2.x 系には修正版が存在しない**（最新 2.1.2 も対象内）。唯一の修正版 5.0.8 へ
  override で寄せると、**エクスポート形が変わっていて `minimatch`（CJS）が
  `TypeError: expand is not a function` で落ち、eslint が起動しなくなる**。
  経路は `@opennextjs/aws` → `@node-minify/core` → `glob@9` → `minimatch@8` と
  `typescript-eslint` で、いずれも **dev 依存**（ゲートの `npm audit --omit=dev` は 0 件）。
  上流が 2.x 系へ patch を出すか、`minimatch` が 5.x 対応するまで待つ。**再挑戦するなら
  まず `npx eslint .` を回すこと**（install だけでは壊れていることに気づけない）。
- **バージョン固定の override は、あとで脆弱性修正を塞ぐ**（第 47 wave）。`overrides` は
  脆弱性対応で足すことが多いが、レンジの下限を固定したまま放置すると**次の脆弱性修正が
  入らない**。`npm audit` が override 済みパッケージを指したら、まず override 自体を疑う。
- **「網羅」を手で列挙したリストで担保しない**（第 44〜46 wave で 3 回踏んだ）。CJK allowlist・
  admin ナビ・認可ガードのいずれも、対象を手で並べたリストで管理しており、**新しいものを
  足しても誰も気づかない**構造だった。共通の対処は同じで、**実体（ファイル・ルート・語彙）を
  走査して、登録済みか理由付きの除外かのどちらかを強制する**メタテストを置くこと。
  除外理由の長さも検査する（空文字や「同上」で誤魔化せなくする）。
- **生 CJK の件数を「翻訳漏れ」の指標にしない**（第 42 wave）。訳し終えた module にも ja の
  訳文は残るので、件数は減らない。`avatar/guidance.ts` の 36 箇所は **5 ロケール × 全 9
  AvatarState を完備した上での ja + やさしい日本語の原稿**で、漏れではなかった
  （第 40 wave は件数だけを見て「来訪者向けの最大の翻訳漏れ」と書いた＝誤り）。
  **判定は「その module が `locale` を受け取っているか」で行う**。受け取っていなければ
  選んだ言語に関わらず日本語が出る＝実際の漏れ。`grep -c 'locale\|makeT\|Locale' <file>` が
  0 のものを探すこと。
- **「実装に無い」と書く前に、その語を実際に grep する**（第 37 wave。第 28 wave と同種の誤り）。
  第 34 wave の差分表は実装の状態語彙を `ReceptionState` / `KioskMode` / `VoiceKioskMode` の
  3 系統と仮定したため、`visitor_detected` / `recognizing` / `choosing_method` を「状態語彙に
  無い」と誤判定した。実際には `PresenceState`（独立した状態機械）・`voiceListeningStage()`・
  **`CheckinState.selectingMethod`**（`ui-contract.ts` に `chooseMethod` の文言まである）に在った。
  **前提として立てた「語彙の数」自体を疑うこと**（前提が誤ると派生した判定はまとめて誤る）。
  > **規律では守れなかった**: 第 37 wave はこの落とし穴を書いた当のコミットで、残り 1 件
  > （`choosing_method`）に対して同じ誤りを犯し、独立レビュー（`change-reviewer-opus5`）に
  > 指摘されて発覚した。**「気をつける」で止めず、仕組みで止める**こと。
  対策として `journey-map.test.ts` が `src/domain/**` の状態語彙を**全件走査**し、採録も除外も
  されていない語彙があれば落ちるようにした（表の内側の網羅テストでは「表に載せなかった語彙」を
  検出できない、という第 34 wave の失敗の形をそのまま塞ぐ）。
- **「常設される」前提の UI は、画面分岐の外に置く**（第 39 wave）。逃げ道バーは
  「待機以外の全画面に常設」される前提で設計され、その前提のもとで各画面のコンテンツ側から
  後退ボタンを撤去してある（`VisitorInfoForm` へ `onBack` を渡さない等）。ところが実際には
  既定受付の枝の**中**に置かれていたため、カスタム受付フロー (#100) の 2 画面では逃げ道が
  1 つも出ず、来訪者は 60 秒の無操作リセットを待つしかない**行き止まり**になっていた。
  **コメントが「常設」と書いていても、構造がそれを保証していなければ嘘になる。**
  分岐を増やす人が入れ忘れられない位置（分岐の外側）へ出すこと。
- **独立レビューは「自分が今書いた結論」にこそ効く**（第 37 wave）。自己レビューは自分の前提を
  共有しているため、前提そのものの誤りを見つけられない。**分析の結論を含む変更**は
  `change-reviewer-opus5`（読み取り専用）へ回し、「その語を実際に grep して確かめよ」と
  明示的に指示すると、憶測ではなく事実で返ってくる。
- **構成の「取得」と「適用」を分けて考える**（第 27 wave）。取得は 60 秒ごと（`?configSyncMs=` で
  短縮可）に回るが、**適用は待機（idle）に戻ってから**。受付進行中に差し替えると来訪者の画面が
  操作の途中で入れ替わる。判定は `src/domain/kiosk/configuration-sync.ts`。
  heartbeat で報告するのは**適用済み**の版であって、取得だけして保留中の版ではない。
- **端末の版報告は「内容の指紋を持つ版」だけ送る**（第 26 wave）。版管理未導入の拠点は
  `LIVE_VERSION`（revision 0・指紋なし）で配信されるため、これを報告すると管理側の突き合わせが
  常に不一致になり、正常な端末が「旧版で稼働」として並ぶ。判定は
  `src/domain/kiosk/configuration-report.ts`。
- **構成取得の移行フラグは既定 OFF**（第 24 wave）。`/kiosk?effectiveConfig=1` で新経路、`=0` で
  旧経路。**フラグの既定を倒す前に「新経路で全端末が構成を取れる」ことを観測する**（未エンロール
  端末は新経路が 403 になり、旧経路へ自動フォールバックして初めて構成が揃う）。
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
