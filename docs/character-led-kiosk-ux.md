# Character-led 統合受付 UX 仕様

対象: #361 / #1055 / #1057 / #1077

実装の状態遷移の真実源は `src/domain/reception/state.ts`、表示契約は `src/domain/reception/ui-contract.ts`。
自然会話の詳細は `docs/minimum-turn-natural-conversation.md` を参照する。

## 目的

横向き iPad を主対象に、VRMキャラクター・字幕・タッチ・音声・QRを**ひとつの Reception Stage**で継続させる。

受付をページ遷移型のフォームにしない。来訪者からは、同じ受付係との会話が進んでいるように見えること。

現在の上位原則:

- **Single Reception Stage** — stateが変わっても同じ受付空間を維持する
- **No Typing** — visitor-facing software keyboardを使わない
- **Minimum Turns** — 必要な情報だけを最短で集める
- **One focus, multi-slot acceptance** — 1回の主質問は1つだが、追加で話された情報を捨てない
- **Ask only missing / ambiguous** — 取得済みslotを再質問しない
- **Single final confirmation** — 同一内容を個別確認と全体確認で二重確認しない
- **Repair, don't restart** — 間違ったslotだけを訂正する
- **Mixed modality** — touch / voice / numpad / QRを同じ会話内で自然に混ぜる

## 単一の真実源

新しい会話UXを入れても、状態機械を並立させない。

- `state.ts`: `ReceptionState` / `transition` の唯一の所有者
- `ui-contract.ts`: stateからavatar/message/actions/inputModes等を導出
- `conversation-turn.ts`: locale表示解決
- `minimum-turn-natural-conversation.md`: visible turn / slot filling / repair / confirmation policy

自然発話から得たslotは短命な `ConversationDraft` に保持できるが、state transitionそのものは必ず `state.ts` の許可遷移を通す。

## Reception Stage

### Landscape / large display

基本構成は 35 / 65。

- 左: avatar / subtitle / listening・speaking状態
- 右: 現在の質問、候補、確認、テンキー、結果
- 下端: EscapeBar

画面を切り替えるのではなく、右側の**現在の会話ターンだけを更新**する。

### Portrait

操作面積を優先する。avatarを小さくしても、字幕・状態・会話の連続性は維持する。

## ConversationTurnView

概念上の契約:

```ts
type ConversationTurnView = {
  stateKey: ReceptionState;
  avatar: {
    presence: 'primary' | 'companion' | 'minimal';
    emotion: AvatarEmotion;
    motionKey: MotionKey;
    gazeTarget?: GazeTarget;
  };
  message: {
    semanticKey: MessageKey;
    displayText: string;
    speechText?: string;
    speak: boolean;
  };
  answers: Array<{ id: string; label: string; intent: ReceptionAction }>;
  inputModes: Array<'touch' | 'voice' | 'numpad' | 'qr'>;
  requiresExplicitConfirmation: boolean;
  escapeHatches: Array<{ action: ReceptionAction }>;
};
```

`text` は visitor-facing input mode から除外する。

`touch` も全stateで必須とは限らない。自由発話が必須のslotでSTTが利用不能なら、software keyboardではなく既知候補 / retry / 有人支援へ移る。

## Internal state と visible turn

内部状態:

```text
idle
 → selectingPurpose
 → selectingTarget
 → inputVisitorInfo
 → confirming
 → calling
 → connected / timeout / failed
```

これは安全な内部遷移であり、**来訪者に全stateを別ターンとして見せる必要はない**。

例:

1. internal = `selectingPurpose`
2. system: 「どなたにご用ですか？」
3. visitor: 「営業の鈴木さんに打ち合わせで来ました。張です」
4. extractor/resolverが purpose / target / visitorName を取得
5. state.ts の許可順で内部適用
6. visible next = `confirming`

意味の無い `selectingPurpose → selectingTarget → inputVisitorInfo` の画面フラッシュは出さない。

## 最小slot

通常受付の現在のデータ契約上、最低限必要な情報は次の3つ。

- `purpose`
- `target`
- `visitorName`

`company` は必要な業務だけ。`note` は通常journeyでは収集しない。

## 会話設計

### One focus, multi-slot acceptance

システムの主質問は1つだけ。

> どなたにご用ですか？

来訪者が「営業の鈴木さんに打ち合わせで来ました。張です」と答えた場合、質問していないpurpose/nameも受け取る。

「担当者名・用件・お名前を全部話してください」のように複数回答を強要しない。

### Progressive disambiguation

| 入力 | 挙動 |
| --- | --- |
| touchで担当者を選択 | confirmed。再確認不要 |
| QR/予約で取得 | confirmed。再質問しない |
| voiceで一意・高確信 | provisional。次へ進み最終確認に含める |
| voiceで複数候補 | 2〜4候補ボタン |
| voice低確信 | short readback + yes/no |
| 認識不能 | retry / candidate / assistance |

### Final confirmation

呼び出し前の明示確認は残す。

> 張さま、営業部の鈴木さんに打ち合わせでお取り次ぎします。よろしいですか？

- `呼び出す`
- `修正する`

氏名を別ターンで「はい」と確認した直後、同じ氏名を含む最終確認をもう一度要求する設計は原則避ける。

### Correction

`修正する` 後は対象slotだけ変更する。

- target修正 → purpose / visitorName維持
- visitorName修正 → purpose / target維持
- purpose修正 → target / visitorName維持

## 標準journey

### 担当者受付 — 情報が一発話で揃う

1. `担当者を呼ぶ`
2. 「どなたにご用ですか？」
3. 「営業の鈴木さんに打ち合わせで来ました。張です」
4. final confirmation
5. `呼び出す`

visitor actions / utterances = 3

### 担当者受付 — targetのみ

1. `担当者を呼ぶ`
2. 「鈴木さん」
3. systemはtargetを保持し、不足slotだけ質問
4. final confirmation

鈴木さんをもう一度選び直させない。

### 同姓候補

1. 「佐藤さん」
2. `佐藤 花子 / 営業部`、`佐藤 太郎 / 開発部`
3. タップで確定
4. 不足slotへ

### QR

QR/予約から必須slotが揃えば、そのまま final confirmation。
同じ情報をフォームへ再入力させない。

## inputModes

来訪者向け通常入力:

- `touch`: 選択・候補・confirm・repair
- `voice`: 自由な氏名・担当者名・用件
- `numpad`: PIN・受付番号・人数・数値コード
- `qr`: 予約・受付情報

禁止:

- visitor-facing `input[type=text|search|email|tel]`
- `textarea`
- `contenteditable`
- OS/software keyboardへのfallback

## Avatar / speech

アバターは会話の案内役であり、ターンを増やすための存在ではない。

- 「承知しました」だけを独立ターンにしない
- 取得済み情報を毎回全部復唱しない
- 状態変化は短い字幕・表情・motionで補助できる
- final confirmationだけは重要slotを明示する
- connected中は `minimal` / speak=false を維持

presence:

| presence | 状態 | 意味 |
| --- | --- | --- |
| `primary` | idle | 受付の主役 |
| `companion` | 選択・入力・確認・calling・error | 会話を継続する付き添い |
| `minimal` | connected | 通話/取次を邪魔しない |

## フォールバック

### VRM/TTS failure

UIと字幕が残るため受付を継続する。

### STT failure

自由入力を必要とするjourneyで、無理にtouch-onlyを成立させるためtext inputを復活させない。

優先順位:

1. known candidate buttons
2. numeric alternativeならnumpad
3. voice retry
4. #1074 assistance

## ターン予算

設計目安:

- 通常受付: 2〜4 visitor actions / utterances
- QR/予約: 0〜2
- 配送/定型: 1〜3
- 5超: question necessity review

#1080 でPIIを含めず実測する。

## Anti-patterns

- 1 field = 1 screen
- 1 state = 1 visible page
- STT結果を全部個別yes/no
- 個別確認後に同一情報をfinal confirmationで再度確認
- state順のために取得済み情報を捨てる
- correctionで全restart
- company/noteをフォームにあるから聞く
- voice/touchを別journey化
- STT failure → software keyboard
- LLMがstate transition / staff id / CONFIRMを直接決める

## 関連

- #1057 No Typing
- #1077 Minimum-Turn Natural Conversation
- #1079 ConversationDraft / slot resolution
- #1080 metrics
- #1081 slot extraction boundary
- #1082 conversation copy / repair
- #1083 QR turn reduction
- #1074 assistance state contract
