/**
 * VRM の手続き的アイドル姿勢・自然な微動 (issue #31 / #1085)。
 *
 * モーション（.vrma）が割り当てられていない待機時、T-pose のままだと不自然なため、
 * コードで「腕を下ろした自然な立ち姿（A-pose 相当）」と、呼吸・揺れ・頭/首の微動を与える。
 * 外部モーションアセットに依存しない（ライセンス・配信不要）純データ/純関数で定義し、
 * VrmAvatarViewer が humanoid 正規化ボーンへ適用する。実描画の確認は実機 UAT（#65）。
 *
 * #1085 では Comu の procedural idle から「固定 sine だけに依存しない」「seed で決定論化できる」
 * という原則を取り込み、コード自体は open-reception 向けに独立実装している。
 *
 * 注意: .vrma モーション再生中は AnimationMixer がボーンを駆動するため、本姿勢は適用しない
 *       （VrmAvatarViewer 側で「再生中でない」ときのみ適用）。
 */

/** ボーンに与えるオイラー回転（ラジアン）。未指定軸は 0。 */
export type BoneEuler = { x?: number; y?: number; z?: number };

/**
 * 手続き的ポーズが触る humanoid ボーン名。VRM 仕様の `VRMHumanBoneName` の**部分集合**で、
 * `vrm-pose.test.ts` が型レベルで部分集合であることを固定する（three-vrm を実行時に
 * import せず、綴りの誤りを typecheck で落とす。以前は `string` だったので
 * `getNormalizedBoneNode` に何を渡しても通り、誤字は実機で「動かない」としてしか出なかった）。
 */
export type HumanoidBoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'rightUpperArm'
  | 'rightLowerArm';

/** ボーン名 → 回転。手続き的ポーズの単位。 */
export type BonePose = Partial<Record<HumanoidBoneName, BoneEuler>>;

/**
 * T-pose（腕が水平）から自然な立ち姿へ落とすための固定回転。
 * VRM 正規化空間では左上腕は +X、右上腕は −X を向くため、Z 回りに回して下ろす。
 * 値は控えめな A-pose（上腕 約60°・前腕を軽く内側）。実機で微調整可（#65）。
 */
export const IDLE_REST_POSE: Readonly<BonePose> = {
  leftUpperArm: { z: 1.25, x: 0.05 },
  rightUpperArm: { z: -1.25, x: 0.05 },
  leftLowerArm: { z: 0.15 },
  rightLowerArm: { z: -0.15 },
};

/** VRT / unit test で同じ軌跡を再現するための既定 seed。 */
export const DEFAULT_NATURAL_MOTION_SEED = 0x51f15e;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smootherStep(value: number): number {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 整数格子に対する軽量な deterministic hash。戻り値は -1..1。
 * Math.random() を使わないため、seed と時刻が同じなら必ず同じ軌跡になる。
 */
function hashSigned(index: number, seed: number): number {
  let x = (index ^ seed) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return ((x >>> 0) / 0xffffffff) * 2 - 1;
}

/**
 * 1D smooth value noise。外部依存を増やさず、低周波の非反復な variation を作る。
 * time は任意の連続値。戻り値はおおむね -1..1。
 */
export function smoothValueNoise(time: number, seed = DEFAULT_NATURAL_MOTION_SEED): number {
  const base = Math.floor(time);
  const fraction = time - base;
  const a = hashSigned(base, seed);
  const b = hashSigned(base + 1, seed);
  const t = smootherStep(fraction);
  return a + (b - a) * t;
}

/**
 * FPS 非依存の指数追従。今後 .vrma / gesture と procedural overlay の強度を滑らかに
 * 切り替える際の共通 helper として使う。deltaSec <= 0 の場合は current を返す。
 */
export function expDecay(current: number, target: number, ratePerSec: number, deltaSec: number): number {
  if (deltaSec <= 0 || ratePerSec <= 0) return current;
  return target + (current - target) * Math.exp(-ratePerSec * deltaSec);
}

/**
 * 呼吸の微小回転（spine の前後傾き, ラジアン）。
 * 基本周期は従来の約4.5秒を維持しつつ、位相と深さを低周波 noise でわずかに揺らす。
 * 最大振幅は従来の ±0.025rad を超えない。
 */
export function breathingRotation(
  elapsedSec: number,
  seed = DEFAULT_NATURAL_MOTION_SEED,
): number {
  const phaseNoise0 = smoothValueNoise(0, seed + 11);
  const phaseNoise = smoothValueNoise(elapsedSec * 0.12, seed + 11) - phaseNoise0;
  const depthNoise = (smoothValueNoise(elapsedSec * 0.08, seed + 23) + 1) * 0.5;
  const depth = 0.021 + depthNoise * 0.003; // 0.021..0.024rad
  const phase = elapsedSec * 1.4 + phaseNoise * 0.22;
  return Math.sin(phase) * depth;
}

/**
 * 体の自然な揺れ（chest の左右, ラジアン）。
 * 単一 sine のループ感を避けるため、速度の異なる2つの smooth noise を重ねる。
 * 最大でも概ね ±0.014rad とし、従来の ±0.015rad より安全側に留める。
 */
export function swayRotation(
  elapsedSec: number,
  seed = DEFAULT_NATURAL_MOTION_SEED,
): number {
  const slow = smoothValueNoise(elapsedSec * 0.17, seed + 37) * 0.009;
  const verySlow = smoothValueNoise(elapsedSec * 0.07, seed + 53) * 0.005;
  return slow + verySlow;
}

export type NaturalMicroMotion = Readonly<{
  headX: number;
  headY: number;
  neckX: number;
  neckY: number;
  chestY: number;
}>;

/**
 * 頭・首・上体へ足すごく小さな非反復 motion。
 * UI gaze は VrmAvatarViewer で後から加算されるため、この値は「視線先」そのものを所有しない。
 */
export function naturalMicroMotion(
  elapsedSec: number,
  seed = DEFAULT_NATURAL_MOTION_SEED,
): NaturalMicroMotion {
  return {
    headX: smoothValueNoise(elapsedSec * 0.22, seed + 71) * 0.006,
    headY: smoothValueNoise(elapsedSec * 0.19, seed + 89) * 0.008,
    neckX: smoothValueNoise(elapsedSec * 0.16, seed + 107) * 0.003,
    neckY: smoothValueNoise(elapsedSec * 0.14, seed + 131) * 0.004,
    chestY: smoothValueNoise(elapsedSec * 0.09, seed + 149) * 0.006,
  };
}
