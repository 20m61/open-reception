# open-reception Experience Engineering

この文書は、横向き iPad 上の受付体験を、画面・音声・通話・運用をまたぐ一つのサービスとして設計、実装、評価するための正本である。既存の Issue、`CLAUDE.md`、ループ文書、品質ゲートと併用する。

## Experience principles

1. **受付開始後は一つの視覚空間から退出しない** — 状態遷移を別ページの列ではなく、同じ Reception Stage 上の会話ターン更新として表現する。
2. **3秒以内に始め方が分かる** — 初見の来訪者が説明を読まず受付を始められる。
3. **来訪者にタイプさせない** — 入力は選択ボタンとテンキーを優先し、それらで表現できない自由入力は音声認識で扱う。software keyboard を通常受付へ出さない。
4. **タッチと音声を役割分担し、行き止まりを作らない** — 定型操作はタッチで完結させ、自由入力は音声を使う。音声が使えない場合はキーボードへ戻さず、候補選択・再発話・有人支援へ自然に切り替える。
5. **システム状態を沈黙させない** — 聞き取り中、認識中、確認中、発信中、接続中、失敗を明示する。
6. **途中経過を失わない** — 聞き返し、通信失敗、担当者不在でも最初からやり直させない。
7. **人につながる逃げ道を残す** — 自動受付を完遂できない場合に代表窓口や有人支援へ移れる。
8. **公共空間のプライバシーを守る** — 個人情報、発話内容、担当者情報を必要以上に表示・読み上げない。

### Single Reception Stage contract

`idle -> purpose -> target -> visitor-info -> confirm -> calling -> result` は、来訪者にとって
「複数画面を順番に進むフロー」ではなく、**同じ受付空間で質問と回答が一段ずつ進む会話**である。
URL、`ReceptionState`、内部コンポーネントが変わること自体は許容するが、実装都合をページ遷移として
知覚させない。

- **Stage**: avatar / message / interaction / escape の基本 Composition と視線の座標系を保つ。
- **Turn**: その瞬間の質問、必要最小限の前ターン context、回答 UI だけを更新する。
- **Back**: 「前ページへ戻る」ではなく、一つ前の回答を訂正する会話操作として扱う。
- **Error / recovery**: 失敗専用画面へ飛ばさず、理由と修正操作を同一 viewport・同一 Stage に置く。
- **Input mode**: visitor input は button / numpad / voice を基本とし、touch / voice / QR の切替を理由に Stage 全体を別 UI へ置換しない。
- **No typing**: `input[type=text|search|email|tel]` / `textarea` / contenteditable / OS software keyboard を通常の来訪者入力として使わない。自由入力は voice-required とする。
- **Voice confirmation**: 氏名・担当者等の重要な固有名詞は、STT結果をそのまま確定せず、復唱または2〜4件程度の候補 + ボタンで明示確認する。
- **Fallback**: VRM / TTS が無くても同じ情報構造を保つ。STT が利用不能・権限拒否・継続失敗の場合も keyboard を出さず、既知候補 / numpad / 再発話 / human assistance の順で復帰する。
- **Motion**: 全面 slide / 全面 fade / blank frame を進行の主表現にしない。局所 transition は連続性を補助する場合だけ使い、reduced motion でも意味が成立すること。
- **Accessibility**: 視覚連続性のために heading、focus、live region 等の semantics を弱めない。音声を使えない来訪者を行き止まりにせず、有人支援へ到達可能にする。

signage / attract から reception へ入るモード境界、または別 journey である checkout の入口は例外に
なり得る。ただし各 journey に入った後は同じ原則を適用する。詳細な実装・Evidence は #779 / #1055 / #1057 / #782。

## Primary actors

- 来訪者: 初見、短時間、騒音や身体条件を含む多様な状況で受付する。
- 受付先担当者・代表窓口: 着信を受け、来訪目的を理解し、応答または代替案を返す。
- 運用管理者: 部署、担当者、音声、VRM、稼働時間、認証、利用量を管理する。

## Core journeys

### J-OR-01 担当者指定受付

`開始 -> 担当者を検索/選択 -> 認識結果を確認 -> 発信 -> 接続 -> 完了`

成功条件:
- 既知候補はタッチで、候補外の自由入力は音声認識で担当者へ到達できる。
- 同姓同名、認識揺れ、候補なしを安全に解決できる。
- 発信先、現在の処理、失敗時の代替手段が分かる。

### J-OR-02 部署・目的から受付

`目的を選ぶ/話す -> 部署候補 -> 担当または代表窓口 -> 発信 -> 完了`

成功条件:
- 組織構造を知らない来訪者でも目的から進める。
- 選択肢を増やしすぎず、総合案内へ退避できる。

### J-OR-03 QR予約受付

`QR読取 -> 予約内容確認 -> 必要最小限の確認 -> 担当者へ通知/発信 -> 完了`

成功条件:
- 無効、期限切れ、別拠点、読取失敗を区別する。
- QRに含まれる個人情報を画面へ過剰表示しない。

### J-OR-04 音声認識失敗から復帰

`聞き取り -> 不確実/無音/騒音 -> 聞き返し -> 候補提示 -> タッチ候補/再発話/有人支援 -> 継続`

成功条件:
- 失敗理由を来訪者の責任として表現しない。
- 直前までの目的・候補・入力を保持する。
- software keyboardを出して解決しない。

### J-OR-05 担当者不在・接続失敗

`発信 -> 無応答/拒否/障害 -> 状態説明 -> 再試行/代表窓口/伝言 -> 完了`

成功条件:
- 無限再試行や沈黙を避ける。
- 代替先と個人情報の扱いを明示する。

## Interaction state model

`idle -> visitor_detected -> greeting -> choosing_method -> listening|touching|scanning -> recognizing -> confirming -> contacting -> connected -> completed`

来訪者の入力手段は、UI上は **button / numpad / voice** を基本とする。
`touching` には選択ボタンとテンキーを含み、`listening` は音声認識、`scanning` は QR 読み取りを指す。
QR は予約済みの来訪者向けの加速手段であり、QR でしかできない受付を作らない。
定型journeyは button / numpad で完走可能にし、ボタンやテンキーで表現しきれない自由入力は
voice-required とする。STT が使えない場合は keyboard を出さず、候補選択または有人支援へ文脈を
保って遷移する（詳細と根拠は `docs/adr/0006-experience-state-model-gaps.md` と #1057）。

例外状態:

`speech_unclear | no_match | person_unavailable | contact_failed | network_degraded | privacy_blocked | human_assistance`

| 例外状態 | 定義 |
| --- | --- |
| `speech_unclear` | 発話を解釈できなかった。**来訪者の落ち度として表現しない**。復唱確認、候補ボタン、再発話、有人支援の順で復帰する。keyboardへは逃がさない |
| `no_match` | 指定された相手が見つからない（担当者検索 0 件）。部署一覧・相談導線へ逃がす |
| `person_unavailable` | 相手は特定できたが応答が無い。再試行・代表窓口・伝言のいずれかを出す |
| `contact_failed` | 呼び出しを完了できなかった（サーバ側の失敗）。代替導線を主 CTA にする |
| `network_degraded` | 端末とサーバの疎通が不安定。**復旧待ちであることを伝える**。通信断で失敗した呼び出しは代替導線を約束しない（果たせないため） |
| `privacy_blocked` | プライバシーに関わる権限（カメラ・マイク）を許可されず、**その入力手段では**続行できない。受付自体は失敗していない。既知候補で代替できなければ有人支援へ文脈を保って戻す。権限の再要求やkeyboard入力で追い詰めない |
| `human_assistance` | 有人対応へ引き継いだ。誰に何を引き継いだかを来訪者に見せる |

各状態は次を持つ。
- visible cue / spoken cue
- allowed input
- timeout and cancellation
- preserved context
- fallback transition
- PII exposure rule
- telemetry event

## UX pattern contracts

- **Listening**: マイク入力中であること、停止方法を表示する。タッチで表現可能な既知候補があれば代替として提示し、自由入力が不可欠で音声を使えない場合は有人支援へ逃がす。
- **Recognition confirmation**: 高確信でも重要な固有名詞・発信先は復唱または候補ボタンで明示確認する。
- **Visitor input**: 来訪者向け通常フローでは button / numpad / voice のみを使う。自由文字入力欄、textarea、contenteditable、software keyboardを出さない。数字だけで完結する値は共通テンキーUIを使う。
- **Processing**: 処理名と待機理由を示し、長時間時は中止または代替手段を出す。
- **Fallback**: 音声失敗時は既知候補、再発話、有人支援へ文脈を保持して遷移する。担当者失敗時は代表窓口へ移る。keyboard入力をfallbackにしない。
- **Privacy**: フル氏名、電話番号、発話全文を公共画面へ必要以上に残さない。
- **Completion**: 誰へつながったか、次に何をすべきか、受付が終了したかを明示する。
- **Turn transition**: Stage 全体を差し替えず、そのターンで変わる質問・context・interaction を局所更新する。
  前ターンの全情報を残して情報密度を増やすのではなく、次の判断に必要な context だけを凝縮する。
  transition 中も escape / recovery を失わず、視覚上の連続性と a11y の状態通知を両立する。
- **Unavailable**: 押せない・選べないことを**破線の枠**で示す（`#778`）。透明度だけに寄せない
  ——受付端末は明るいロビーに置かれ、`opacity` を下げただけの要素は「ただのボタン」に見えて
  反応しないまま連打される。高コントラストモードではさらに悪く、透明度は意味を伝えず
  コントラストだけを削る。枠の**太さは変えない**（太らせると有効化の瞬間に寸法が動き、
  来訪者は「押せるようになった」ではなく「画面が動いた」と受け取る）。
  実装は `.btn:disabled:not([aria-busy='true'])` / `.card--unavailable`（`#776` の不在担当者
  カード）/ `KioskChatDrawer.module.css` の `.send:disabled:not([aria-busy='true'])`。
- **Processing**: 「処理中」は「押せない」と**別の状態**として扱う（`#792`）。同じ `disabled`
  属性で表現されるが、無効表現は当てない——送信の往復中に主 CTA が破線へ落ちると、来訪者は
  「押せなくなった／タップが失敗した」と読む（`.btn--danger` は危険色まで消える）。
  `aria-busy="true"` を付けて無効表現から除外し、**ラベルを差し替えて**進行中を示す
  （`cursor: progress` はタッチ端末では見えないので、それ単独を進行中の表現と呼ばない）。
  `disabled` 自体は外さないので二重送信はブラウザが防ぐ。
  ⚠️ `aria-busy` は**そのボタン自身の操作**が往復中のときだけ真にする。画面共有の busy
  フラグをそのまま流すと、条件未達で押せないボタンまで「押せる」見た目へ戻る。

## Issue / implementation contract

来訪者または運用者向け変更は以下を必須記載する。

- Actor / user outcome
- Related journey ID and step
- Entry state / exit state / exception states
- Visitor input mapping（button / numpad / voice）と voice-required の有無
- software keyboard / free text input を追加しないこと、または運用者画面に限定されること
- Visible, spoken and haptic/animation response
- Timeout, cancellation and fallback
- PII and audit impact
- Experience acceptance criteria
- Evaluation level and device/browser scope

## Evaluation ladder

1. **Static**: 用語、コントラスト、タップ領域、フォーカス、PII、状態欠落、visitor向けfree text input混入。
2. **State/model**: 正常系・例外系・タイムアウト・取消・フォールバック遷移。
3. **Automated browser**: タッチ導線、音声認識、権限拒否、無デバイス、ネットワーク失敗、keyboard無しfallback。
4. **Instrumentation**: STT/TTS、割込、発信、状態遷移の時間と失敗箇所。
5. **Screenshot**: レイアウト・視線誘導が変わる画面だけ。
6. **Video/agent**: J-OR-01〜05 の変更対象ジャーニーを通しで評価する。
7. **Human/device**: 横向き iPad、騒音、距離、初見ユーザー、音声を使えないケースでリリース前確認する。

## Outcome metrics

- 受付開始までの時間
- 受付完遂率と有人支援移行率
- 音声失敗後の復帰率
- 担当者検索・選択のやり直し回数
- 発信から結果表示までの待機時間
- 状態不明による連打・重複発信
- PII表示・読上げ・ログの違反件数

## Loop rule

各周回は `Journey -> State timeline -> Multimodal interaction contract -> Implementation -> Layered evaluation -> Operational outcome` の順で進める。静止画の見栄えだけで完了せず、時間、音声、フォールバック、公共空間、運用側の結果まで確認する。
