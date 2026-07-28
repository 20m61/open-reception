# Journey / 状態モデルと実装の対応表（差分洗い出し）

`docs/experience/README.md`（体験設計の正本）が定義する Journey と interaction state model を、
**現行実装の状態語彙へ実際に突き合わせた結果**。第 34 wave（2026-07-27）に作成。

この文書の目的は **#422 の ExperienceShell を作る前に「どこが食い違っているか」を事実として
固定する**こと。いきなり作り替えると、規約が要求する受入条件（Journey ID・state timeline・
音声タッチ等価性）を後付けで正当化することになる。

> 実装の状態語彙は**複数に分かれている**。README の 1 本のタイムラインに対応する単一の
> 状態機械は存在しない。これが最大の差分で、以下の個別ギャップの多くはここから派生している。

**採録基準**: 「その語彙を落とすと README のいずれかの状態が写せなくなる」ものを採る。
`CALLING_STAGES`（`contacting` の内側の段階）のように**ある体験状態の中の段階・演出**は採らない。
除外したものは `journey-map.ts` の `NOT_A_TIMELINE_VOCABULARY` に**理由付きで全件登録**してあり、
`src/domain/**` に新しい状態語彙が生まれて未登録なら**テストが落ちる**。

| 語彙 | 定義 | 値 |
| --- | --- | --- |
| 受付の進行 | `src/domain/reception/state.ts` | `idle` / `selectingPurpose` / `selectingTarget` / `inputVisitorInfo` / `confirming` / `calling` / `connected` / `failed` / `timeout` / `cancelled` / `fallback` / `completed`（12） |
| 画面の層 | `src/domain/kiosk/mode.ts` | `signage` / `reception` / `qr_reception` / `completion` / `out_of_hours` / `degraded`（6） |
| 音声対話 | `src/domain/voice-session/kiosk-view.ts` | `inactive` / `idle` / `listening` / `readback` / `speaking` / `ducked` / `fallback`（7） |
| 聞き取り段階 | `voiceListeningStage()`（同上） | `idle` / `speech`（2・**`listening` 中だけ有効**） |
| 来訪検知 | `src/domain/presence/state.ts` | `IDLE` / `CANDIDATE` / `ATTRACT` / `ACTIVE` / `COOLDOWN`（5） |
| QR 受付 | `src/domain/checkin/state.ts` | `idle` / `selectingMethod` / `checkingCamera` / `scanning` / `resolving` / `confirming` / `calling` / `completed` / `cancelled` / `manualFallback` + エラー 6（16） |

> **第 37 wave の訂正**: 第 34 wave はここを「3 系統」と数え、`visitor_detected` / `recognizing` /
> `choosing_method` を「状態語彙に無い」と判定したが**3 つとも誤り**だった。実際には
> `PresenceState`（独立した状態機械）・`voiceListeningStage`（interim の有無で 2 段階）・
> `CheckinState.selectingMethod`（`ui-contract.ts` に `chooseMethod` の文言まである）に在った。
> **原因は「語彙は 3 つ」と数を仮定したこと**。数を当てるのをやめ、domain の状態語彙を全件
> 採録／除外で登録する方式へ変えた（第 28 wave と同じ誤り = **無いと書く前に実際に grep する**）。

> **「状態が在る」は「計測できる」ではない**（第 35 wave の教訓の逆向き）。対応が付いた状態も
> telemetry へ出ているとは限らない。`PresenceState` はサーバへ送らない設計で、
> `voiceListeningStage` は画面表示専用。Outcome metrics を出すには別途の配線が要る。

## 1. 正常系タイムラインの対応

README: `idle -> visitor_detected -> greeting -> choosing_method -> listening|touching|scanning -> recognizing -> confirming -> contacting -> connected -> completed`
（`scanning` は ADR 0006 で追加した第 3 の入力手段。**等価性の要件は音声とタッチのまま**。）

| README の状態 | 実装での実体 | 判定 |
| --- | --- | --- |
| `idle` | `ReceptionState.idle` + `KioskMode.signage` | **対応** |
| `visitor_detected` | `PresenceState.ATTRACT`（`src/domain/presence/state.ts`。`KioskFlow` は `attractVisible` として受ける） | **対応**（別系統・第 37 wave に訂正）。受付状態機械とは独立に動き、ATTRACT でも受付は開始しない（#362） |
| `greeting` | `ReceptionState.selectingPurpose`（`avatarState='greeting'`） | **名前が違うだけ**。挨拶と目的選択が同一状態 |
| `choosing_method` | QR 受付は `CheckinState.selectingMethod`（`ui-contract.ts` に `chooseMethod`）。通常受付は明示状態なしで `idle` の quick actions が兼ねる | **部分**（第 37 wave に訂正）。QR 導線には在り、通常受付導線には無い |
| `listening` | `VoiceKioskMode.listening` | 対応（**別系統**） |
| `touching` | 明示状態なし（既定） | 状態が無い（音声との対称性が崩れている） |
| `scanning` | `CheckinState.scanning` | **対応**（ADR 0006 で体験設計側に追加）。加速手段であり、失敗時は必ずタッチ経路へ戻せること |
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
| `privacy_blocked` | `CheckinState.cameraError`（カメラ権限拒否）。`RETRY` → 方法選択 / `CHOOSE_MANUAL` → 通常受付で戻れる | **対応**（ADR 0006 で定義を確定）。「PII 表示の抑止」という読み方は却下した（全状態が `PII exposure rule` を持つので重複になる）。マイク側は実 `getUserMedia` 未配線のため未到達 |
| `human_assistance` | `ReceptionState.fallback` | **部分**。fallback は「代替導線を出した」であって「有人支援へ引き継いだ」ではない |

## 3. Journey の対応

| Journey | 実装 | 判定 |
| --- | --- | --- |
| J-OR-01 担当者指定受付 | `selectingPurpose → selectingTarget → inputVisitorInfo → confirming → calling → connected → completed` | **実装あり**（e2e `reception-flow.spec.ts`） |
| J-OR-02 部署・目的から受付 | 同一経路で target が department | **実装あり**（同 spec の「部署選択でも呼び出しできる」） |
| J-OR-03 QR 予約受付 | `KioskMode.qr_reception` + `CheckinFlow`（**独立した状態機械**。`CheckinFailureReason` を持つ） | **別の状態機械**。README は同一タイムライン上に置いている。対応表には第 37 wave に載せた（**写すことと統合することは別**） |
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
`recognizing` / `no_match` / `network_degraded`~~ → **第 35〜37 wave で決着**。
**体験状態は 1 つも増やさずに済んだ**（3 つは元から実装済み、2 つは状態以外の手段で解決）。

| 元の B 項目 | 決着 | wave |
| --- | --- | --- |
| `no_match` | 状態は無いが 0 件率は端末 → KPI → 管理画面まで通した。**指標のためには状態化不要** | 35 |
| `network_degraded` | 状態は `failed` のまま、`failureReason` で**文言だけ分けた**（遷移表を増やさない） | 36 |
| `visitor_detected` | **元から実装済み**（`PresenceState.ATTRACT`）。第 34 wave の判定が誤り | 37 |
| `recognizing` | **元から実装済み**（`voiceListeningStage === 'speech'`）。同上 | 37 |
| `choosing_method` | **QR 導線には元から実装済み**（`CheckinState.selectingMethod`）。通常受付導線には無いが、体験は `idle` の quick actions で成立している | 37 |

残る未対応は **`no_match` だけ**（計測が通っているため状態化不要）。`privacy_blocked` は
ADR 0006 で定義が決まり、`CheckinState.cameraError` へ対応が付いた。

> **第 35 wave の訂正**: ここで「Outcome metrics が測れない」と一括りにしたが、**状態が無いことと
> 計測できないことは別**だった。`no_match` は状態こそ無いが、担当者検索の 0 件回数は
> `experience-metrics.ts` が既に数えていた（`searchZeroHitCount`）。欠けていたのは**サーバへ
> 送る配線と集計**で、第 35 wave で繋いだ（端末 → `ReceptionExperience` → KPI 集計 → 管理画面）。

> **第 37 wave の訂正**: 残る 4 つを個別に確かめた結果、**3 つは初めから実装されていた**
> （上表）。差分表を作るときに「実装が 3 系統である」という前提自体が誤っていたため、
> 派生した判定もまとめて誤っていた。**「無い」と書く前に、その語を実際に grep する。**
>
> なお `choosing_method` は、この訂正を書いた第 37 wave 自身が**最初「状態化しない」と誤って
> 決着させかけた**（独立レビューが `CheckinState.selectingMethod` を指摘して発覚）。
> 「無いと書く前に grep する」と書いた同じコミットで守れていなかったので、**規律ではなく
> 仕組みで止める**ことにした: `journey-map.test.ts` が `src/domain/**` の状態語彙を全件
> 走査し、採録も除外もされていない語彙があればテストが落ちる。第 34 wave の誤りは
> 「表に載せなかった語彙」で起きたため、表の内側の網羅テストだけでは検出できなかった。

**C. 系統が分かれていて等価性が担保されていない（設計判断が要る）**:
`confirming` がタッチ（`ReceptionState.confirming`）と音声（`VoiceKioskMode.readback`）で
別系統。README の原則 2「音声とタッチで同じ目的を達成できる」は**実装では 2 つの状態機械の
協調**で成立しており、機械的に保証されていない。ExperienceShell の中核はここ。

**D. 別の状態機械（統合するか否かが仕様判断）**: J-OR-03 QR 受付（`CheckinFlow`）。

## 6. 次の一手

1. ~~B を状態にする前に、まず本書の対応を機械検証にする~~ → **第 34 wave で完了**
   （`src/domain/experience/journey-map.ts`）。
   **採録した 6 語彙すべて**（受付 / 画面 / 音声モード / 聞き取り段階 / 来訪検知 / QR 受付）の
   各値が README のどの状態に対応するかをコードで持ち、網羅を型とテストで固定する。
   **状態を増やす前に、増えたときに漏れが落ちる仕組みを先に作る。**（第 34 wave は 3 語彙しか
   載せておらず、第 37 wave に残り 3 語彙の追加と、**未登録語彙を検出するメタテスト**を足した。）
2. ~~B の追加（観測できない状態を状態にする）~~ → **第 35〜37 wave で決着**（§5 B の表）。
   **状態は 1 つも増やさずに済んだ**。増やしたのは計測の配線（第 35）と失敗理由の説明
   （第 36）だけで、Journey / 遷移表の意味は変えていない。
3. C の統合（音声とタッチの確認を 1 つの状態機械へ）= **#422 ExperienceShell の中核。
   Journey / state / fallback の意味を変えるため要ユーザー確認**
   （`.claude/rules/opus5-autonomous-loop.md` 停止境界）。
4. D の判断（QR 受付を同一タイムラインへ載せるか）= 同上。**対応表に載せることは第 37 wave に
   済ませた**ので、残るのは状態機械を 1 本にするかどうかの仕様判断だけ。
5. ~~README 側で埋めるべき定義が 2 つ~~ → **ADR 0006 で決着**。`privacy_blocked` は
   「プライバシー権限を許可されず**その入力手段では**続行できない状態」、`scanning` は
   **第 3 の入力手段**（ただし等価性の要件は音声とタッチのまま）。どちらも既に在る振る舞いに
   名前と境界を与えただけで、遷移も画面も増えていない。
