# Character-led 統合受付 UX 仕様（画面・会話ターン・遷移）

対象: #361（Epic #360）/ #1055 / #1057 / #1077

- 実装の正本は `src/domain/reception/ui-contract.ts`（`ConversationTurnView` 契約・純関数）と
  `src/domain/reception/state.ts`（状態機械）。本書と実装が食い違ったら実装を正とし、本書を直す。
- 音声が受付状態機械へ起こせるイベントの境界は **[ADR 0011](adr/0011-voice-visitor-name-confirmation.md)**
  （ADR 0007 の一部を置き換える）。会話ターンの圧縮・slot・修正の方針は
  `docs/minimum-turn-natural-conversation.md`。体験の原則と Journey ID（J-OR-xx）の正本は `docs/experience/README.md`。

## 目的

横向き iPad を主対象に、VRM キャラクター・字幕・タッチ・音声・キーボード・QR を**ひとつの受付空間
（Reception Stage）**で続ける。来訪者からは、同じ受付係との会話が進んでいるように見えること。

- キャラクターが待機 → 挨拶 → 質問 → 復唱 → 確認 → 発信 → 成功 / 失敗まで一貫して応対する。
- タッチ・音声・文字・QR を、同じ問いへの入力手段として扱う。どれを使えるかは状態ごとに `ui-contract.ts` が決める。
- **発信（`CONFIRM`）は必ずタッチの確認を挟む。** 音声からは起きない（ADR 0011 §1）。
- 個人情報の確定（`SUBMIT_VISITOR_INFO`）は、タッチ / キーボードの明示の送信か、**音声で聞き取った氏名の
  復唱に「はい」と答えたこと**（ADR 0011 §1・§3-b）でだけ起きる。
- **音声 / VRM / STT / TTS が失敗しても、タッチとキーボードだけで最後まで済ませられる**（ADR 0011 §4）。

上位の原則（詳細は `docs/minimum-turn-natural-conversation.md`）:

- **Single Reception Stage** — 状態が変わっても同じ受付空間を保つ
- **Minimum Turns** — 要る情報だけを短く集める。ただし `inputVisitorInfo` とその通知は飛ばさない
- **One focus** — 1 回の主な問いは 1 つ。問い以上に話された情報のうち、使えるのは ADR 0011 の境界の内側だけ
- **Ask only missing / ambiguous** — 取得済みの slot を聞き直さない（音声の氏名の復唱は例外で、必ず行う）
- **Repair, don't restart** — 直すのは間違った slot だけ（できる範囲は minimum-turn §2.5）
- **Mixed modality** — タッチ / 音声 / キーボード / QR を、同じ会話の中で自然に混ぜる
- **No Typing は目標であって、今の契約ではない。** 来訪者向けのキーボードを外すのは、有人支援（#1074）が
  本番に配線され、owner が別途承認してから。それまでは ADR 0011 §4 の「キーボードを残す」が優先する

## 単一の真実源（重要）

表示契約の真実源は `ui-contract.ts` に一本化する。並立した真実源を作らない（#361 AC）。

- 受付状態の所有者は `state.ts`（`ReceptionState` / `transition`）。本契約は screenState から**導出するだけ**。
- 会話ターンの提示は `conversationTurnFor(state, overrides?)` が唯一の入口。
  presence/emotion/gazeTarget/message/answers/inputModes/requiresExplicitConfirmation/escapeHatches
  を 1 か所で導出する。
- 表情語彙（emotion）は `avatar/guidance.ts` の expression と一致させる（`ui-contract.test.ts` が
  cross-check）。モーションキーは `@/domain/motion/types` の `motionKeyForState` を再利用する（二重化しない）。
- locale 依存の表示文字列（`displayText` / answers のラベル）は component 層
  （`src/components/kiosk/conversation-turn.ts`）が解決し、`overrides` で注入する
  （domain → component への逆依存を避ける）。既定は ja の意味論的な短文を内蔵。
- 自然発話から得た slot は短命な `ConversationDraft`（#1088）に持てるが、状態の遷移は必ず `state.ts` の
  許可された遷移を通る。

## ConversationTurnView

今の実装（`ui-contract.ts`）の契約（抜粋。`handoffs` や answers の `presetPurpose` などは省いた。正本は型の定義）:

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
  inputModes: Array<'touch' | 'voice' | 'text' | 'qr'>;  // INPUT_MODES。touch は全ターンで必ず含む
  requiresExplicitConfirmation: boolean;                 // 発信/個人情報送信で true
  escapeHatches: Array<{ action: ReceptionAction }>;     // back / reset のみ
};
```

- **`touch` は全ターンで必ず含む**（`ui-contract.ts` の `INPUT_MODES` の注記、`ui-contract.test.ts` が縛る。
  ADR 0006 の決定 2・`docs/experience/README.md` の原則 2「音声とタッチの等価」）。本書はこれを変えない。
- **`text`（キーボード）は外さない。** `inputVisitorInfo`（氏名の欄）と `selectingTarget`（検索欄）で使う（ADR 0011 §4）。
- テンキー（`numpad`）のような新しい入力手段は、今の契約に無い。足すなら `INPUT_MODES` とテストを先に変える
  （本書だけで宣言しない。実装に無い手段を宣言すると、来訪者への主張が事実でなくなる。ADR 0007 の差分 C'）。

### inputModes の今の値と、ADR 0011 の実装後の値

| stateKey | 今（`SCREEN_TO_INPUT_MODES`） | ADR 0011 の実装後 | 理由 |
| --- | --- | --- | --- |
| idle | touch, qr | 変えない | |
| selectingPurpose | touch | 変えない | 目的は音声から扱わない（ADR 0011 §1） |
| selectingTarget | touch, voice, text | 変えない | `onResolved` → `SELECT_TARGET`（同じ姓なら復唱。§3-f） |
| inputVisitorInfo | touch, text | touch, **voice**, text | 通知の読み上げ後に氏名を聞き、復唱で確定（`onVisitorNameConfirmed`）。キーボードは残す |
| confirming | touch | 変えない | 発信の確定はタッチのみ |
| calling 以降 | touch | 変えない | |

右の列は、ADR 0011 を実装する PR（`KioskFlow` / `kiosk-binding`）が `ui-contract.ts` とテストを変えてはじめて真になる。
本書はそれを先取りして宣言しない。

### presence（アバターの在り方）— #123 からの意図反転

旧 #123 は「選択/入力画面はコンテンツが密集するためアバターを出さない」とし、
`avatar-companion.test.ts` がその集合を固定していた。#361 は**この意図を意図的に反転**し、
選択/入力/確認/呼び出しでもアバターを会話コンパニオンとして続ける（重なりは「非表示」ではなく
配置で解決する。下記レイアウト方針）。

| presence | 状態 | 意味 |
| --- | --- | --- |
| `primary` | idle | アバターが画面の主役（ヒーロー表示） |
| `companion` | selectingPurpose / selectingTarget / inputVisitorInfo / confirming / calling / failed / timeout / fallback / completed / cancelled | 操作の傍らで対話を続ける付き添い |
| `minimal` | connected | 通話中はキャラクターが発話を止め、静かな待機姿勢へ退く |

アバターはターンを増やすための存在ではない。

- 「承知しました」だけを独立したターンにしない
- 取得済みの情報を毎回全部復唱しない。ただし**音声で聞き取った氏名は必ず復唱する**（ADR 0011 §3-b）。
  同じ姓の担当者がいる名簿では、音声で選んだ相手も復唱する（§3-f）
- 最後の確認（`confirming`）では、相手と氏名を明示する

## 画面一覧（E-00〜E-10 / Q-01〜Q-02）と会話ターン写像

`stateKey` は `ReceptionState`。QR（Q-01/Q-02）は `src/domain/checkin/state.ts` の別の状態機械
（ADR 0008）で、統合シェルは残 increment（下記）。inputModes は**今の値**（上の表）。

| 画面 | stateKey | presence | emotion | gaze | message key | inputModes（今） | 確認必須 | 主な answers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E-00 待機・ウェルカム | idle | primary | happy | answers | welcome | touch, qr | – | （クイックアクション） |
| E-01 用件確認 | selectingPurpose | companion | happy | answers | choosePurpose | touch | – | 目的 ×4 (selectPurpose) |
| E-02 音声の復唱 | ※ selectingTarget（相手の復唱）と inputVisitorInfo（氏名の復唱）の中の UI。ADR 0011 の実装で入る | companion | – | – | – | – | – | はい / いいえ |
| E-03 担当者検索 | selectingTarget | companion | neutral | answers | chooseTarget | touch, voice, text | – | 担当者（実行時注入） |
| E-04 部門・窓口検索 | selectingTarget | companion | neutral | answers | chooseTarget | touch, voice, text | – | 部署（実行時注入） |
| E-05 来訪者情報 | inputVisitorInfo | companion | relaxed | form | enterVisitorInfo | touch, text | **要**（送信=submitVisitorInfo） | フォーム送信。入力欄より上に `PrivacyNotice`（#314） |
| E-06 取次内容確認 | confirming | companion | thinking | confirmCta | reviewAndConfirm | touch | **要**（発信=confirm） | この内容で呼ぶ (confirm) |
| E-07 発信中 | calling | companion | relaxed | none | calling | touch | – | – |
| E-08 担当者との通話 | connected | minimal | happy | none | connected | touch | – | 受付を終了 (complete) |
| E-09 担当者が向かっている | connected / fallback | minimal / companion | happy / neutral | none | connected / fallbackGuidance | touch | – | 受付を終了 (complete) |
| E-10 未応答・フォールバック | timeout / failed → fallback | companion | concerned | fallbackCta（通信断・実発信の停止中・時間外の failed は none。代わりの連絡手段も出さない） | apologyTimeout / apologyFailed | touch | – | 別の方法でご連絡 (useFallback) |
| Q-01 QR 読取 | （checkin: scanning） | companion | – | – | – | touch, qr | – | 読み取りのみ（発信しない） |
| Q-02 QR 内容確認 | （checkin: confirming） | companion | thinking | confirmCta | reviewAndConfirm | touch | **要** | この内容で呼ぶ |

> 発信（calling へ入る）唯一の経路は `confirming --confirm--> calling`。音声認識の結果だけでは
> 発信されない（`REQUIRES_CONFIRMATION_ACTIONS` / `passesConfirmationInvariant` が担保）。
> ADR 0011 の後も `REQUIRES_CONFIRMATION_ACTIONS` の `submitVisitorInfo` は外さない。音声の経路では
> 「明示の操作」を**復唱への肯定**と定義する。音声のどの経路からも `CONFIRM` は起きない（フォームの submit を
> 経由する間接の経路を含む）。

## 画面遷移

```text
KioskMode: signage → attract → reception   （Presence/KioskMode/ReceptionState の責務分離は #362）

ReceptionState:
  idle
   → selectingPurpose
   → selectingTarget
   → inputVisitorInfo  （通知を表示・読み上げてから氏名を尋ねる。音声は復唱の「はい」でだけ確定）
   → confirming        （発信前確認: 必ずタッチ）
   → calling
   → connected / timeout / failed
        timeout/failed → fallback
        confirming から発信前に撃てないと分かったら → failed（#764）
   → completed
  selectingPurpose / selectingTarget / inputVisitorInfo から CANCEL → idle
  confirming / calling から CANCEL → cancelled
  （どの状態からも RESET → idle。無操作は #125 のカウントダウン付きで idle へ）

QR（ADR 0008。統合シェルは残 increment）:
  scanning → resolving → confirming → calling   （読み取りだけで発信しない）
```

内部の状態は、来訪者に全部を別のターンとして見せる必要はない（minimum-turn §4）。ただし
**`inputVisitorInfo` は飛ばさない**（通知を見ないまま氏名を声で取らないため。ADR 0011 §2）。
意味の無い画面のちらつき（同じ発話の中での連続した遷移）を出さない工夫は、この制約の内側で行う。

## レイアウト方針

- **横向き iPad（ipad-landscape / large-display）**: 主要ステップ（用件選択・担当者選択・
  来訪者情報・確認）でアバターを**左レール 35%**、会話・操作を**右 65%** に並置する
  （`globals.css` の `[data-kiosk-presence]` / `[data-kiosk-state]` セレクタ）。レールは
  `pointer-events:none` で操作を妨げず、字幕を常時表示する。画面を切り替えるのではなく、
  右側の**今の会話ターンだけ**を更新する。
- **縦向き iPad（ipad-portrait）**: 既存プロファイルを壊さない。操作が下部に密集するため、
  アバターコンパニオンは従来どおりステータス画面（呼び出し/通話/結果/完了）に控えめに表示し、
  選択/入力での重なりを避ける（`KioskFlow.tsx` の `PORTRAIT_COMPANION_STATES` と
  `showAvatarCompanion` のレイアウト別ゲート。presence 自体は横縦に依らず `deriveAvatarPresence` が決める）。
- 呼び出し中/通話/結果は中央パネル＋左下の控えめな companion のまま（映像パネル等を壊さない）。
- 1 ターン 1 問。回答候補は原則 2〜4 件。字幕は常時表示。
- **電話番号・Vonage・内部エラーコードは来訪者へ見せない**（結果は `result-tone` の抽象的なトーンのみ）。

## 個人情報の表示と保存（ADR 0011 §6・`docs/experience/README.md` の原則 6）

- 音声の生データは保存しない。STT のために端末の外へ送る場合も、送った先で保存しない（ADR 0001・ADR 0011 §6）。
- 公共の画面へ、フル氏名・電話番号・発話の全文を必要以上に残さない。氏名を画面に出すのは、
  入力欄・氏名の復唱・最後の確認（`ConfirmView`）だけ。
- 途中の認識結果（interim）を、氏名の欄にも記録にも残さない。復唱に出すのは、確定した 1 つの候補だけ。
- 音声で取った氏名は、キーボードで入れた氏名と同じ扱い。監査ログ・experience metrics・アプリログに出さない。
  計測は件数・回数・経過時間だけ。
- 氏名を含む発話（復唱など）は、動的な TTS キャッシュ（ADR 0002 の S3・CDN、端末の Service Worker / IndexedDB）に
  書かない。
- `RESET`、無操作のリセット（#125）、キャンセル、受付の完了で、ConversationDraft と聞き取りの途中の状態を
  必ず捨てる（前の来訪者の氏名を、次の来訪者の画面に出さない）。

## フォールバック（縮退）

- 本契約は純データのため、VRM/TTS/STT を描画/再生できなくても `inputModes` に必ず `touch` を含み、
  `displayText`（字幕相当）とキーボードの欄で、タッチとキーボードだけで完走できる。
- 通話中（connected）は `speak=false`・`presence=minimal` でアバターが静かになる。
- **VRM / TTS の失敗**: UI と字幕が残るので受付を続ける。ただし TTS が使えないとき（失敗・中断・終了の通知が
  来ないときを含む）は、通知を読み上げられないので、**音声での氏名の聞き取りを始めない**。キーボードの欄だけを使う（ADR 0011 §2）。
- **STT の失敗・マイクの権限の拒否・`sttEnabled: false`（既定）・騒音**: 相手は候補ボタンか検索欄（キーボード）で、
  氏名はキーボードで入れる。権限を何度も求めて追い詰めない（`privacy_blocked`）。
- **氏名の聞き取りの失敗**: 最初の質問＋言い直し 2 回の計 3 回が失敗したら、音声をやめ、キーボードの欄へ
  フォーカスを移して「画面から入力してください」と案内する。有人支援（#1074）が使えるときは、その導線も示す
  （ADR 0011 §3-c）。
- **担当者の無応答・発信の失敗**: `timeout` / `failed` → `fallback`（代わりの連絡手段。ただし通信断・実発信の停止中・
  時間外では出さない。`shouldOfferAlternativeContact`）。発信前に撃てないと分かったら
  `confirming` → `failed`（#764）。どれも内部の理由を来訪者へ見せない。
- 音声も有人支援も使えないときに、受付を行き止まりにしない（planner は `blocked` を返さず、キーボードでの入力を返す。
  ADR 0011 §4）。

## やってはいけないこと

- 1 つの欄 = 1 つの画面 / 1 つの状態 = 1 つのページ、を機械的に当てはめる
- 相手の STT の結果を毎回 `はい/いいえ` で確かめる（同じ姓の担当者がいるときを除く）
- `inputVisitorInfo` と通知を飛ばして、氏名を声で取る
- 音声から `SELECT_PURPOSE` / `CONFIRM` を起こす
- 状態の順の都合で、取得済みの情報を捨てる / 聞き直す
- 修正のたびに最初からやり直させる
- 会社名やメモを、フォームにあるからという理由で声で尋ねる
- 音声とタッチを別のジャーニーにする
- STT / TTS が使えないときに、キーボードを出さずに行き止まりにする
- LLM が状態の遷移・担当者 ID・`CONFIRM` を直接決める

## 残 increment（本 doc 時点で未実装）

- **QR シェル統一**（#361 / #1083）: `CheckinFlow`（`domain/checkin/state.ts`）を通常受付と同一の画面シェルへ
  統合し、Q-01/Q-02 を `ConversationTurnView` として扱う。
- **E-02 復唱 UI の統一**（ADR 0011 の実装）: 相手と氏名の復唱ターンを `speechText` 分離を活かして統一する。
  氏名の復唱は `inputVisitorInfo` の中に置き、`onVisitorNameConfirmed` で確定する。
- **`VisitorInfoForm` の初期値**（ADR 0011 §5）: カスタムフローの入力画面が、音声で確定した氏名と、確認画面から
  戻ったときの入力済みの値を受け取れるようにする。
- **氏名の長さの上限**（ADR 0011 §3-e）: 音声とキーボードの両方へ、同じ 1 つの定数で課す（今はどこにも無い）。
- **iPad landscape の Visual Regression / axe テスト**追加。
- **多言語の displayText**: 今の `conversationTurnFor` の既定は ja。component が guidance の
  多言語字幕を `overrides.message` で注入する結線を全ステップに広げる。

## 関連

- ADR 0006（状態モデルの未定義）/ ADR 0007（音声とタッチの確認の境界）/ ADR 0008（QR の状態機械）/
  **ADR 0011（音声の氏名の確定）**
- #1057 No Typing / #1074 有人支援 / #1077 Minimum-Turn / #1079 ConversationDraft / #1080 metrics /
  #1081 slot 抽出の境界 / #1082 文面・修正 / #1083 QR の手数 / #1284 同じ姓による誤接続
