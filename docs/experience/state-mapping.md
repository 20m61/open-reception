# Journey / 状態モデルと実装の対応表（差分洗い出し）

`docs/experience/README.md`（体験設計の正本）が定義する Journey と interaction state model を、
**現行実装の状態語彙へ実際に突き合わせた結果**。第 34 wave（2026-07-27）に作成。

この文書の目的は **#422 の ExperienceShell を作る前に「どこが食い違っているか」を事実として
固定する**こと。いきなり作り替えると、規約が要求する受入条件（Journey ID・state timeline・
音声タッチ等価性）を後付けで正当化することになる。

> 実装の状態語彙は **5 系統に分かれている**。README の 1 本のタイムラインに対応する単一の
> 状態機械は存在しない。これが最大の差分で、以下の個別ギャップの多くはここから派生している。

| 系統 | 定義 | 値 |
| --- | --- | --- |
| 受付の進行 | `src/domain/reception/state.ts` | `idle` / `selectingPurpose` / `selectingTarget` / `inputVisitorInfo` / `confirming` / `calling` / `connected` / `failed` / `timeout` / `cancelled` / `fallback` / `completed`（12） |
| 画面の層 | `src/domain/kiosk/mode.ts` | `signage` / `reception` / `qr_reception` / `completion` / `out_of_hours` / `degraded`（6） |
| 音声対話 | `src/domain/voice-session/kiosk-view.ts` | `inactive` / `idle` / `listening` / `readback` / `speaking` / `ducked` / `fallback`（7） |
| 聞き取り段階 | `voiceListeningStage()`（同上） | `idle` / `speech`（2・`listening` 中の派生） |
| 来訪検知 | `src/domain/presence/state.ts` | `IDLE` / `CANDIDATE` / `ATTRACT` / `ACTIVE` / `COOLDOWN`（5） |

> **第 37 wave の訂正**: 第 34 wave はここを「3 系統」とし、`visitor_detected` と `recognizing` を
> 「状態語彙に無い」と判定したが**いずれも誤り**だった。実際には `PresenceState`（独立した状態機械）と
> `voiceListeningStage`（interim の有無で 2 段階）が在り、**どちらも実装済み**。分析時に
> `ReceptionState` / `KioskMode` / `VoiceKioskMode` の 3 つだけを見て「無い」と結論した
> （第 28 wave と同じ誤り = **無いと書く前に実際に grep する**）。

## 1. 正常系タイムラインの対応

README: `idle -> visitor_detected -> greeting -> choosing_method -> listening|touching -> recognizing -> confirming -> contacting -> connected -> completed`

| README の状態 | 実装での実体 | 判定 |
| --- | --- | --- |
| `idle` | `ReceptionState.idle` + `KioskMode.signage` | **対応** |
| `visitor_detected` | `PresenceState.ATTRACT`（`src/domain/presence/state.ts`。`KioskFlow` は `attractVisible` として受ける） | **対応**（別系統・第 37 wave に訂正）。受付状態機械とは独立に動き、ATTRACT でも受付は開始しない（#362） |
| `greeting` | `ReceptionState.selectingPurpose`（`avatarState='greeting'`） | **名前が違うだけ**。挨拶と目的選択が同一状態 |
| `choosing_method` | 明示状態なし。`idle` の quick actions がその役割 | **状態が無い**（観測できないだけで体験は成立）。用途が観測に限られるため状態化**しない**（第 37 wave） |
| `listening` | `VoiceKioskMode.listening` | 対応（**別系統**） |
| `touching` | 明示状態なし（既定） | 状態が無い（音声との対称性が崩れている） |
| `recognizing` | `voiceListeningStage() === 'speech'`（非空 interim 到着） | **対応**（別系統・第 37 wave に訂正）。`'idle'`（話しかけ待ち）と 2 段階に分かれている |
| `confirming` | タッチ = `ReceptionState.confirming` / 音声 = `VoiceKioskMode.readback` | **2 系統に分かれている**。同じ「確認」が別状態 |
| `contacting` | `ReceptionState.calling`（段階は `CallingStage` で派生） | 対応 |
| `connected` | `ReceptionState.connected` | 対応 |
| `completed` | `ReceptionState.completed` | 対応 |

## 2. 例外状態の対応

| README の例外状態 | 実装での実体 | 判定 |
| --- | --- | --- |
| `speech_unclear` | `VoiceKioskMode.readback`（`readbackReason`）→ `fallback` | 対応（別系統） |
| `no_match` | 明示状態なし。検索 0 件は画面内分岐（`search-no-results-guidance` + チャット導線） | **状態は無いが計測はできる**。0 件率は `searchZeroHitCount` → KPI 集計 → 管理画面まで通っている（第 35 wave）。状態化は**しない** |
| `person_unavailable` | `ReceptionState.timeout` | **対応**（名前が違う） |
| `contact_failed` | `ReceptionState.failed` | **対応**（名前が違う） |
| `network_degraded` | `KioskFlow` のローカル state `online=false` + `KioskMode.degraded`。呼び出し失敗時は `failed` + `failureReason='network'` で**説明を分ける**（第 36 wave） | **部分**。状態としては `failed` に含めたまま、同じ状態の中の説明で区別する（区別のために遷移表を増やすと逃げ道・timeout・戻るの組み合わせが倍になるため） |
| `privacy_blocked` | **無い** | PII 表示抑止は `PrivacyNotice` の常時表示で担保しており、状態としては存在しない |
| `human_assistance` | `ReceptionState.fallback` | **部分**。fallback は「代替導線を出した」であって「有人支援へ引き継いだ」ではない |

## 3. Journey の対応

| Journey | 実装 | 判定 |
| --- | --- | --- |
| J-OR-01 担当者指定受付 | `selectingPurpose → selectingTarget → inputVisitorInfo → confirming → calling → connected → completed` | **実装あり**（e2e `reception-flow.spec.ts`） |
| J-OR-02 部署・目的から受付 | 同一経路で target が department | **実装あり**（同 spec の「部署選択でも呼び出しできる」） |
| J-OR-03 QR 予約受付 | `KioskMode.qr_reception` + `CheckinFlow`（**独立した状態機械**。`CheckinFailureReason` を持つ） | **別の状態機械**。README は同一タイムライン上に置いている |
| J-OR-04 音声認識失敗から復帰 | `VoiceKioskMode.readback / fallback` + タッチ経路への切替 | **部分**。文脈保持（直前の目的・候補）は実装済みだが、状態としての「復帰」は無い |
| J-OR-05 担当者不在・接続失敗 | `timeout` / `failed` → `USE_FALLBACK` → `fallback` | **実装あり** |

## 4. 状態ごとの必須属性（README「各状態は次を持つ」）

README は各状態に visible cue / spoken cue / allowed input / timeout and cancellation /
preserved context / fallback transition / PII exposure rule / telemetry event を要求する。
実装では**分散**している。

| 属性 | 実装の所在 | 判定 |
| --- | --- | --- |
| visible cue | 各 View（`reception-screens.tsx`） | 実装あり・**表として集約されていない** |
| spoken cue | `avatar/guidance.ts` + `speech.ts` の読み上げ | 実装あり |
| allowed input | `ui-contract.ts` の `availableActions` / `REQUIRES_CONFIRMATION_ACTIONS` | **集約済み**（唯一の網羅表） |
| timeout / cancellation | `shouldResetOnInactivity`（#125）+ `CallingStageThresholds`（#323） | 実装あり・状態ごとの表ではない |
| preserved context | reducer（`flow-state.ts`）の各 action | 実装あり（`BACK` は入力値保持・`RESET` は破棄） |
| fallback transition | 遷移表の `USE_FALLBACK` + `escapeHatchesFor` | **部分**（音声→タッチの切替は状態遷移になっていない） |
| PII exposure rule | `PrivacyNotice` + `rules/pii-secret-minimization.md` | 規約として存在・**状態ごとの定義は無い** |
| telemetry event | `experience-metrics.ts`（ステップ滞在・戻る・キャンセル・入力手段） | 実装あり・README の状態名とは対応しない |

## 5. 差分のまとめ（対応の優先順位）

**A. 名前が違うだけ（対応済み・改名不要）**: `greeting` / `person_unavailable` / `contact_failed`。
README の語彙を実装へ持ち込む価値は低い。**対応表（本書）で橋渡しすれば足りる。**

**B. 状態が無く観測できない（追加の価値が高い）**: ~~`visitor_detected` / `choosing_method` /
`recognizing` / `no_match` / `network_degraded`~~ → **第 35〜37 wave で全て解消・却下**。
残る未対応は `choosing_method` / `no_match` / `privacy_blocked` の 3 つで、いずれも
**状態を増やす必要は無い**と判断した（`UNIMPLEMENTED_EXPERIENCE_STATES` の doc に理由を併記）。

| 元の B 項目 | 決着 | wave |
| --- | --- | --- |
| `no_match` | 状態は無いが 0 件率は端末 → KPI → 管理画面まで通した。**指標のためには状態化不要** | 35 |
| `network_degraded` | 状態は `failed` のまま、`failureReason` で**文言だけ分けた**（遷移表を増やさない） | 36 |
| `visitor_detected` | **元から実装済み**（`PresenceState.ATTRACT`）。第 34 wave の判定が誤り | 37 |
| `recognizing` | **元から実装済み**（`voiceListeningStage === 'speech'`）。同上 | 37 |
| `choosing_method` | 観測目的しか無く、`idle` の quick actions で体験は成立している。**追加しない** | 37 |
| `privacy_blocked` | 常時表示の `PrivacyNotice` で担保。抑止の「状態」は存在しない。**追加しない** | 37 |

> **第 35 wave の訂正**: ここで「Outcome metrics が測れない」と一括りにしたが、**状態が無いことと
> 計測できないことは別**だった。`no_match` は状態こそ無いが、担当者検索の 0 件回数は
> `experience-metrics.ts` が既に数えていた（`searchZeroHitCount`）。欠けていたのは**サーバへ
> 送る配線と集計**で、第 35 wave で繋いだ（端末 → `ReceptionExperience` → KPI 集計 → 管理画面）。

> **第 37 wave の訂正**: 残る 4 つを個別に確かめた結果、**2 つは初めから実装されていた**
> （上表）。差分表を作るときに「実装が 3 系統である」という前提自体が誤っていたため、
> 派生した判定もまとめて誤っていた。**「無い」と書く前に、その語を実際に grep する。**
> 対応表の網羅はテスト（`journey-map.test.ts`）が固定しているので、以後この種の
> 取りこぼしはテストで落ちる。

**C. 系統が分かれていて等価性が担保されていない（設計判断が要る）**:
`confirming` がタッチ（`ReceptionState.confirming`）と音声（`VoiceKioskMode.readback`）で
別系統。README の原則 2「音声とタッチで同じ目的を達成できる」は**実装では 2 つの状態機械の
協調**で成立しており、機械的に保証されていない。ExperienceShell の中核はここ。

**D. 別の状態機械（統合するか否かが仕様判断）**: J-OR-03 QR 受付（`CheckinFlow`）。

## 6. 次の一手

1. ~~B を状態にする前に、まず本書の対応を機械検証にする~~ → **第 34 wave で完了**
   （`src/domain/experience/journey-map.ts`）。
   **5 系統すべて**（受付 / 画面 / 音声モード / 聞き取り段階 / 来訪検知）の各値が README の
   どの状態に対応するかをコードで持ち、網羅を型とテストで固定する。**状態を増やす前に、
   増えたときに漏れが落ちる仕組みを先に作る。**（第 34 wave は 3 系統しか載せておらず、
   第 37 wave に残り 2 系統を追加した。）
2. ~~B の追加（観測できない状態を状態にする）~~ → **第 35〜37 wave で決着**（§5 B の表）。
   **状態は 1 つも増やさずに済んだ**。増やしたのは計測の配線（第 35）と失敗理由の説明
   （第 36）だけで、Journey / 遷移表の意味は変えていない。
3. C の統合（音声とタッチの確認を 1 つの状態機械へ）= **#422 ExperienceShell の中核。
   Journey / state / fallback の意味を変えるため要ユーザー確認**
   （`.claude/rules/opus5-autonomous-loop.md` 停止境界）。
4. D の判断（QR 受付を同一タイムラインへ載せるか）= 同上。
