/**
 * semantic gaze の上へ足す、ごく小さな natural gaze overlay (#1100)。
 *
 * open-reception の視線の真実源は `gazeTargetFor(screenState) -> gazeOffsetFor(target, layout)`。
 * このモジュールはそれを置き換えず、micro-saccade と短い gaze-break の加算量だけを返す。
 * Comu の自然視線の考え方を参考にしつつ、実装は smoothValueNoise を使って独立に構成する。
 */
import type { AvatarBehaviorPhase } from '@/domain/avatar/behavior';
import { DEFAULT_NATURAL_MOTION_SEED, smoothValueNoise } from './vrm-idle';
import type { GazeOffset } from './vrm-gaze';

const SEMANTIC_GAZE_OVERLAY_SCALE = 0.35;
const GAZE_BREAK_CYCLE_SEC = 11;
const MAX_GAZE_YAW = 0.5;
const MAX_GAZE_PITCH = 0.35;

/** 会話中の「視線の遊び」の強さ。listening は相手へ最も集中させる。 */
const PHASE_SCALE: Record<AvatarBehaviorPhase, number> = {
  ambient: 1,
  listening: 0.2,
  thinking: 1.1,
  speaking: 0.45,
};

export type NaturalGazeOptions = Readonly<{
  seed?: number;
  behaviorPhase?: AvatarBehaviorPhase;
  /** `GazeTarget !== 'none'` のとき true。semantic gaze を維持するため overlay を縮小する。 */
  semanticGazeActive?: boolean;
}>;

function normalizedNoise(value: number): number {
  return (value + 1) * 0.5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function gazeBreakEnvelope(elapsedSec: number, seed: number): { weight: number; cycle: number } {
  const safeElapsed = Math.max(0, elapsedSec);
  const cycle = Math.floor(safeElapsed / GAZE_BREAK_CYCLE_SEC);
  const local = safeElapsed - cycle * GAZE_BREAK_CYCLE_SEC;

  // 1 cycle に1回、開始時刻と長さをseed依存で揺らす。break終了は必ずcycle境界より前。
  const start = 4.5 + normalizedNoise(smoothValueNoise(cycle * 0.79, seed + 307)) * 2.5;
  const duration = 0.8 + normalizedNoise(smoothValueNoise(cycle * 0.61, seed + 331)) * 0.8;
  if (local < start || local > start + duration) return { weight: 0, cycle };

  const progress = (local - start) / duration;
  // 0 -> 1 -> 0。開始/終了時にsnapしない。
  const weight = Math.sin(Math.PI * progress) ** 2;
  return { weight, cycle };
}

/**
 * natural gaze overlay を解決する。
 *
 * - micro-saccade: 小さく速めの smooth noise
 * - gaze-break: 約11秒ごとに1回、0.8〜1.6秒だけ少し大きいoffsetを滑らかに加える
 * - semantic gaze中は全体を0.35倍
 * - caller-owned targetを渡せば毎frame object allocationなし
 */
export function naturalGazeOffset(
  elapsedSec: number,
  options?: NaturalGazeOptions,
  target?: GazeOffset,
): GazeOffset {
  const seed = options?.seed ?? DEFAULT_NATURAL_MOTION_SEED;
  const phaseScale = PHASE_SCALE[options?.behaviorPhase ?? 'ambient'];
  const semanticScale = options?.semanticGazeActive === true ? SEMANTIC_GAZE_OVERLAY_SCALE : 1;
  const scale = phaseScale * semanticScale;

  const microYaw = smoothValueNoise(elapsedSec * 1.7, seed + 211) * 0.005;
  const microPitch = smoothValueNoise(elapsedSec * 1.35, seed + 227) * 0.0035;

  const gazeBreak = gazeBreakEnvelope(elapsedSec, seed);
  const breakYaw =
    smoothValueNoise(gazeBreak.cycle * 0.83, seed + 353) * 0.018 * gazeBreak.weight;
  const breakPitch =
    smoothValueNoise(gazeBreak.cycle * 0.71, seed + 379) * 0.01 * gazeBreak.weight;

  const result = target ?? { yaw: 0, pitch: 0 };
  result.yaw = (microYaw + breakYaw) * scale;
  result.pitch = (microPitch + breakPitch) * scale;
  return result;
}

/**
 * semantic gaze と natural overlay を最終 gaze へ合成する。
 * base を先に置き、その上へ overlay を足すだけ。最終値は既存 gaze の安全可動域でclampする。
 * caller-owned targetを渡せば render hot path で object allocation を増やさない。
 */
export function composeGazeOffsets(
  base: Readonly<GazeOffset>,
  overlay: Readonly<GazeOffset>,
  target?: GazeOffset,
): GazeOffset {
  const result = target ?? { yaw: 0, pitch: 0 };
  result.yaw = clamp(base.yaw + overlay.yaw, -MAX_GAZE_YAW, MAX_GAZE_YAW);
  result.pitch = clamp(base.pitch + overlay.pitch, -MAX_GAZE_PITCH, MAX_GAZE_PITCH);
  return result;
}
