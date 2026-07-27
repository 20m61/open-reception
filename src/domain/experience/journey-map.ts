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
 * `domain/presence/state.ts` が正本で、ここは**その 5 系統**（受付 / 画面 / 音声モード /
 * 聞き取り段階 / 来訪検知）を体験設計の 1 本のタイムラインへ写す辞書に徹する。
 *
 * 差分の分析は `docs/experience/state-mapping.md`。**未対応の体験状態はここで明示的に
 * 列挙する**（`UNIMPLEMENTED_EXPERIENCE_STATES`）。実装したのに列挙から外し忘れると
 * テストが落ちるので、「実装したが文書は古いまま」を防げる。
 */
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
  readback: 'confirming',
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
  // 接近しつつある段階。まだ「検知した」と断定しないので体験状態は動かさない。
  CANDIDATE: null,
  ATTRACT: 'visitor_detected',
  // 受付が始まっている間は受付状態機械側が権威。
  ACTIVE: null,
  COOLDOWN: null,
};

/**
 * 聞き取り中の段階 → 体験状態。**全 `VoiceListeningStage` を網羅する**。
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
 * **実装に対応する状態が無い**体験状態（`docs/experience/state-mapping.md` §5 B / D）。
 *
 * ここに載っている＝「画面は正しく振る舞うが、状態として観測・記録できない」。README の
 * Outcome metrics（0 件復帰率・音声失敗後の復帰率・状態不明による連打）は、この状態が
 * 実装されるまで状態からは導けない。
 *
 * **実装したらここから外す。** 外し忘れるとテストが落ちる（対応表と実装の乖離を検出する）。
 */
export const UNIMPLEMENTED_EXPERIENCE_STATES: readonly AnyExperienceState[] = [
  // 「音声かタッチか」を選ぶ局面が状態として無い（idle の quick actions が兼ねる）。
  // **観測目的しか無い**ため、状態を増やす価値は低い（第 37 wave の判断）。
  'choosing_method',
  // 検索 0 件は画面内の分岐で、状態ではない。ただし 0 件率の計測は第 35 wave で
  // サーバまで通っており、**指標のためには状態化を要さない**。
  'no_match',
  // PII 表示抑止は常時表示の privacy notice で担保しており、状態としては存在しない。
  'privacy_blocked',
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
    steps: ['listening', 'speech_unclear', 'confirming', 'touching'],
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
  ]) {
    for (const value of Object.values(table)) {
      if (value !== null) mapped.add(value);
    }
  }
  return mapped;
}
