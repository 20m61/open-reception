# Minimum-Turn Natural Conversation

対象: #1077 / #1057 / #1055 / #779

この文書は、No Typing 方針を守りつつ、受付を「フォーム項目を順番に埋める体験」にしないための会話設計契約を定義する。

実装の状態遷移の真実源は引き続き `src/domain/reception/state.ts`、表示契約は `src/domain/reception/ui-contract.ts`。本書は **来訪者が体感する会話ターンの設計原則**を定める。内部 `ReceptionState` と visible turn を 1:1 にしない。

---

## 1. ゴール

受付のゴールは、入力項目を全部順番に聞くことではない。

**自然な会話とタッチの中で、受付成立に必要な情報だけを最短で揃え、誤接続を防ぎながら正しい相手へつなぐこと。**

標準 journey の設計目安:

| Journey | visitor actions / utterances | 目安 |
| --- | ---: | --- |
| 通常の担当者受付 | 2〜4 | 5を超えたら質問の必要性をレビュー |
| QR / 予約済み | 0〜2 | 取得済みslotを再質問しない |
| 配送・定型受付 | 1〜3 | 名前や会社名を機械的に要求しない |
| 例外 / ambiguity | 必要分のみ | 修復対象slotだけを扱う |

時間は呼び出し待ちを除き、通常受付 10〜20秒程度を設計目安とする。数値は製品要件ではなく、#1080 の実測で調整する。

---

## 2. 原則

### 2.1 One focus, multi-slot acceptance

システムは一度に **ひとつの自然な会話焦点**だけを提示する。

ただし来訪者が質問以上の情報を話した場合、取得できた情報を捨てない。

例:

- system: 「どなたにご用ですか？」
- visitor: 「営業の鈴木さんに打ち合わせで来ました。張です」
- extracted: `target=鈴木 / purpose=meeting / visitorName=張`
- next: 同じ項目を聞き直さず、曖昧なslotだけ修復して final confirmation へ

**禁止:**

- 「担当者名、用件、お名前を順番に話してください」のように複数回答を一度に要求する
- 発話から取得できた情報を state の順番に合わないという理由で捨てる

### 2.2 Ask only missing or ambiguous

次に聞く対象は以下の優先順位で決める。

1. 受付成立に必須だが未取得
2. 誤るコストが高く曖昧
3. routing に必要
4. 任意情報は原則聞かない

現行の通常受付 persistence 契約では `purpose / target / visitor.name` が必要。まずこの3つを minimum required slots とする。

`company / note` は default journey では収集しない。業務要件が明示された場合のみ追加する。

### 2.3 Progressive disambiguation

すべての音声結果を毎回 yes/no で確認しない。

| Evidence | UX |
| --- | --- |
| touchで明示選択 | `confirmed`。再確認しない |
| QR / reservation | `confirmed`。表示のみ |
| voice + 一意 + high | provisional。次へ進み final confirmation に含める |
| voice + 複数候補 | 2〜4候補ボタン |
| voice + low | short readback + yes/no または候補 |
| missing | 次の自然な質問 |
| STT unavailable | 候補 / retry / #1074 assistance。keyboardには戻らない |

### 2.4 Single final confirmation

`confirming` を全体の最終確認に使う。

例:

> 張さま、営業部の鈴木さんに打ち合わせでお取り次ぎします。よろしいですか？

CTA:

- `呼び出す`
- `修正する`

氏名を先に `はい/いいえ` で確認し、その直後に同じ氏名を含む全体確認をもう一度要求する、といった **同一slotの二重確認を原則禁止**する。

個別確認は ambiguity / low confidence / duplicate names など修復が必要なslotだけ。

### 2.5 Repair, don't restart

訂正されたslotだけを修復する。

- 「鈴木さんじゃなくて佐藤さん」→ targetだけ更新
- 「張じゃなくてチャンです」→ visitorNameだけ更新
- purpose / 他slot は維持
- Single Reception Stage を維持

最初からやり直すのは `reset` を明示的に選んだ場合のみ。

### 2.6 Mixed modality is normal

音声journeyとタッチjourneyを別アプリのように分けない。

自然な組み合わせ例:

- targetをvoice → candidateをtouch
- departmentをtouch → visitorNameをvoice
- QR → 不足slotだけvoice
- voice failure → department candidatesをtouch

入力方式はそのターンの目的を達成する手段であり、journey自体ではない。

---

## 3. Slot model

### 3.1 Minimum required slots

```ts
type ReceptionSlotKey =
  | 'purpose'
  | 'target'
  | 'visitorName'
  | 'company';
```

`company` は optional。`note` は default slot から外し、業務固有要件でのみ扱う。

### 3.2 Evidence

```ts
type SlotSource = 'touch' | 'voice' | 'qr' | 'reservation';
type SlotCertainty = 'confirmed' | 'high' | 'ambiguous' | 'missing';

type SlotEvidence = {
  source: SlotSource;
  certainty: SlotCertainty;
};
```

provider固有の confidence 数値をそのままUI判断へ漏らさない。正規化した certainty を conversation policy が扱う。

### 3.3 ConversationDraft

state順より先に情報を得る場合があるため、短命な draft を持てるようにする。

```ts
type ConversationDraft = {
  purpose?: {
    value: ReceptionPurposeId;
    evidence: SlotEvidence;
  };
  target?: {
    value: Target;
    evidence: SlotEvidence;
  };
  visitorName?: {
    value: string;
    evidence: SlotEvidence;
  };
  company?: {
    value: string;
    evidence: SlotEvidence;
  };
};
```

制約:

- PII draftはメモリ内の短命状態
- audit / experience metrics に値を保存しない
- reset / completed / cancelled で破棄
- targetは directory に存在する entity だけを確定値にできる

---

## 4. State と visible turn の分離

`ReceptionState` は安全な内部遷移として維持する。

```text
idle
 → selectingPurpose
 → selectingTarget
 → inputVisitorInfo
 → confirming
 → calling
```

ただし来訪者にこの6段階を全部見せる必要はない。

同一発話で複数slotが解決した場合、許可されたイベントを内部で順に適用し、**意味のない intermediate UI を表示しない**。

例:

1. internal: `selectingPurpose`
2. utteranceから purpose + target + visitorName を取得
3. internal event sequence:
   - `SELECT_PURPOSE`
   - `SELECT_TARGET`
   - `SUBMIT_VISITOR_INFO`
4. visible next turn: `confirming`

呼び出し確定 `CONFIRM` は必ず来訪者の明示操作を要求する。

state順より先に取得した値は ConversationDraft に保持し、正規のstateへ到達した時に適用する。

---

## 5. Slot extraction の責務境界

自然発話の解析器 / LLM は状態を進めない。

```ts
type ReceptionSlotProposal = {
  purpose?: {
    value: ReceptionPurposeId;
    confidence: number;
  };
  target?: {
    query: string;
    confidence: number;
  };
  visitorName?: {
    value: string;
    confidence: number;
  };
};
```

責務:

1. STT: transcriptを生成
2. extractor: slot proposalを生成
3. resolver: target queryをdirectory entityへ解決
4. conversation planner: certainty / missing / ambiguityから次のfocusを決定
5. state adapter: `state.ts` の許可遷移だけを適用
6. final confirmation: 明示touchで `CONFIRM`

LLM / extractor が staff ID を創作したり、`CONFIRM` を実行したりしてはならない。

---

## 6. Next conversation focus

概念API:

```ts
type ConversationFocus =
  | { kind: 'target' }
  | { kind: 'purpose' }
  | { kind: 'visitorName' }
  | { kind: 'disambiguateTarget'; candidateIds: string[] }
  | { kind: 'confirmLowConfidenceName'; candidate: string }
  | { kind: 'finalConfirmation' }
  | { kind: 'assistance' };

function nextConversationFocus(
  draft: ConversationDraft,
  capabilities: ConversationCapabilities,
): ConversationFocus;
```

原則:

- `ambiguous` を `missing` より優先して修復してよい。ただし画面の文脈を崩さない
- confirmed slotは質問対象に戻さない
- high slotはfinal confirmationまで持ち越せる
- required slotsが揃ったらfinalConfirmation
- STT不能でvoice-required slotが残ればassistance

---

## 7. 会話コピー

会話コピーは自由生成に依存させず、基本パターンをi18nで固定する。

### target focus

「どなたにご用ですか？」

### visitor name focus

「お名前をお願いします。」

### purpose focus

「どのようなご用件ですか？」

定型候補がある場合はボタンを同時に提示する。

### target ambiguity

「佐藤さんが2名います。どちらの方ですか？」

+ 2〜4 candidate buttons

### low-confidence name

「『チャン』さまでよろしいですか？」

+ `はい` / `もう一度`

### final confirmation

「張さま、営業部の鈴木さんに打ち合わせでお取り次ぎします。よろしいですか？」

### correction

「担当者を変更します。どなたにご用ですか？」

他slotは維持する。

### STT failure

「うまく聞き取れませんでした。もう一度お話しいただくか、画面からお選びください。」

候補が無い場合は #1074 の有人支援を提示する。

### unavailable staff

「鈴木さんは現在応答できません。営業部または受付担当へおつなぎできます。」

実接続できない環境で「おつなぎします」と約束しない。

---

## 8. Journey examples

### J-01: 一発話で全部揃う

1. Visitor: `担当者を呼ぶ`
2. System: 「どなたにご用ですか？」
3. Visitor: 「営業の鈴木さんに打ち合わせで来ました。張です」
4. System: final confirmation
5. Visitor: `呼び出す`

visitor actions = 3

### J-02: targetしか言わない

1. `担当者を呼ぶ`
2. 「鈴木さん」
3. systemは取得済みtargetを保持
4. 未取得slotだけ質問
5. final confirmation

targetを再質問しない。

### J-03: 同姓

1. 「佐藤さん」
2. candidate: `佐藤 花子 / 営業部`, `佐藤 太郎 / 開発部`
3. visitor selects
4. 未取得slotだけ質問
5. final confirmation

### J-04: 修正

1. final confirmation
2. Visitor: `修正する`
3. 修正対象を選択または「鈴木さんじゃなくて佐藤さん」
4. targetだけ更新
5. final confirmationへ戻る

### J-05: QR all-known

1. QR scan
2. final confirmation
3. `呼び出す`

同じ氏名・担当者を再入力させない。

### J-06: STT unavailable

1. voice-required slotでSTT failure
2. known candidatesがあればtouch
3. numeric代替があればnumpad
4. retry
5. 解決不能なら #1074 assistance

software keyboardは出さない。

---

## 9. Anti-patterns

禁止/要レビュー:

- 1 field = 1 screen を機械的に実装
- STT結果を常に個別yes/noし、その後同じ内容をfinal confirmationでも確認
- 「承知しました」だけの独立ターン
- 取得済み情報をstate遷移順の都合で再質問
- correctionで最初からやり直す
- STT failure時にsoftware keyboardを表示
- company / noteを「フォームにあるから」という理由で収集
- voice mode / touch modeを別journeyとして分断
- LLMがstaff id / state transition / call確定を直接生成

---

## 10. Metrics

#1080 でPIIなしに以下を測る。

- visitorActionCount
- voiceUtteranceCount
- touchActionCount
- clarificationCount
- reaskCount
- correctionCount
- candidateDisambiguationCount
- assistanceRequested
- timeToConfirmMs

発話本文、氏名、会社名、担当者名はmetricsへ入れない。

---

## 11. Acceptance criteria

- 取得済みslotを再質問しない
- 1発話から複数slotを受け取れる
- 1画面の主指示は1focus
- high-confidence voice slotは毎回個別確認しない
- ambiguous / low-confidence slotだけをrepairする
- final confirmationにprovisionalな重要slotを含める
- same slotの二重確認を原則しない
- correctionで他slotを失わない
- No Typingを維持する
- purpose / target / visitorNameが揃ったら不要なcompany/noteを挟まない
- standard journeyのvisitor action数を計測できる

Refs: #1077 #1079 #1080 #1081 #1082 #1083 #1074 #1057 #361
