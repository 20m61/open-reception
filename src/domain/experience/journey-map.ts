/**
 * 体験設計（`docs/experience/README.md`）の Journey / 状態モデルと、実装の状態語彙の対応
 * (issue #422 / #418)。
 *
 * **なぜコードで持つか**: 対応表を文書だけに置くと、状態を増やしたときに更新されず必ず腐る。
 * 実装の状態を `Record<状態, 体験状態>` で受けておけば、`ReceptionState` や `VoiceKioskMode` に
 * 値が増えた時点で**型エラーとして落ちる**（対応を書かずには増やせない）。
 *
 * **この module は判定をしない。** 受付の遷移は `domain/reception/state.ts`、画面の層は
 * `domain/kiosk/mode.ts`、音声は `domain/voice-session/kiosk-view.ts`、来訪検知は
 * `domain/presence/state.ts`、QR 受付は `domain/checkin/state.ts` が正本で、ここは
 * **その 6 語彙**を体験設計の 1 本のタイムラインへ写す辞書に徹する。
 *
 * **採録基準**（第 37 wave に明文化）: 「その語彙を落とすと README のいずれかの状態が
 * 写せなくなる」ものだけを採る。`CALLING_STAGES` のように**ある体験状態の中の段階**を
 * 表すものは採らない（`contacting` の内側であって、別の状態には写らない）。除外したものは
 * `NOT_A_TIMELINE_VOCABULARY` に理由付きで全件登録し、テストが取りこぼしを検出する。
 *
 * 差分の分析は `docs/experience/state-mapping.md`。**未対応の体験状態はここで明示的に
 * 列挙する**（`UNIMPLEMENTED_EXPERIENCE_STATES`）。実装したのに列挙から外し忘れると
 * テストが落ちるので、「実装したが文書は古いまま」を防げる。
 *
 * **「状態が在る」は「計測できる」を意味しない。** ここで対応が付いた状態も、telemetry へ
 * 出ているとは限らない（例: `PresenceState` はサーバへ送らない設計、`voiceListeningStage` は
 * 画面表示専用）。README の Outcome metrics を出す話は別途の配線が要る。
 */
import type { CheckinState } from '@/domain/checkin/state';
import type { KioskMode } from '@/domain/kiosk/mode';
import type { PresenceState } from '@/domain/presence/state';
import type { ReceptionState } from '@/domain/reception/state';
import type { VoiceKioskMode, VoiceListeningStage } from '@/domain/voice-session/kiosk-view';

/** 体験設計の正常系タイムライン（`docs/experience/README.md` interaction state model）。 */
export const EXPERIENCE_STATES = [
  'idle',
  'visitor_detected',
  'greeting',
  'choosing_method',
  'listening',
  'touching',
  // QR スキャン（ADR 0006）。**加速手段**であって、音声とタッチの等価性の要件には含めない
  // （QR は予約済みの来訪者しか持たず、無くても通常受付で完遂できる）。
  'scanning',
  'recognizing',
  'confirming',
  'contacting',
  'connected',
  'completed',
] as const;
export type ExperienceState = (typeof EXPERIENCE_STATES)[number];

/** 体験設計の例外状態。 */
export const EXPERIENCE_EXCEPTION_STATES = [
  'speech_unclear',
  'no_match',
  'person_unavailable',
  'contact_failed',
  'network_degraded',
  'privacy_blocked',
  'human_assistance',
] as const;
export type ExperienceExceptionState = (typeof EXPERIENCE_EXCEPTION_STATES)[number];

export type AnyExperienceState = ExperienceState | ExperienceExceptionState;

/**
 * 受付進行状態 → 体験状態。**全 `ReceptionState` を網羅する**（値が増えたら型エラー）。
 *
 * `cancelled` は体験設計に対応する状態が無い（中断は「完了」でも「失敗」でもない）。
 * README の Outcome metrics は中断を「受付完遂率」の分母側で扱うため、状態としては
 * 持たれていない。ここでは null にして**対応が無いことを明示**する。
 */
export const RECEPTION_STATE_TO_EXPERIENCE: Record<ReceptionState, AnyExperienceState | null> = {
  idle: 'idle',
  // 挨拶と目的選択が同一状態。体験設計は greeting を独立させているが、実装は 1 状態で兼ねる。
  selectingPurpose: 'greeting',
  selectingTarget: 'touching',
  inputVisitorInfo: 'touching',
  confirming: 'confirming',
  calling: 'contacting',
  connected: 'connected',
  timeout: 'person_unavailable',
  failed: 'contact_failed',
  fallback: 'human_assistance',
  completed: 'completed',
  cancelled: null,
};

/** 音声対話モード → 体験状態。**全 `VoiceKioskMode` を網羅する**。 */
export const VOICE_MODE_TO_EXPERIENCE: Record<VoiceKioskMode, AnyExperienceState | null> = {
  inactive: null,
  idle: 'idle',
  listening: 'listening',
  // **発信直前の `confirming` ではない**（ADR 0007）。readback が確認するのは「聞き取った内容」で、
  // README の UX pattern「Recognition confirmation」に当たる＝ `recognizing` の内側の 1 局面。
  // 音声で相手を決めても必ず inputVisitorInfo → confirming を通るため、発信前の確認ゲートは
  // 受付状態機械に 1 つしかない。**保証の実体は `VoiceSessionHooks` が `onResolved` しか
  // 公開していないこと**（`lib/voice-session/exposure-guard.test.ts` が固定）。
  // `REQUIRES_CONFIRMATION_ACTIONS` はチャット経路と宣言値にしか使われておらず、音声は止めない。
  readback: 'recognizing',
  // 読み上げ中・ダッキング中は体験状態を変えない（同じ状態の中の演出）。
  speaking: null,
  ducked: null,
  fallback: 'speech_unclear',
};

/**
 * 来訪検知 → 体験状態。**全 `PresenceState` を網羅する**。
 *
 * 第 34 wave の分析では「`visitor_detected` は状態語彙に無い」としたが**誤り**で、
 * `domain/presence/state.ts` に独立した状態機械が在った（第 37 wave に訂正）。
 * 受付状態機械とは別に動き、ATTRACT でも**受付は開始しない**（画面が反応するだけ, #362）。
 */
export const PRESENCE_STATE_TO_EXPERIENCE: Record<PresenceState, AnyExperienceState | null> = {
  IDLE: 'idle',
  // 接近しつつある段階。まだ「検知した」と断定しないので体験状態は動かさない
  // （`candidateMax` 超過で IDLE へ戻る＝通行人の横切りを切り捨てる）。
  CANDIDATE: null,
  ATTRACT: 'visitor_detected',
  // **現在の配線では未到達**: `attract-detector.ts` は MOTION しか流さず、TAP / SESSION_ENDED /
  // TIMEOUT はどこからも渡らない。ドメインとしては ATTRACT + TAP で ACTIVE へ入り
  // `session_started` を発火する。配線したら受付状態機械側が権威になる（体験状態はそちらが持つ）。
  ACTIVE: null,
  COOLDOWN: null,
};

/**
 * 聞き取り中の段階 → 体験状態。**全 `VoiceListeningStage` を網羅する**。
 *
 * **`VoiceKioskMode === 'listening'` のときだけ有効な条件付きの表**（`voiceListeningStage()` は
 * それ以外で null を返す）。キー `idle` は `VOICE_MODE_TO_EXPERIENCE.idle` とは**別物**で、
 * 「聞き取り中だがまだ発話が来ていない」を指す。
 *
 * 第 34 wave の分析では「認識中と傾聴中を区別していない」としたが**誤り**で、
 * `voiceListeningStage` が interim の有無で 2 段階に分けている（第 37 wave に訂正）。
 */
export const VOICE_LISTENING_STAGE_TO_EXPERIENCE: Record<
  VoiceListeningStage,
  AnyExperienceState | null
> = {
  // 話しかけ待ち（interim 未着）。
  idle: 'listening',
  // 発話検知中（非空の interim が来ている）= 認識中。
  speech: 'recognizing',
};

/** 画面の層 → 体験状態。**全 `KioskMode` を網羅する**。 */
export const KIOSK_MODE_TO_EXPERIENCE: Record<KioskMode, AnyExperienceState | null> = {
  signage: 'idle',
  reception: null, // 受付中。細かい局面は ReceptionState 側が持つ。
  qr_reception: null, // J-OR-03。独立した状態機械（CheckinFlow）。
  completion: 'completed',
  out_of_hours: null, // 営業時間外は体験設計のタイムライン外（受付を開始しない）。
  degraded: 'network_degraded',
};

/**
 * QR 受付 → 体験状態。**全 `CheckinState` を網羅する**。
 *
 * 第 34 wave / 第 37 wave はこの語彙を対応表に載せておらず、そのせいで `choosing_method` を
 * 「明示状態なし」と誤判定していた（`selectingMethod` が実在し、`ui-contract.ts` に
 * `chooseMethod` の文言まで在る）。**写すことと統合することは別**で、ここに載せても
 * `CheckinFlow` は独立した状態機械のまま（統合の是非は仕様判断・`state-mapping.md` §5 D）。
 */
export const CHECKIN_STATE_TO_EXPERIENCE: Record<CheckinState, AnyExperienceState | null> = {
  idle: 'idle',
  // README の choosing_method に対応する**唯一の実装**（通常受付側には無い）。
  selectingMethod: 'choosing_method',
  // 機器の準備。来訪者から見た局面が変わるわけではない。
  checkingCamera: null,
  // QR をかざす局面。第 3 の入力手段として ADR 0006 で体験設計側に定義した。
  scanning: 'scanning',
  // トークン照合中。README の recognizing は音声認識の局面を指すので当てない。
  resolving: null,
  confirming: 'confirming',
  calling: 'contacting',
  completed: 'completed',
  cancelled: null,
  // 通常受付フロー（別の状態機械）へ引き継ぐ局面。有人支援ではない。
  manualFallback: null,
  // カメラ拒否。ADR 0006 で `privacy_blocked` を「プライバシーに関わる権限を許可しなかったため
  // **その入力手段では**続行できない状態」と定義した。受付自体は失敗しておらず、`RETRY` で
  // 方法選択へ、`CHOOSE_MANUAL` で通常受付へ戻れる（行き止まりにしない）。
  cameraError: 'privacy_blocked',
  // QR が読めない・不正。README の例外語彙に対応が無い（no_match は担当者検索 0 件を指す）。
  scanError: null,
  expiredError: null,
  usedError: null,
  revokedError: null,
  networkError: 'network_degraded',
};

/**
 * 対応表が写す**元**の語彙（採録基準を満たしたもの）。名前で持つのは、`src/domain/**` に
 * 新しい状態語彙が生まれたときに「採録も除外もしていない」を検出するため。
 */
export const SOURCE_VOCABULARIES = [
  'RECEPTION_STATES',
  'KIOSK_MODES',
  'VOICE_KIOSK_MODES',
  'VOICE_LISTENING_STAGES',
  'PRESENCE_STATES',
  'CHECKIN_STATES',
] as const;

/**
 * **意図的に採録しない**語彙と、その理由。
 *
 * 第 34 wave の誤りの原因は「実装の状態語彙は 3 系統」と数を仮定したことだった。数を当てるのを
 * やめ、**domain に在る状態語彙を全件ここへ登録する**（採録するか、理由を書いて除外するか）。
 * 登録漏れはテストが落とす。
 */
export const NOT_A_TIMELINE_VOCABULARY: Record<string, string> = {
  // ある体験状態の「中」の段階・演出であって、別の状態には写らない。
  CALLING_STAGES: 'contacting の内側の段階（呼出中 → 応答待ち → 長期化）',
  AVATAR_STATES: '各状態の中でのアバターの見え方。状態そのものではない',
  CALL_STATUSES: '呼び出し 1 件の進捗。contacting / connected の内側',
  KIOSK_WAIT_STATUSES: '担当者応答の待ち表示。contacting の内側',
  PRIVACY_STATES: 'PII の保持状況（none / collecting / retained）。局面ではなく属性',
  INPUT_MODES: '入力手段（touch / voice）。状態ではなく、状態が許す入力の種類',
  TURN_LIFECYCLE_STATES: '音声ターンの寿命管理。listening / recognizing の内側の実装詳細',
  BARGE_IN_PHASES: '割込制御の位相。読み上げ中の内側の実装詳細',
  TTS_GENERATION_STATES: '読み上げ音声の生成・再生の進捗。体験状態は変えない',
  TTS_PLAYBACK_STATES: '読み上げの再生進捗。speaking / ducked の内側で、体験状態は変えない',
  VOICE_TRANSPORT_LIFECYCLE_STATES: '音声トランスポートの接続管理。来訪者からは見えない',
  AI_GUIDANCE_STATES: 'AI 案内の生成状況。表示内容の出所であって局面ではない',
  CHECKIN_ERROR_STATES: 'CHECKIN_STATES の部分集合（エラー種別の抽出）。二重登録を避ける',
  // 受付端末の体験タイムラインの外。
  DEMO_PUBLICATION_STATUSES: 'デモ公開物の管理状態。来訪者の受付体験ではない',
  DEMO_INITIAL_MODES: 'デモ再生の開始条件。実端末の受付タイムラインではない',
  DEMO_INPUT_MODES: 'デモ再生で許す入力手段。実来訪者の局面ではない',
  DEMO_RUNTIME_STATES: 'デモ再生ランタイムの進行。実端末の受付タイムラインではない',
  EXPERIENCE_VERSION_STATUSES: '体験設定の版管理（draft / published）。運用者側の状態',
  DEPLOYMENT_STATUSES: '端末への反映状況。運用者側の状態',
};

/**
 * **実装に対応する状態が無い**体験状態（`docs/experience/state-mapping.md` §5 B / D）。
 *
 * ここに載っている＝「画面は正しく振る舞うが、状態として観測・記録できない」。README の
 * Outcome metrics（0 件復帰率・音声失敗後の復帰率・状態不明による連打）は、この状態が
 * 実装されるまで状態からは導けない。
 *
 * **実装したらここから外す。** 外し忘れるとテストが落ちる（対応表と実装の乖離を検出する）。
 */
export const UNIMPLEMENTED_EXPERIENCE_STATES: readonly AnyExperienceState[] = [
  // 検索 0 件は画面内の分岐で、状態ではない。ただし 0 件率の計測は第 35 wave で
  // サーバまで通っており、**指標のためには状態化を要さない**。
  'no_match',
];

export type JourneyId = 'J-OR-01' | 'J-OR-02' | 'J-OR-03' | 'J-OR-04' | 'J-OR-05';

export type JourneyDefinition = {
  id: JourneyId;
  title: string;
  /** 体験設計での主要ステップ（正常系）。 */
  steps: readonly AnyExperienceState[];
  /** 実装状況。`separate_state_machine` は別の状態機械で実現されているもの。 */
  implementation: 'implemented' | 'partial' | 'separate_state_machine';
};

/** `docs/experience/README.md` の Core journeys と実装の対応。 */
export const JOURNEYS: readonly JourneyDefinition[] = [
  {
    id: 'J-OR-01',
    title: '担当者指定受付',
    steps: ['idle', 'greeting', 'touching', 'confirming', 'contacting', 'connected', 'completed'],
    implementation: 'implemented',
  },
  {
    id: 'J-OR-02',
    title: '部署・目的から受付',
    steps: ['idle', 'greeting', 'touching', 'confirming', 'contacting', 'connected', 'completed'],
    implementation: 'implemented',
  },
  {
    id: 'J-OR-03',
    title: 'QR 予約受付',
    steps: ['idle', 'confirming', 'contacting', 'completed'],
    // `CheckinFlow` が独立した状態機械を持つ（`CheckinFailureReason`）。統合の是非は仕様判断。
    implementation: 'separate_state_machine',
  },
  {
    id: 'J-OR-04',
    title: '音声認識失敗から復帰',
    // 発信直前の `confirming` には到達しない Journey。復唱確認は `recognizing` の内側なので
    // ここには現れない（ADR 0007 で `readback` の写し先を訂正した際に合わせた）。
    steps: ['listening', 'speech_unclear', 'recognizing', 'touching'],
    // 文脈保持は実装済みだが、「復帰」そのものは状態になっていない。
    implementation: 'partial',
  },
  {
    id: 'J-OR-05',
    title: '担当者不在・接続失敗',
    steps: ['contacting', 'person_unavailable', 'human_assistance', 'completed'],
    implementation: 'implemented',
  },
];

/** 実装のいずれかの状態から到達できる体験状態の集合。 */
export function mappedExperienceStates(): Set<AnyExperienceState> {
  const mapped = new Set<AnyExperienceState>();
  for (const table of [
    RECEPTION_STATE_TO_EXPERIENCE,
    VOICE_MODE_TO_EXPERIENCE,
    VOICE_LISTENING_STAGE_TO_EXPERIENCE,
    KIOSK_MODE_TO_EXPERIENCE,
    PRESENCE_STATE_TO_EXPERIENCE,
    CHECKIN_STATE_TO_EXPERIENCE,
  ]) {
    for (const value of Object.values(table)) {
      if (value !== null) mapped.add(value);
    }
  }
  return mapped;
}
