# Character-led 統合受付 UX 仕様（画面・会話ターン・遷移）

対象: Issue #361（Epic #360）。実装の真実源は `src/domain/reception/ui-contract.ts`
（`ConversationTurnView` 契約・純関数）と `src/domain/reception/state.ts`（状態機械）。

## 目的

現行 `KioskFlow` は選択・入力画面でアバターを出さず、フォームや QR が独立カードとして進むため、
来訪者から見ると「同じアバターとの対話」が途中で切れる。本仕様は横向き iPad を主対象に、
VRM キャラクターの質問と回答 UI を**同じ会話ターン**として扱う Character-led UX へ再構成する。

- キャラクターが待機→挨拶→質問→復唱→確認→発信→成功/失敗まで一貫して応対する。
- タッチ・音声・文字・QR を同一質問への入力手段として扱う。
- 発信・個人情報送信は必ずタッチ確認を挟む。
- 音声/VRM/STT が失敗してもタッチだけで完走できる。

## 単一の真実源（重要）

表示契約の真実源は `ui-contract.ts` に一本化する。新しい並立した真実源を作らない（#361 AC）。

- 受付状態の所有者は `state.ts`（`ReceptionState` / `transition`）。本契約は screenState から
  **導出するだけ**。
- 会話ターンの提示は `conversationTurnFor(state, overrides?)` が唯一の入口。
  presence/emotion/gazeTarget/message/answers/inputModes/requiresExplicitConfirmation/escapeHatches
  を 1 箇所で導出する。
- 表情語彙（emotion）は `avatar/guidance.ts` の expression と一致させる（`ui-contract.test.ts` が
  cross-check）。モーションキーは `@/domain/motion/types` の `motionKeyForState` を再利用（二重化しない）。
- locale 依存の表示文字列（`displayText` / answers ラベル）は component 層が解決し `overrides` で
  注入する（domain → component への逆依存を避ける）。既定は ja の意味論的短文を内蔵。

## ConversationTurnView

```ts
type ConversationTurnView = {
  stateKey: ReceptionState;
  avatar: {
    presence: 'primary' | 'companion' | 'minimal';
    emotion: AvatarEmotion;      // neutral | happy | relaxed | thinking | concerned
    motionKey: MotionKey;        // #31 motionKeyForState を再利用
    gazeTarget?: GazeTarget;     // answers | form | confirmCta | fallbackCta（none は省略）
  };
  message: {
    semanticKey: MessageKey;     // 画面表示文と発話文が共有する意味論キー
    displayText: string;         // 画面表示文（既定 ja / component が locale 注入可）
    speechText?: string;         // 発話専用文（読み・丁寧表現のため分離可能）
    speak: boolean;              // 通話中(connected)は false: 静かな待機姿勢
  };
  answers: Array<{ id: string; label: string; intent: ReceptionAction }>;
  inputModes: Array<'touch' | 'voice' | 'text' | 'qr'>;  // touch は必ず含む
  requiresExplicitConfirmation: boolean;                 // 発信/個人情報送信で true
  escapeHatches: Array<{ action: ReceptionAction }>;     // back / reset のみ
};
```

### presence（アバターの在り方）— #123 からの意図反転

旧 #123 は「選択/入力画面はコンテンツが密集するためアバターを出さない」とし、
`avatar-companion.test.ts` がその集合を固定していた。#361 は**この意図を意図的に反転**し、
選択/入力/確認/呼び出しでもアバターを会話コンパニオンとして継続させる（重なりは「非表示」では
なく配置で解決する。下記レイアウト方針）。

| presence | 状態 | 意味 |
| --- | --- | --- |
| `primary` | idle | アバターが画面の主役（ヒーロー表示） |
| `companion` | selectingPurpose / selectingTarget / inputVisitorInfo / confirming / calling / failed / timeout / fallback / completed / cancelled | 操作の傍らで対話を継続する付き添い |
| `minimal` | connected | 通話中はキャラクターが発話を止め、静かな待機姿勢へ退く |

## 画面一覧（E-00〜E-10 / Q-01〜Q-02）と会話ターン写像

`stateKey` は `ReceptionState`。QR（Q-01/Q-02）は現状 `src/domain/checkin/state.ts` の別状態機械で、
統合シェルは残 increment（下記）。

| 画面 | stateKey | presence | emotion | gaze | message key | inputModes | 確認必須 | 主な answers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E-00 待機・ウェルカム | idle | primary | happy | answers | welcome | touch, qr | – | （クイックアクション） |
| E-01 用件確認 | selectingPurpose | companion | happy | answers | choosePurpose | touch, voice, text | – | 目的 ×4 (selectPurpose) |
| E-02 音声入力・復唱 | ※ inputVisitorInfo 内の復唱 UI（残 increment） | – | – | – | – | – | – | – |
| E-03 担当者検索 | selectingTarget | companion | neutral | answers | chooseTarget | touch, voice, text | – | 担当者（実行時注入） |
| E-04 部門・窓口検索 | selectingTarget | companion | neutral | answers | chooseTarget | touch, voice, text | – | 部署（実行時注入） |
| E-05 来訪者情報 | inputVisitorInfo | companion | relaxed | form | enterVisitorInfo | touch, voice, text | **要**（送信=submitVisitorInfo） | フォーム送信 |
| E-06 取次内容確認 | confirming | companion | thinking | confirmCta | reviewAndConfirm | touch | **要**（発信=confirm） | この内容で呼ぶ (confirm) |
| E-07 発信中 | calling | companion | relaxed | none | calling | touch | – | – |
| E-08 担当者との通話 | connected | minimal | happy | none | connected | touch | – | 受付を終了 (complete) |
| E-09 担当者が向かっている | connected / fallback | minimal / companion | happy / neutral | none / answers | connected / fallbackGuidance | touch | – | 受付を終了 (complete) |
| E-10 未応答・フォールバック | timeout / failed → fallback | companion | concerned | fallbackCta | apologyTimeout / apologyFailed | touch | – | 別の方法でご連絡 (useFallback) |
| Q-01 QR 読取 | （checkin: qr-scan） | companion | – | – | – | touch, qr | – | 読み取りのみ（発信しない） |
| Q-02 QR 内容確認 | （checkin: qr-confirm） | companion | thinking | confirmCta | reviewAndConfirm | touch | **要** | この内容で呼ぶ |

> 発信（calling へ入る）唯一の経路は `confirming --confirm--> calling`。音声認識結果だけでは
> 発信されない（`REQUIRES_CONFIRMATION_ACTIONS` / `passesConfirmationInvariant` が担保）。

## 画面遷移

```text
KioskMode: signage → attract → reception   （Presence/KioskMode/ReceptionState の責務分離は #362）

ReceptionState:
  idle
   → selectingPurpose
   → selectingTarget
   → inputVisitorInfo
   → confirming        （発信前確認: 必ずタッチ）
   → calling
   → connected / timeout / failed
        timeout/failed → fallback
   → completed
  （どの状態からも RESET → idle。無操作は #125 のカウントダウン付きで idle へ）

QR（統合シェルは残 increment）:
  qr-scan → qr-confirm → calling   （読み取りだけで発信しない）
```

## レイアウト方針

- **横向き iPad（ipad-landscape / large-display）**: 主要ステップ（用件選択・担当者選択・
  来訪者情報・確認）でアバターを**左レール 35%**、会話・操作を**右 65%** に並置する
  （`globals.css` の `[data-kiosk-presence]` / `[data-kiosk-state]` セレクタ）。レールは
  `pointer-events:none` で操作を妨げず、字幕を常時表示する。
- **縦向き iPad（ipad-portrait）**: 既存プロファイルを壊さない。操作が下部に密集するため、
  アバターコンパニオンは従来どおりステータス画面（呼び出し/通話/結果/完了）に控えめ表示し、
  選択/入力での重なりを避ける（`KioskFlow.showAvatarCompanion` のレイアウト別ゲート）。
- 呼び出し中/通話/結果は中央パネル＋左下の控えめ companion のまま（映像パネル等を壊さない）。
- 1 ターン 1 質問。回答候補は原則 2〜4 件。字幕は常時表示。
- 電話番号・Vonage・内部エラーコードは来訪者へ見せない（結果は `result-tone` の抽象トーンのみ）。

## フォールバック（縮退）

- 本契約は純データのため、VRM/TTS/STT を描画/再生できなくても `inputModes` に必ず `touch` を含み、
  `displayText`（字幕相当）でタッチだけで完走できる。
- 通話中（connected）は `speak=false`・`presence=minimal` でアバターが静かになる。

## 残 increment（本 doc 時点で未実装・#361 で継続）

- **QR シェル統一**: `CheckinFlow`（`domain/checkin/state.ts`）を通常受付と同一の画面シェルへ
  統合し、Q-01/Q-02 を `ConversationTurnView` として扱う（`qr-scan → qr-confirm → calling`）。
- **E-02 音声認識の復唱・訂正 UI 統一**: STT 結果の復唱ターンを `speechText` 分離を活かして統一。
- **iPad landscape の Visual Regression / axe テスト**追加。
- **多言語の displayText**: 現状 `conversationTurnFor` の既定は ja。component が guidance の
  多言語字幕を `overrides.message` で注入する結線を全ステップに広げる。
