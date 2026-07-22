/**
 * 日本語ターン終了判定 (issue #372)。
 *
 * issue #372 の状態モデル:
 * ```text
 * USER_SPEAKING → POSSIBLE_END → TURN_COMMITTED
 * ```
 *
 * 「固定無音時間だけを真実源にしない」（issue AC）ため、必要無音時間 (`requiredSilenceMs`) を
 * テキストの末尾表現・短答判定・スロットから動的に決める純関数として実装する。
 * 「最大待機時間を設け、永遠に待たない」ため `maxWaitMs` を安全弁として持つ。
 *
 * Smart Turn 等の学習済みターン検出モデルへ置換する場合は `TurnEndDecider` を差し替えるだけで
 * よい（`decideTurnEnd` はその参照実装）。
 */
import type { TurnSlot } from './types';
import type { VoiceEvalTurnTrigger } from '@/domain/voice/evaluation-events';

/** 短い無音で確定してよい短答（issue #372「『はい』『いいえ』等の短答は短い無音で確定可能」）。 */
export const DEFAULT_SHORT_ANSWER_PATTERNS: readonly string[] = [
  'はい',
  'いいえ',
  'うん',
  'ええ',
  'いや',
  'そうです',
  '違います',
  'お願いします',
];

/**
 * 直後に待機時間を延長すべき末尾表現
 * （issue #372「『けど』『ので』『ですが』『えーと』『あの』直後は待機時間を延長する」）。
 */
export const DEFAULT_FILLER_TAIL_PATTERNS: readonly string[] = ['けど', 'ので', 'ですが', 'えーと', 'あの', 'えっと', 'あのー'];

export type TurnDetectorConfig = {
  /** 既定の必要無音時間（短答でも末尾フィラーでもない通常発話）。 */
  baseSilenceMs: number;
  /** 短答と判定できた場合の必要無音時間（base より短い）。 */
  shortAnswerSilenceMs: number;
  /** 末尾がフィラー/接続助詞の場合に base へ加算する延長分。 */
  fillerExtensionMs: number;
  /** スロットごとの必要無音時間の加算（自由用件は言い淀みが多いため長めに取れる）。 */
  slotExtensionMs: Partial<Record<TurnSlot, number>>;
  /** これを超えて無音が続いたら、他の条件を無視して強制的に確定する（安全弁）。 */
  maxWaitMs: number;
  shortAnswerPatterns: readonly string[];
  fillerTailPatterns: readonly string[];
};

export const DEFAULT_TURN_DETECTOR_CONFIG: TurnDetectorConfig = {
  baseSilenceMs: 500,
  shortAnswerSilenceMs: 250,
  fillerExtensionMs: 900,
  slotExtensionMs: { free_form: 300 },
  maxWaitMs: 2500,
  shortAnswerPatterns: DEFAULT_SHORT_ANSWER_PATTERNS,
  fillerTailPatterns: DEFAULT_FILLER_TAIL_PATTERNS,
};

function endsWithFillerTail(text: string, patterns: readonly string[]): boolean {
  const trimmed = text.trim();
  return patterns.some((p) => trimmed.endsWith(p));
}

function isShortAnswer(text: string, patterns: readonly string[]): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  return patterns.some((p) => trimmed === p || trimmed.startsWith(p));
}

/** その時点までの認識テキスト・スロットから、確定に必要な無音時間を求める。 */
export function requiredSilenceMs(text: string, slot: TurnSlot | undefined, config: TurnDetectorConfig = DEFAULT_TURN_DETECTOR_CONFIG): number {
  const slotExtension = slot ? (config.slotExtensionMs[slot] ?? 0) : 0;

  // フィラー/接続助詞の直後は延長を最優先する —— 短答パターン（「はい」等）と語頭が一致しても、
  // 「はい、ですが」のように続く場合は待つべきだから。
  if (endsWithFillerTail(text, config.fillerTailPatterns)) {
    return config.baseSilenceMs + config.fillerExtensionMs + slotExtension;
  }
  if (isShortAnswer(text, config.shortAnswerPatterns)) {
    return config.shortAnswerSilenceMs + slotExtension;
  }
  return config.baseSilenceMs + slotExtension;
}

export type TurnEndObservation = {
  /** 現時点までの認識テキスト（partial/final）。 */
  text: string;
  /** 直前の発話終了からの経過無音時間（ms）。 */
  silenceMs: number;
  slot?: TurnSlot;
};

export type TurnEndDecision = {
  commit: boolean;
  trigger: VoiceEvalTurnTrigger;
  /** 判定に使った必要無音時間（診断用）。 */
  requiredSilenceMs: number;
};

/**
 * ターンを確定してよいか判定する（参照実装。`TurnEndDecider` として差し替え可能）。
 *
 * 優先順位: 1) 最大待機時間を超えたら無条件に確定（安全弁, trigger: 'rule'）。
 *           2) 動的な必要無音時間を満たしたら確定（trigger: 'silence'）。
 *           3) それ以外は待つ。
 */
export function decideTurnEnd(observation: TurnEndObservation, config: TurnDetectorConfig = DEFAULT_TURN_DETECTOR_CONFIG): TurnEndDecision {
  const required = requiredSilenceMs(observation.text, observation.slot, config);

  if (observation.silenceMs >= config.maxWaitMs) {
    return { commit: true, trigger: 'rule', requiredSilenceMs: required };
  }
  if (observation.silenceMs >= required) {
    return { commit: true, trigger: 'silence', requiredSilenceMs: required };
  }
  return { commit: false, trigger: 'silence', requiredSilenceMs: required };
}

/** `decideTurnEnd` と同じ入出力を持つ差し替え可能な判定器。Smart Turn 等の置換点。 */
export type TurnEndDecider = (observation: TurnEndObservation, config?: TurnDetectorConfig) => TurnEndDecision;

// ---------------------------------------------------------------------------
// ターンのライフサイクル状態機械（issue #372「turn candidate / committed / cancelled のイベント」）
// ---------------------------------------------------------------------------

export const TURN_LIFECYCLE_STATES = ['idle', 'user_speaking', 'possible_end', 'committed'] as const;
export type TurnLifecycleState = (typeof TURN_LIFECYCLE_STATES)[number];

export type TurnLifecycleEvent =
  | { type: 'candidate' } // POSSIBLE_END へ入った（無音が始まったが、まだ確定条件を満たさない）。
  | { type: 'committed'; trigger: VoiceEvalTurnTrigger }
  | { type: 'cancelled' }; // POSSIBLE_END 中にユーザーが発話を再開し、確定を取り消した。

export type TurnDetectorState = {
  lifecycle: TurnLifecycleState;
  /** 現ターンで認識済みのテキスト（無音が続く間は更新されない）。 */
  text: string;
};

export function initialTurnDetectorState(): TurnDetectorState {
  return { lifecycle: 'idle', text: '' };
}

export type TurnDetectorTick =
  | { type: 'speech-started' }
  | { type: 'speech-ended'; text: string }
  | { type: 'silence-tick'; silenceMs: number; slot?: TurnSlot };

/**
 * ターン状態機械を 1 ステップ進める。`speech-ended` で POSSIBLE_END へ入り（`candidate` を発行）、
 * `silence-tick` の無音時間が `decideTurnEnd` の閾値を満たすまでは待ち、満たしたら `committed`
 * を発行する。POSSIBLE_END 中に `speech-started`（発話再開）が来たら `cancelled` を発行して
 * USER_SPEAKING へ戻る —— 相づちで「確定しかけて取り消す」を表現するのではなく、あくまで
 * **同一ユーザーの発話継続**（言い直し等）を表す（barge-in の相づち/割り込み分類は
 * `near-end-classifier.ts` が別途 BOT_SPEAKING 側で担う）。
 */
export function advanceTurnDetector(
  state: TurnDetectorState,
  tick: TurnDetectorTick,
  config: TurnDetectorConfig = DEFAULT_TURN_DETECTOR_CONFIG,
  decide: TurnEndDecider = decideTurnEnd,
): { state: TurnDetectorState; emitted: TurnLifecycleEvent[] } {
  if (state.lifecycle === 'committed') {
    // 終端状態。呼び出し側が新しいターンを始める際は initialTurnDetectorState() から作り直す。
    return { state, emitted: [] };
  }

  switch (tick.type) {
    case 'speech-started': {
      if (state.lifecycle === 'possible_end') {
        return { state: { lifecycle: 'user_speaking', text: state.text }, emitted: [{ type: 'cancelled' }] };
      }
      return { state: { lifecycle: 'user_speaking', text: state.text }, emitted: [] };
    }
    case 'speech-ended': {
      return { state: { lifecycle: 'possible_end', text: tick.text }, emitted: [{ type: 'candidate' }] };
    }
    case 'silence-tick': {
      if (state.lifecycle !== 'possible_end') return { state, emitted: [] };
      const decision = decide({ text: state.text, silenceMs: tick.silenceMs, slot: tick.slot }, config);
      if (!decision.commit) return { state, emitted: [] };
      return { state: { lifecycle: 'committed', text: state.text }, emitted: [{ type: 'committed', trigger: decision.trigger }] };
    }
    default:
      return { state, emitted: [] };
  }
}
