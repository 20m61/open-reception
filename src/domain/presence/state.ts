/**
 * 来訪者検知（presence detection）の状態遷移モデル (issue #79)。
 *
 * iPad を往来に設置する前提では「人が映った＝受付開始」は誤発火が多い。
 * そこで段階的に処理を重くする 5 状態を持ち、純粋関数で遷移を制御する。
 * 実カメラ・Canvas・MediaPipe には依存しない（次増分で配線）。
 *
 *   IDLE      … 待機。Canvas 差分の軽量モーション検知のみ。AI 推論は動かさない。
 *   CANDIDATE … 中央ゾーンに動きがあった。短時間だけ顔検出を起動して見極める。
 *   ATTRACT   … 端末前に人がいそう。画面だけ軽く反応する（音声/通話は出さない）。
 *   ACTIVE    … 受付開始。session_started / visitor_intent_confirmed を発火する状態。
 *   COOLDOWN  … 発火直後/セッション終了後の再発火抑制。一定時間後に IDLE へ戻る。
 *
 * このモジュールは「状態 + 入力 + パラメータ → 次状態 + 副作用ヒント」を返すだけで、
 * タイマ実体やイベント送信は呼び出し側（次増分のフック/コンポーネント）が持つ。
 */

export const PRESENCE_STATES = [
  'IDLE',
  'CANDIDATE',
  'ATTRACT',
  'ACTIVE',
  'COOLDOWN',
] as const;

export type PresenceState = (typeof PRESENCE_STATES)[number];

/**
 * 状態機械への入力。実 DOM ではなく抽象化したシグナルとして渡す。
 * - motionLevel: 中央ゾーンの正規化モーション量 (0..1)。motion-diff.ts が算出。
 * - faceDetected: 顔検出の結果（CANDIDATE 中の短時間推論）。
 * - tapped: 画面タップ（明示操作）。
 * - tick: 経過時間の通知（ms 単位の累積/差分は呼び出し側が管理しエッジで渡す）。
 */
export type PresenceInput =
  | { type: 'MOTION'; motionLevel: number }
  | { type: 'FACE'; faceDetected: boolean }
  | { type: 'TAP' }
  | { type: 'TIMEOUT'; timer: PresenceTimer }
  | { type: 'SESSION_ENDED' }
  | { type: 'RESET' };

/** タイムアウトの種類。状態ごとに意味が異なるため明示する。 */
export type PresenceTimer =
  | 'candidateMax' // CANDIDATE の最大滞在を超えた（顔が取れず IDLE へ戻す）
  | 'attractMax' // ATTRACT で無操作のまま一定時間（IDLE へ戻す）
  | 'cooldownDone'; // COOLDOWN 経過（IDLE へ戻す）

/**
 * 誤発火抑制のためのチューニング可能パラメータ。
 * しきい値/タイマはすべてここに集約し、設置環境ごとに調整できるようにする。
 */
export type PresenceConfig = {
  /** IDLE→CANDIDATE に必要な中央ゾーンのモーション量しきい値 (0..1)。 */
  motionEnterThreshold: number;
  /** CANDIDATE の最大滞在時間 (ms)。3〜5 秒を想定。超過で IDLE へ戻す。 */
  candidateMaxMs: number;
  /** ATTRACT で無操作のまま IDLE へ戻すまでの時間 (ms)。 */
  attractTimeoutMs: number;
  /** 発火後の再発火抑制時間 (ms)。15〜30 秒を想定。 */
  cooldownMs: number;
};

/** 既定パラメータ。issue #79 の方針（低負荷・誤発火抑制）に沿う初期値。 */
export const DEFAULT_PRESENCE_CONFIG: PresenceConfig = {
  motionEnterThreshold: 0.12,
  candidateMaxMs: 4000,
  attractTimeoutMs: 8000,
  cooldownMs: 20000,
};

/**
 * 遷移結果。次状態に加えて、呼び出し側が張り直すべきタイマと、
 * 発火すべきサーバーイベント（あれば）をヒントとして返す。
 */
export type PresenceTransition = {
  /** 遷移後の状態。 */
  state: PresenceState;
  /** この状態の間 計測すべきタイマ（張り直す）。なければ null。 */
  armTimer: PresenceTimer | null;
  /**
   * サーバーへ発火すべきイベント。issue #79 の方針に従い IDLE 中の motion は送らない。
   * ACTIVE 突入時のみ session_started を発火する。
   */
  emit: PresenceServerEvent | null;
};

/** サーバーへ送ってよいイベント（逐次 motion ログは送らない）。 */
export type PresenceServerEvent = 'visitor_intent_confirmed' | 'session_started';

const NOOP = (state: PresenceState): PresenceTransition => ({
  state,
  armTimer: null,
  emit: null,
});

/**
 * 純粋関数の状態遷移。現在状態・入力・パラメータから次状態を決める。
 * 不正/無関係な入力は現状維持（NOOP）として扱い、例外は投げない
 * （連続イベントが流れ込む検知ループで握りつぶしを避けるため）。
 */
export function presenceTransition(
  state: PresenceState,
  input: PresenceInput,
  config: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
): PresenceTransition {
  // RESET と SESSION_ENDED はどの状態からでも扱う（端末復帰/セッション終了）。
  if (input.type === 'RESET') {
    return NOOP('IDLE');
  }
  if (input.type === 'SESSION_ENDED') {
    return { state: 'COOLDOWN', armTimer: 'cooldownDone', emit: null };
  }

  switch (state) {
    case 'IDLE':
      // 中央ゾーンのモーションがしきい値を超えたら候補化。それ以外は待機継続。
      if (input.type === 'MOTION' && input.motionLevel >= config.motionEnterThreshold) {
        return { state: 'CANDIDATE', armTimer: 'candidateMax', emit: null };
      }
      return NOOP('IDLE');

    case 'CANDIDATE':
      // 短時間の顔検出で「端末に用がありそう」と判断したら ATTRACT。
      if (input.type === 'FACE') {
        return input.faceDetected
          ? { state: 'ATTRACT', armTimer: 'attractMax', emit: null }
          : NOOP('CANDIDATE');
      }
      // 最大滞在を超えたら IDLE へ戻す（通行人の横切りを切り捨てる）。
      if (input.type === 'TIMEOUT' && input.timer === 'candidateMax') {
        return NOOP('IDLE');
      }
      return NOOP('CANDIDATE');

    case 'ATTRACT':
      // タップ（明示操作）で受付開始。session_started を発火。
      if (input.type === 'TAP') {
        return { state: 'ACTIVE', armTimer: null, emit: 'session_started' };
      }
      // 無操作のまま一定時間経過したら待機へ戻る。
      if (input.type === 'TIMEOUT' && input.timer === 'attractMax') {
        return NOOP('IDLE');
      }
      return NOOP('ATTRACT');

    case 'ACTIVE':
      // 受付中。終了通知で COOLDOWN へ（上の SESSION_ENDED で処理済み）。
      // それ以外（モーション/タップ）は無視して受付セッションを保護する。
      return NOOP('ACTIVE');

    case 'COOLDOWN':
      // 抑制時間が経過したら待機へ戻る。途中のモーション/タップは無視する。
      if (input.type === 'TIMEOUT' && input.timer === 'cooldownDone') {
        return NOOP('IDLE');
      }
      return NOOP('COOLDOWN');

    default:
      return NOOP(state);
  }
}

/** ACTIVE は受付セッション進行中であることを示す。 */
export function isActive(state: PresenceState): boolean {
  return state === 'ACTIVE';
}

/** AI（顔検出）を起動してよいのは CANDIDATE の間だけ（低負荷方針）。 */
export function shouldRunFaceDetection(state: PresenceState): boolean {
  return state === 'CANDIDATE';
}
