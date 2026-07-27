# open-reception Experience Engineering

この文書は、横向き iPad 上の受付体験を、画面・音声・通話・運用をまたぐ一つのサービスとして設計、実装、評価するための正本である。既存の Issue、`CLAUDE.md`、ループ文書、品質ゲートと併用する。

## Experience principles

1. **3秒以内に始め方が分かる** — 初見の来訪者が説明を読まず受付を始められる。
2. **音声とタッチで同じ目的を達成できる** — 一方が失敗してももう一方へ自然に切り替えられる。
3. **システム状態を沈黙させない** — 聞き取り中、認識中、確認中、発信中、接続中、失敗を明示する。
4. **途中経過を失わない** — 聞き返し、通信失敗、担当者不在でも最初からやり直させない。
5. **人につながる逃げ道を残す** — 自動受付を完遂できない場合に代表窓口や有人支援へ移れる。
6. **公共空間のプライバシーを守る** — 個人情報、発話内容、担当者情報を必要以上に表示・読み上げない。

## Primary actors

- 来訪者: 初見、短時間、騒音や身体条件を含む多様な状況で受付する。
- 受付先担当者・代表窓口: 着信を受け、来訪目的を理解し、応答または代替案を返す。
- 運用管理者: 部署、担当者、音声、VRM、稼働時間、認証、利用量を管理する。

## Core journeys

### J-OR-01 担当者指定受付

`開始 -> 担当者を検索/選択 -> 認識結果を確認 -> 発信 -> 接続 -> 完了`

成功条件:
- タッチと音声のどちらでも担当者へ到達できる。
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

`聞き取り -> 不確実/無音/騒音 -> 聞き返し -> 候補提示 -> タッチ切替または再発話 -> 継続`

成功条件:
- 失敗理由を来訪者の責任として表現しない。
- 直前までの目的・候補・入力を保持する。

### J-OR-05 担当者不在・接続失敗

`発信 -> 無応答/拒否/障害 -> 状態説明 -> 再試行/代表窓口/伝言 -> 完了`

成功条件:
- 無限再試行や沈黙を避ける。
- 代替先と個人情報の扱いを明示する。

## Interaction state model

`idle -> visitor_detected -> greeting -> choosing_method -> listening|touching -> recognizing -> confirming -> contacting -> connected -> completed`

例外状態:

`speech_unclear | no_match | person_unavailable | contact_failed | network_degraded | privacy_blocked | human_assistance`

各状態は次を持つ。
- visible cue / spoken cue
- allowed input
- timeout and cancellation
- preserved context
- fallback transition
- PII exposure rule
- telemetry event

## UX pattern contracts

- **Listening**: マイク入力中であること、停止方法、代替のタッチ操作を表示する。
- **Recognition confirmation**: 高確信でも重要な固有名詞・発信先は確認可能にする。
- **Processing**: 処理名と待機理由を示し、長時間時は中止または代替手段を出す。
- **Fallback**: 音声失敗からタッチ、担当者失敗から代表窓口へ文脈を保持して遷移する。
- **Privacy**: フル氏名、電話番号、発話全文を公共画面へ必要以上に残さない。
- **Completion**: 誰へつながったか、次に何をすべきか、受付が終了したかを明示する。

## Issue / implementation contract

来訪者または運用者向け変更は以下を必須記載する。

- Actor / user outcome
- Related journey ID and step
- Entry state / exit state / exception states
- Voice and touch equivalence
- Visible, spoken and haptic/animation response
- Timeout, cancellation and fallback
- PII and audit impact
- Experience acceptance criteria
- Evaluation level and device/browser scope

## Evaluation ladder

1. **Static**: 用語、コントラスト、タップ領域、フォーカス、PII、状態欠落。
2. **State/model**: 正常系・例外系・タイムアウト・取消・フォールバック遷移。
3. **Automated browser**: タッチ導線、権限拒否、無デバイス、ネットワーク失敗。
4. **Instrumentation**: STT/TTS、割込、発信、状態遷移の時間と失敗箇所。
5. **Screenshot**: レイアウト・視線誘導が変わる画面だけ。
6. **Video/agent**: J-OR-01〜05 の変更対象ジャーニーを通しで評価する。
7. **Human/device**: 横向き iPad、騒音、距離、初見ユーザーでリリース前確認する。

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
