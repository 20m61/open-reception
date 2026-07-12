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

## 後退系コントロールの表示位置ポリシー（#325）

`availableActions` は変えない（状態機械・許可判定は不変）。ここで定めるのは「許可済みアクションを
**どこに描画するか**」の表示位置ポリシーで、来訪者が「戻る/キャンセル/最初に戻る/修正する」の違いを
判別できず後退系ボタンが氾濫・二重表示する問題 (#325) を解消する。

- **後退語彙は 2 語に集約**: `back`＝「戻る」（1 ステップ前へ）/ `reset`＝「最初に戻る」（フロー破棄・
  待機へ）。「キャンセル」は実質リセット（フローを破棄して待機へ）なので **`reset` へ統合**し、独立した
  「キャンセル」ボタンは出さない。状態機械の `cancel`（CANCEL 遷移）自体は契約に残す（削除しない）。
- **後退系は逃げ道バー（`kiosk-escape-bar`）へ一本化**: 画面下端に sticky で常時可視。`escapeHatchesFor`
  は `back` / `reset` のうち `availableActions(state)` にあるものだけを出す。コンテンツ内には後退ボタンを
  置かない（`target-back` / `visitor-back` / `result-reset` / `fallback-reset` は撤去済み）。
- **コンテンツ側は前進系（主 CTA）＋文脈固有のみ**:
  - 前進主 CTA の例: `to-confirm`（確認へ）/ `confirm-call`（この内容で呼ぶ）/ `complete`（受付を終了）/
    `use-fallback`（代替の連絡先へ＝`useFallback`。timeout/failed を fallback へ**前進**させる主 CTA なので
    コンテンツ側に置き、バーには出さない）。
  - 文脈固有の例: `confirm-back`（「修正する」）。確認画面は短い要約でフッターが常に到達可能なため、
    バーの `back` は出さず（`STATES_WITH_CONTEXTUAL_BACK`）「修正する」に集約する。
- **不変条件（受け入れ条件）**: どの画面でも同一機能の後退ボタンを 2 個出さない。後退系は最大 2 種
  （戻る / 最初に戻る）＋ 文脈固有 1（修正する）以内。長い画面（`selectingTarget` / `inputVisitorInfo`）でも
  sticky バーの `back` が常時可視なので、コンテンツ内フッターの戻るを撤去しても戻る導線は失われない。

真実源: 表示集合の純ロジックは `src/components/kiosk/quick-actions.ts`（`escapeHatchesFor` /
`STATES_WITH_CONTEXTUAL_BACK`）、ユニットは `quick-actions.test.ts`、E2E は `reception-flow` /
`kiosk-touch-first`。

## 1 画面 1 メッセージ：案内文言の役割分担（#324）

待機画面に「タッチして開始」「ようこそ」「ご用件をお選びください」が字幕・見出し・リードで
重複・二重質問していた問題（#324）を解消するため、各面の**文言の役割**を 1 つに固定する。
同じ面で同種の指示を 2 つ以上出さない（＝指示は 1 系統）。

| スロット | 役割 | 内容の型 | 例（待機画面 idle） |
| --- | --- | --- | --- |
| **アバター字幕**（`avatar/guidance.ts`） | 人格・挨拶＋**画面と同じ**主指示を声で添える | 挨拶 + 主指示（見出しと矛盾させない） | 「AI受付です。ご用件をお選びください。」 |
| **見出し**（`screen__title`） | その画面の**唯一の主指示**（＝次にすべき 1 アクション）。フォールバック安全（アバター無しでも成立） | 主指示 1 文 | 「ご用件をお選びください」 |
| **リード**（`screen__lead`） | 見出しを補う**安心/フォールバック**情報。主指示を**重ねない** | 補足（挨拶＋できることの保証） | 「ようこそ。タッチ操作だけで受付できます。」 |

- **矛盾の禁止**: 字幕と見出しは**同じ主指示**を指す（旧: 字幕「タッチして開始」× 見出し「用件を選ぶ」
  は別指示で矛盾していた）。リードには主指示を置かず、「タッチだけで受付できる（音声・チャット不要）」等の
  **安心情報**のみを置く（`reception.idleReassure`）。ja のリードは管理設定の案内文言（`guidanceIdle`,
  #28）を尊重し、既定値も安心情報のみに揃える。
- **二重質問の禁止（用件の先取り）**: 待機カード（`quickActionsFor('idle')`）は用件を**先取り**する。
  `delivery`/`department`/`other` は `presetPurpose` を持ち、`START` に初期 purpose を添えて
  `selectingPurpose` を自動スキップする（遷移の真実源 `state.ts` は不変。`SELECT_PURPOSE` を UI 側で
  自動 dispatch するだけで遷移表を分岐させない）。`callStaff` は用件未確定なので目的選択へ進むが、
  待機の見出し（`purposePrompt`）と目的選択の見出しが**同一文言で二重質問に見えない**よう、目的選択は
  `reception.purposeDetailPrompt`（「ご用件の種類をお選びください」）で**絞り込み**として提示する。
- **視覚語彙の統一（#324-3）**: 目的選択カードも待機カードと同じ `card__icon` + `card__sub`（説明）を持つ
  （`reception.purpose.<id>.desc` と `purposeIcon`）。無装飾ラベルのみの不整合を解消する。
- **通話結果の主 CTA（#324-5）**: `connected` は「担当者がまいります／操作は不要です」を明示し、
  終了操作は**任意（secondary）**にする（何もしなくてよいことを文言と CTA 強度の双方で伝える）。
- **サイネージの重複解消（#324-4）**: 待機サイネージのフォールバック上部ヒントは挨拶（`welcome.title`）
  のみとし、下部の受付開始 CTA（タップ導線）と**同一の「タップして開始」文言を重複させない**。

真実源: 文言辞書は `src/lib/i18n/dictionary.ts`（全 locale 網羅は `i18n.test.ts` #327 が強制）、
待機/目的/結果の描画は `src/components/kiosk/KioskFlow.tsx`、字幕は `avatar/guidance.ts`、
E2E は `kiosk-touch-first` / `reception-flow`。

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
