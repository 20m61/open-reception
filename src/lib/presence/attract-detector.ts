/**
 * ATTRACT 検知の純ロジック (issue #362)。
 *
 * `usePresenceCamera`（DOM/カメラに依存する薄いフック）から検知ロジックを切り出し、
 * 実カメラなしでユニットテストできるようにする。issue #79 の presence 状態機械
 * （`src/domain/presence/state.ts`）に「継続モーションを ATTRACT の軽量近似とみなす」
 * 判定を重ねるだけで、**受付開始（session start）は一切扱わない**。
 *
 * 重要な境界（issue #362 の核心）:
 *   - ここが返すのは「ATTRACT に達した（画面だけ反応してよい）」というシグナルのみ。
 *   - 受付開始（KioskMode: reception/qr_reception への遷移）は、呼び出し側が
 *     ATTRACT オーバーレイの明示 CTA タップを受けたときにだけ行う。本モジュールから
 *     直接 startReception 相当を呼び出してはならない。
 */
import {
  DEFAULT_PRESENCE_CONFIG,
  presenceTransition,
  type PresenceConfig,
  type PresenceState,
} from '@/domain/presence/state';

/** CANDIDATE が一定回数連続でモーションを観測したら ATTRACT 相当とみなす（顔検出の軽量代替）。 */
export const DEFAULT_CANDIDATE_TICKS_TO_ATTRACT = 2;

export type AttractDetectorState = {
  presence: PresenceState;
  candidateTicks: number;
  /** ATTRACT シグナル済み（オーバーレイ表示中）。resumeAttractDetector まで再発火しない。 */
  attractSignaled: boolean;
};

export const INITIAL_ATTRACT_DETECTOR_STATE: AttractDetectorState = {
  presence: 'IDLE',
  candidateTicks: 0,
  attractSignaled: false,
};

export type AttractDetectorResult = {
  state: AttractDetectorState;
  /** この tick で ATTRACT に新規到達したときだけ true（一度だけ）。 */
  attractSignal: boolean;
};

/**
 * 1 サンプル分のモーション量を処理し、次状態と ATTRACT シグナルを返す純関数。
 *
 * - `attractSignaled` の間はどんなモーションも無視する（多重発火防止。オーバーレイ表示中に
 *   受付を壊さないことが目的。呼び出し側が `resumeAttractDetector` するまで固定）。
 * - 通行人の横切り（単発の高モーション→すぐ低下）は candidateTicks がリセットされ
 *   ATTRACT に到達しない。
 */
export function stepAttractDetector(
  state: AttractDetectorState,
  motionLevel: number,
  config: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
  ticksToAttract: number = DEFAULT_CANDIDATE_TICKS_TO_ATTRACT,
): AttractDetectorResult {
  if (state.attractSignaled) {
    return { state, attractSignal: false };
  }

  const transition = presenceTransition(state.presence, { type: 'MOTION', motionLevel }, config);

  if (transition.state === 'CANDIDATE') {
    const overThreshold = motionLevel >= config.motionEnterThreshold;
    const candidateTicks = overThreshold ? state.candidateTicks + 1 : 0;
    if (candidateTicks >= ticksToAttract) {
      return {
        state: { presence: 'ATTRACT', candidateTicks: 0, attractSignaled: true },
        attractSignal: true,
      };
    }
    return {
      state: { presence: transition.state, candidateTicks, attractSignaled: false },
      attractSignal: false,
    };
  }

  return {
    state: { presence: transition.state, candidateTicks: 0, attractSignaled: false },
    attractSignal: false,
  };
}

/**
 * ATTRACT オーバーレイのタイムアウト（無操作で待機へ戻る）または受付開始で呼ぶ。
 * 検知状態を初期化し、次の来訪者を再検知できるようにする。
 */
export function resumeAttractDetector(): AttractDetectorState {
  return INITIAL_ATTRACT_DETECTOR_STATE;
}
