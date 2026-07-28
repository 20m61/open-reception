# ADR 0007: 音声とタッチの「確認」を統合しない

- ステータス: 採用（**統合の却下**まで。差分 C が指摘していた等価性ギャップは
  **別の理由で実在する**ため、差分 C' として残す。詳細は「訂正」節）
- 関連: issue #422（ExperienceShell）、#361（会話 UX）、#364（音声基盤）、#418（親 Epic）
- 関連ドキュメント: `docs/experience/state-mapping.md` §5 C、`docs/experience/README.md`
- 現物: `src/domain/reception/state.ts`、`src/domain/reception/ui-contract.ts`、
  `src/domain/voice-session/kiosk-view.ts`、`src/components/kiosk/KioskFlow.tsx`

## 決定

**`ReceptionState.confirming` と `VoiceKioskMode.readback` を統合しない。**
差分 C が「同じ確認が 2 つの状態機械に分裂している」とした前提は誤りだったため、
**統合の提案は却下する**。

ただし差分 C の**見出し**（「音声とタッチの等価性が機械的に保証されていない」）は、
**理由は違うが結論としては生きている**。統合とは別の問題として差分 C' に残す（下記「訂正」節）。

あわせて `VOICE_MODE_TO_EXPERIENCE.readback` の写し先を `confirming` から **`recognizing`** へ
訂正する。

## 背景: 差分 C が主張していたこと

第 34 wave の差分表は次のように書いていた。

> **C. 系統が分かれていて等価性が担保されていない（設計判断が要る）**:
> `confirming` がタッチ（`ReceptionState.confirming`）と音声（`VoiceKioskMode.readback`）で
> 別系統。README の原則 2「音声とタッチで同じ目的を達成できる」は**実装では 2 つの状態機械の
> 協調**で成立しており、機械的に保証されていない。ExperienceShell の中核はここ。

つまり「**同じ『確認』が 2 つの状態機械に分裂している**」という主張だった。

## なぜ却下するか: 2 つは違うものを確認している

実装を追うと、両者は**別の対象を、別の時点で**確認している。

| | `VoiceKioskMode.readback` | `ReceptionState.confirming` |
| --- | --- | --- |
| 何を確認するか | **聞き取った内容**（「◯◯様ですね？」） | **受付の内容全体**（目的・相手・来訪者情報） |
| いつ | 相手を決める**前** | 発信する**直前** |
| 何のために | STT の解釈が合っているか（低信頼時の受け皿, #370） | 取り返しのつかない操作（人を呼ぶ）の手前の安全弁 |
| 出口 | `confirmYes` → `idle`（次ターンへ）/ `confirmNo` → `listening` | `CONFIRM` → `calling` |

`readback` は README の UX pattern **「Recognition confirmation」**（高確信でも重要な固有名詞・
発信先は確認可能にする）であって、タイムライン上の `confirming` ではない。

## 決定的な証拠: 音声もタッチと同じ確認ゲートを通る

音声が受付状態機械へ入る経路は **`onResolved` の 1 本だけ**で、そこが dispatch するのは
`SELECT_TARGET` **のみ**（`KioskFlow.tsx` の `handleVoiceResolved`）。遷移表は次のとおり。

```
selectingTarget --SELECT_TARGET--> inputVisitorInfo
                --SUBMIT_VISITOR_INFO--> confirming
                --CONFIRM--> calling
```

つまり**音声で相手を決めても、その後は必ずタッチ経路と同じ `inputVisitorInfo` →
`confirming` → `calling` を通る**。

**したがって「発信前の確認ゲートは 1 つしかなく、音声はそれを迂回できない」＝安全側は
構造で保証されている。** 音声は独立した確認経路を持たない。

**保証の実体は `VoiceSessionHooks` が `onResolved` しか公開していないこと**（`kiosk-binding.ts`）。
`REQUIRES_CONFIRMATION_ACTIONS` は**チャット経路と宣言値にしか使われておらず、音声を止めて
いない**（初版はこれを根拠に挙げていたが誤り）。この保証はどのテストも固定していなかったので、
`src/lib/voice-session/exposure-guard.test.ts` を追加した。

さらに補強となる事実: 高信頼時は `heardAccepted` で復唱を挟まず即 `resolve` する
（`kiosk-bridge.ts`）。**`readback` は必ず通る経路ですらない**ため、これを「確認ゲート」と
見なす前提自体が成り立たない。

## 訂正: 等価性は成立していない（差分 C' として残す）

初版は「原則 2 の等価性は既に成立している」と書いたが**誤り**（独立レビューで判明）。
安全側（迂回できない）と等価性（音声だけで完遂できる）を混同していた。

音声が dispatch できるのは `SELECT_TARGET` **だけ**である。

| 受付の局面 | `SCREEN_TO_INPUT_MODES` の宣言 | 実際の音声経路 |
| --- | --- | --- |
| `selectingPurpose` | `touch` / **`voice`** / `text` | **無い**（`voiceCandidateToTarget` は purpose を捨てる） |
| `selectingTarget` | `touch` / **`voice`** / `text` | 有る（`onResolved` → `SELECT_TARGET`） |
| `inputVisitorInfo` | `touch` / **`voice`** / `text` | **無い**（素の `<input>` のみ） |

**宣言と実装が 3 分の 2 で食い違っている。** 音声だけでは受付を完遂できず、目的選択・
氏名入力・発信確認でタッチが要る。腕が塞がっている来訪者、視覚に頼れない来訪者、騒音下で
タッチ精度が落ちる状況では、原則 2 が実際には満たされていない。

これは**統合とは別の問題**なので、統合を却下しつつ差分 C' として残す
（`state-mapping.md` §5 C'）。

## 統合すると何が壊れるか

**前提**: 対応表（`journey-map.ts`）には現時点で**ランタイム消費者が無い**。以下は
「対応表の写し先を変えると壊れる」話ではなく、**状態機械を統合した場合**の話である。
安全弁の実体は遷移表と唯一の `CONFIRM` dispatch サイトであって、対応表ではない。

仮に 2 つを 1 状態へ寄せると:

- **安全弁が弱まる。** 発信直前の確認は「取り返しのつかない操作の手前」に置くから意味がある。
  認識確認と同じ状態にすると、「認識を確認したから発信してよい」と読める経路が生まれる。
  `REQUIRES_CONFIRMATION_ACTIONS` が守っている不変条件を、状態モデル側から崩すことになる。
- **計測が混ざる。** 「confirming の滞在時間」が、聞き直しの往復と発信前の熟考を合算した値になる。
  README の Outcome metrics（受付完遂率・復帰率）の解釈が壊れる。
- **等価性の解決にならない。** 統合が解決するはずだった等価性ギャップの実体は
  「`selectingPurpose` / `inputVisitorInfo` に音声経路が無い」ことであって、確認状態が
  2 つあることではない（上記「訂正」節）。統合しても音声だけで受付は完遂できない。

## 影響

- `src/domain/experience/journey-map.ts`: `VOICE_MODE_TO_EXPERIENCE.readback` を
  `'confirming'` → `'recognizing'` へ訂正。**認識結果の確認は `recognizing` の内側**
  （`CALLING_STAGES` を採録しないのと同じ基準: ある体験状態の中の段階は別状態にしない）
- `docs/experience/state-mapping.md`: §1 の `confirming` 行と §5 C を訂正
- **挙動は変わらない。** 対応表の写し先が変わるだけで、遷移も画面も触らない

## #422 increment 5 への含意

差分 C は「ExperienceShell の中核」とされていたが、**中核の中身が変わった**。
「2 つの確認を統合すること」ではなく、**差分 C'（`selectingPurpose` / `inputVisitorInfo` の
音声経路）と画面構造の再編**になる。

**範囲の引き直し自体は仕様判断なので、本 ADR では確定しない**（`docs/loop-queue.md` の
「差分 C / D は要ユーザー確認」を維持する）。ここに書くのは分析結果までで、
increment 5 に着手してよいかは別途の判断。

## 却下した代替案

**「統合はしないが、`readback` を `confirming` に写したまま残す」**: 写し先が意味と食い違った
ままになる。対応表は Outcome metrics の解釈に使う**想定**なので（現時点でランタイム消費者は
無い）、category error を残すと将来の読み違いを誘発する。

**「`recognition_confirming` を新設する」**: 状態を増やす前に「その状態が無いと本当に困るか」を
確かめる、というこのプロジェクトの既定方針（第 36・37 wave）に反する。`readback` は
`recognizing` の中の 1 局面で、allowed input が違うだけ。`CALLING_STAGES`（`contacting` の
内側の段階）を採録しないのと同じ扱いでよい。2 つの実装状態は**実行時に排他**なので
（`voiceListeningStage` は `mode !== 'listening'` で null）、どちらが今かが曖昧になることもない。

> **残存リスク**: 体験状態だけを見ると「発話検知中」と「復唱で来訪者の応答を待っている」を
> 区別できない。後者は yes/no のブロッキングゲートで、しかも `voiceKioskReducer` に
> **timeout イベントが無い**（復帰は受付側の無操作リセットに依存）。将来この表から
> Outcome metrics を導くなら、`confirming` について警告したのと同じ「合算」が今度は
> `recognizing` で起きる。**対応表を計測に使うのは現時点では「想定」であって現状ではない。**
