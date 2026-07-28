# ADR 0007: 音声とタッチの「確認」を統合しない

- ステータス: 採用（差分 C を**却下**。対応表と分析文書を訂正済み）
- 関連: issue #422（ExperienceShell）、#361（会話 UX）、#364（音声基盤）、#418（親 Epic）
- 関連ドキュメント: `docs/experience/state-mapping.md` §5 C、`docs/experience/README.md`
- 現物: `src/domain/reception/state.ts`、`src/domain/reception/ui-contract.ts`、
  `src/domain/voice-session/kiosk-view.ts`、`src/components/kiosk/KioskFlow.tsx`

## 決定

**`ReceptionState.confirming` と `VoiceKioskMode.readback` を統合しない。**
差分 C（`state-mapping.md` §5 C）は前提が誤っていたため却下する。

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
`confirming` → `calling` を通る**。加えて `confirm` / `submitVisitorInfo` は
`REQUIRES_CONFIRMATION_ACTIONS` に入っており、音声・チャットからは直接確定できない。

**したがって原則 2 の等価性は既に成立しており、しかも「協調」ではなく構造で保証されている。**
音声は独立した確認経路を持たず、確認ゲートは 1 つしかない。

## 統合すると何が壊れるか

仮に 2 つを 1 状態へ寄せると:

- **安全弁が弱まる。** 発信直前の確認は「取り返しのつかない操作の手前」に置くから意味がある。
  認識確認と同じ状態にすると、「認識を確認したから発信してよい」と読める経路が生まれる。
  `REQUIRES_CONFIRMATION_ACTIONS` が守っている不変条件を、状態モデル側から崩すことになる。
- **計測が混ざる。** 「confirming の滞在時間」が、聞き直しの往復と発信前の熟考を合算した値になる。
  README の Outcome metrics（受付完遂率・復帰率）の解釈が壊れる。
- **利得が無い。** 統合が解決するはずだった「等価性が機械的に保証されていない」は、
  上記のとおり**元から保証されている**。

## 影響

- `src/domain/experience/journey-map.ts`: `VOICE_MODE_TO_EXPERIENCE.readback` を
  `'confirming'` → `'recognizing'` へ訂正。**認識結果の確認は `recognizing` の内側**
  （`CALLING_STAGES` を採録しないのと同じ基準: ある体験状態の中の段階は別状態にしない）
- `docs/experience/state-mapping.md`: §1 の `confirming` 行と §5 C を訂正
- **挙動は変わらない。** 対応表の写し先が変わるだけで、遷移も画面も触らない

## #422 increment 5 への含意

差分 C は「ExperienceShell の中核」とされていたが、**中核は消えた**。ExperienceShell に
残る目的は「2 つの確認を統合すること」ではなく、画面構造の再編（ステッパー最小化・
常設要素の整理）に絞られる。着手時はこの前提で範囲を引き直すこと。

## 却下した代替案

**「統合はしないが、`readback` を `confirming` に写したまま残す」**: 写し先が意味と食い違った
ままになる。対応表は Outcome metrics の解釈に使う想定なので、category error を残すと
計測の読み違いを誘発する。

**「`recognition_confirming` を新設する」**: 状態を増やす前に「その状態が無いと本当に困るか」を
確かめる、というこのプロジェクトの既定方針（第 36・37 wave）に反する。`readback` は
`recognizing` の中の 1 局面で、allowed input が違うだけ。`CALLING_STAGES`（`contacting` の
内側の段階）を採録しないのと同じ扱いでよい。
