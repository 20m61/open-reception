/**
 * 体験設計（`docs/experience/README.md`）の Journey / 状態モデルと、実装の状態語彙の対応
 * (issue #422 / #418)。
 *
 * **なぜコードで持つか**: 対応表を文書だけに置くと、状態を増やしたときに更新されず必ず腐る。
 * 実装の状態を `Record<状態, 体験状態>` で受けておけば、`ReceptionState` や `VoiceKioskMode` に
 * 値が増えた時点で**型エラーとして落ちる**（対応を書かずには増やせない）。
 *
 * **この module は判定をしない。** 受付の遷移は `domain/reception/state.ts`、画面の層は
 * `domain/kiosk/mode.ts`、音声は `domain/voice-session/kiosk-view.ts` が正本で、ここは
 * その 3 系統を体験設計の 1 本のタイムラインへ写す辞書に徹する。
 *
 * 差分の分析は `docs/experience/state-mapping.md`。**未対応の体験状態はここで明示的に
 * 列挙する**（`UNIMPLEMENTED_EXPERIENCE_STATES`）。実装したのに列挙から外し忘れると
 * テストが落ちるので、「実装したが文書は古いまま」を防げる。
 */
import type { KioskMode } from '@/domain/kiosk/mode';
import type { ReceptionState } from '@/domain/reception/state';
import type { VoiceKioskMode } from '@/domain/voice-session/kiosk-view';

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
  // 来訪検知は `attractVisible`（KioskFlow のローカル state）で表現され、状態語彙に無い。
  'visitor_detected',
  // 「音声かタッチか」を選ぶ局面が状態として無い（idle の quick actions が兼ねる）。
  'choosing_method',
  // 認識中と傾聴中を区別していない（interim 表示はあるが状態ではない）。
  'recognizing',
  // 検索 0 件は画面内の分岐で、状態ではない。
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
    KIOSK_MODE_TO_EXPERIENCE,
  ]) {
    for (const value of Object.values(table)) {
      if (value !== null) mapped.add(value);
    }
  }
  return mapped;
}
