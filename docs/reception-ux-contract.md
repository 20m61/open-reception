# 受付UX 状態駆動契約（Avatar-led / Touch-first / Chat-assisted）

対象: Issue #120（基盤・純設計）。Epic #119。
実装: `src/domain/reception/ui-contract.ts`（純型 + 純関数 / 副作用なし / PII なし）。

## 役割分担

- **アバター（Avatar-led）**: 受付状態を伝える案内役。挨拶・状態表示・安心感・視線誘導・
  待機/呼び出し中/失敗時の案内。状態の所有者ではなく、`screenState` から導出した
  `avatarState` に従って発話/字幕/モーションを出す。UI 状態と矛盾しない。
- **タッチUI（Touch-first）**: 受付の主導線。目的選択・担当/部署選択・確認・キャンセル・
  フォールバック。主要操作はタッチだけで完了できる。自由文入力を前提にしない。
- **チャットUI（Chat-assisted）**: 主役ではなく補助パネル/ドロワー。メニューにない相談・
  曖昧な入力・候補提示・例外対応・補足説明。**出力は必ず画面上の許可済みアクションに
  変換**し、重要操作は自分で確定しない。

## 単一の真実源

状態の所有者は既存の `src/domain/reception/state.ts`（`ReceptionState` と `transition`）。
本契約はそこから**導出するだけ**で、独自に状態を進めたり矛盾する状態を作らない。

- `availableActions(state)` は state.ts の `transition` を引いて算出する（遷移表を二重定義
  しない）。よって遷移表の変更に自動追従し、矛盾が構造的に起きない。
- `avatarState` / `callStatus` / `privacyState` / `chatAvailability` は `screenState` から
  純関数で導出する全網羅マップ（screenState を増やすと型エラーで漏れを検出）。

## 契約の構成（ReceptionUiContract）

| フィールド | 型 | 由来 |
| --- | --- | --- |
| `screenState` | `ReceptionState` | 真実源（state.ts） |
| `avatarState` | `AvatarState` | `deriveAvatarState(screenState)` |
| `availableActions` | `ReadonlySet<ReceptionAction>` | `availableActions(screenState)`（transition 由来） |
| `callStatus` | `CallStatus` | `deriveCallStatus(screenState)` |
| `privacyState` | `PrivacyState` | `derivePrivacyState(screenState)` |
| `chatAvailability` | `ChatAvailability` | `deriveChatAvailability(screenState)` |
| `chatMessages` | `ChatMessage[]` | UI 層が保持（型のみ定義・PII を長期保持しない） |
| `visitorInput` | `VisitorInputState` | UI 層が保持（PII の値は持たず入力中フラグ/対象のみ） |

`buildUiContract(state, ui?)` で 1 箇所にまとめて導出し、UI 各所が個別再計算してズレるのを防ぐ。

## アクション語彙と許可判定

`ReceptionAction`（`start` / `selectPurpose` / `selectTarget` / `submitVisitorInfo` /
`confirm` / `cancel` / `back` / `useFallback` / `complete` / `reset`）は、`ReceptionEvent` の
うち「来訪者が能動的に起こす操作」だけを抜き出した語彙。`CALL_CONNECTED` 等の外部シグナル
由来イベントは UI アクションに含めない（システム遷移として state.ts が扱う）。

- `isActionAllowed(state, action)`: その画面で許可された操作か（タッチ/チャット共通の入口）。
- `availableActions(state)`: 許可済み操作の集合。

## 重要操作と「確認必須」の不変条件

呼び出し確定（`confirm`）と個人情報確定（`submitVisitorInfo`）は重要操作。自由文だけで
確定させない。

- `confirm` は遷移表上 `confirming -CONFIRM-> calling` のみ。**呼び出し中(calling)へ入る
  唯一の経路が confirming 経由**であることをテストで保証（必ず確認画面を踏む）。
- `submitVisitorInfo` の確定先は `confirming`（個人情報を入れた直後に必ず確認を挟む）。
- `passesConfirmationInvariant(state, action)` がこの不変条件を明示検証する。

## チャット/LLM のアクション制限

`isChatActionAllowed(state, action)` は二段構え:

1. `screenState` で許可されている（`availableActions` に含まれる）。
2. チャット禁止集合 `CHAT_FORBIDDEN_ACTIONS`（`confirm` / `submitVisitorInfo`）に含まれない。

→ チャットは重要操作を**提案（`ChatMessage.suggestedAction`）はできるが確定はできない**。
タッチUIの確認操作へ誘導する役割に限定する。チャット実行可能なアクションは常に
`availableActions` の部分集合（テストで保証）。

## フォールバック / 縮退

音声・カメラ・VRM が使えなくても受付は成立する（Epic #119 のゴール）。本契約は純データの
ため、アバターを描画しない場合でも `availableActions` と `screenState` だけでタッチUIが
完結する。`chatAvailability='unavailable'`（idle/cancelled/completed）ではチャットを閉じる。

## 後続トラックの消費（想定）

- **#121 タッチファースト導線**: `availableActions(state)` を画面のボタン集合の真実源に
  し、`isActionAllowed` でガード。`screenState` ベースで画面分岐。
- **#123 アバター状態同期**: `deriveAvatarState(screenState)` を購読し、発話/字幕/モーションを
  状態に同期（UI と矛盾しない）。
- **#122 Chat-assisted ドロワー**: `deriveChatAvailability` で開閉、`isChatActionAllowed` で
  LLM 出力を許可済みアクションへ変換・ガード、`ChatMessage.suggestedAction` で誘導。
- **#124 レイアウト / #125 a11y・プライバシー**: `privacyState` で PII 入力局面の注意書き、
  `callStatus` で通話局面の表示を出し分け。

## 非対象（このトラックでは触らない）

- `src/components/kiosk/KioskFlow.tsx`（消費/配線は #121/#122/#123）。
- `src/components/admin/navigation.ts` / `src/domain/reception/log.ts` /
  `src/app/admin/audit/page.tsx`。
- 新規外部依存の追加なし。
