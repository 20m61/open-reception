/**
 * 受付状態ごとの手続き的ポーズ・ジェスチャー (issue #31 / #1085)。
 *
 * 正規ライセンスの .vrma モーションが無くても、状態に応じた所作の variation を与える。
 * arms-down の idle rest pose（vrm-idle.ts）を基準に、状態ごとに控えめな差分を重ね、
 * 一部の状態は時間変化（手を振る/頷く/会釈）を加える。すべて純データ/純関数で定義し、
 * VrmAvatarViewer が `.vrma` 非再生時に humanoid 正規化ボーンへ適用する。実描画は実機 UAT（#65）。
 *
 * #1085 では固定周期だけの「揺れている人形」感を減らすため、呼吸/揺れに加えて
 * deterministic な低周波 micro-motion を頭・首・上体へ薄く重ねる。
 * #1098 では既存 `AvatarBehavior.phase` を presentation-only の倍率として重ね、受付上の
 * AvatarState / gesture / semantic gaze を変えずに会話局面ごとの「静けさ」だけを調整する。
 *
 * 値は安全側（rest からの小さな変位）に留め、未調整でも破綻しないようにしている。
 * 腕の向きの符号は dev 実描画で確定（左 upperArm +Z / 右 -Z で下ろす）。
 */
import type { AvatarBehaviorPhase } from '@/domain/avatar/behavior';
import type { AvatarState } from '@/domain/reception/ui-contract';
import {
  DEFAULT_NATURAL_MOTION_SEED,
  IDLE_REST_POSE,
  breathingRotation,
  naturalMicroMotion,
  swayRotation,
  type BoneEuler,
  type BonePose,
  type HumanoidBoneName,
  type MutableNaturalMicroMotion,
} from './vrm-idle';

/** 状態ごとの「rest pose からの上書き差分」。idle は上書きなし（rest のまま）。 */
const STATE_OVERRIDES: Partial<Record<AvatarState, Readonly<BonePose>>> = {
  // 挨拶: 右手を上げ気味にして（後段で小さく振る）、わずかに前を向く。
  greeting: { rightUpperArm: { z: -0.6, x: 0.15 }, rightLowerArm: { z: -0.5, x: -0.2 } },
  // 案内: 選択肢へ軽く体を向け、右手を少し開いて提示する。
  guiding: { spine: { y: 0.06 }, rightUpperArm: { z: -0.95, x: 0.2 } },
  // 傾聴: 前傾＋首を少し下げ、聞く姿勢。
  listening: { spine: { x: 0.07 }, neck: { x: 0.09 } },
  // 確認: 小首をかしげる（後段で小さく頷く）。
  confirming: { neck: { z: 0.13, x: 0.05 } },
  // 呼び出し中: 両手を前で軽く合わせ、安心感のある姿勢。
  calling: { leftUpperArm: { z: 0.95, x: 0.3 }, rightUpperArm: { z: -0.95, x: 0.3 } },
  // 通話中: 控えめ（rest）。
  connected: {},
  // お詫び: 軽いお辞儀（前傾＋首）。
  apologizing: { spine: { x: 0.13 }, neck: { x: 0.1 } },
  // 見送り: 会釈。
  farewell: { spine: { x: 0.1 }, neck: { x: 0.07 } },
};

/**
 * 状態ごとの micro-motion 強度。
 * 「聞いている/通話中/お詫び」のような集中・静けさが必要な局面では動きを抑える。
 * これは受付フロー状態ではなく描画パラメータであり、状態遷移を所有しない。
 */
const MICRO_MOTION_INTENSITY: Record<AvatarState, number> = {
  idle: 1,
  greeting: 0.65,
  guiding: 0.75,
  listening: 0.45,
  confirming: 0.55,
  calling: 0.5,
  connected: 0.35,
  apologizing: 0.45,
  farewell: 0.6,
};

/**
 * 会話局面による presentation-only の natural-motion 倍率 (#1098)。
 * `ambient=1` は従来挙動を完全維持する。既存 AvatarState 別強度との積にも使い、
 * 呼吸・状態固有 gesture・semantic gaze は変更しない。
 */
const BEHAVIOR_MICRO_MOTION_SCALE: Record<AvatarBehaviorPhase, number> = {
  ambient: 1,
  listening: 0.5,
  thinking: 0.8,
  speaking: 0.65,
};

/** `Object.entries` はキーを `string` に落とすので、ボーン名の型を保って列挙する。 */
export function poseEntries(pose: Readonly<BonePose>): Array<[HumanoidBoneName, BoneEuler]> {
  return Object.entries(pose).filter((entry): entry is [HumanoidBoneName, BoneEuler] => Boolean(entry[1]));
}

const STATE_POSE_BUFFER_BONES = [
  'spine',
  'chest',
  'neck',
  'head',
  'leftUpperArm',
  'leftLowerArm',
  'rightUpperArm',
  'rightLowerArm',
] as const satisfies readonly HumanoidBoneName[];

export type StatePoseBuffer = {
  /** Viewer が normalized bones へ転写する caller-owned 出力。 */
  pose: BonePose;
  /** naturalMicroMotion の一時値。毎フレーム新しい object を作らない。 */
  microMotion: MutableNaturalMicroMotion;
};

/** 24h kiosk の hot path で使う再利用バッファ。VRM 読込ごとに 1 回だけ作る。 */
export function createStatePoseBuffer(): StatePoseBuffer {
  const pose: BonePose = {};
  for (let index = 0; index < STATE_POSE_BUFFER_BONES.length; index += 1) {
    const bone = STATE_POSE_BUFFER_BONES[index];
    if (bone) pose[bone] = {};
  }
  return {
    pose,
    microMotion: { headX: 0, headY: 0, neckX: 0, neckY: 0, chestY: 0 },
  };
}

export type ResolveStatePoseOptions = {
  /** 指定時は pose / bone / microMotion の object identity を保ったまま上書きする。 */
  buffer?: StatePoseBuffer;
  /** VRT / harness は固定値、本番 viewer は VRM 読込単位の seed を渡す。 */
  naturalMotionSeed?: number;
  /**
   * 描画専用の会話局面 (#1098)。未指定は `ambient` = 従来挙動。
   * AvatarState の意味・状態固有 gesture は変えず、natural motion の振幅だけを調整する。
   */
  behaviorPhase?: AvatarBehaviorPhase;
};

function clearPose(pose: BonePose): void {
  for (const rawBone in pose) {
    const rotation = pose[rawBone as HumanoidBoneName];
    if (!rotation) continue;
    rotation.x = undefined;
    rotation.y = undefined;
    rotation.z = undefined;
  }
}

function rotationFor(pose: BonePose, bone: HumanoidBoneName): BoneEuler {
  const existing = pose[bone];
  if (existing) return existing;
  const created: BoneEuler = {};
  pose[bone] = created;
  return created;
}

function mergeRotation(pose: BonePose, bone: HumanoidBoneName, source: BoneEuler): void {
  const target = rotationFor(pose, bone);
  if (source.x !== undefined) target.x = source.x;
  if (source.y !== undefined) target.y = source.y;
  if (source.z !== undefined) target.z = source.z;
}

function addAxis(pose: BonePose, bone: HumanoidBoneName, axis: 'x' | 'y' | 'z', delta: number): void {
  const rotation = rotationFor(pose, bone);
  rotation[axis] = (rotation[axis] ?? 0) + delta;
}

/**
 * 状態 + 経過秒から、適用すべき humanoid ボーン回転（Euler, ラジアン）を解決する純関数。
 * ベース(rest) + 状態上書き + 常時の生命感 + 状態別の動的モーションを合成する。
 */
export function resolveStatePose(
  state: AvatarState,
  elapsedSec: number,
  options?: ResolveStatePoseOptions,
): BonePose {
  const buffer = options?.buffer;
  const pose = buffer?.pose ?? {};
  if (buffer) clearPose(pose);

  // ベース: idle rest pose。
  for (const [bone, e] of poseEntries(IDLE_REST_POSE)) mergeRotation(pose, bone, e);
  // 状態の上書きをマージ。
  for (const [bone, e] of poseEntries(STATE_OVERRIDES[state] ?? {})) {
    mergeRotation(pose, bone, e);
  }

  const seed = options?.naturalMotionSeed ?? DEFAULT_NATURAL_MOTION_SEED;
  const behaviorScale = BEHAVIOR_MICRO_MOTION_SCALE[options?.behaviorPhase ?? 'ambient'];
  // 常時の生命感: 呼吸(spine.x) は維持し、左右の sway(chest.z) だけ会話phaseに合わせて静かにする。
  addAxis(pose, 'spine', 'x', breathingRotation(elapsedSec, seed));
  addAxis(pose, 'chest', 'z', swayRotation(elapsedSec, seed) * behaviorScale);

  // さらに微小な非反復 motion を頭/首/上体へ。UI gaze は viewer 側でこの後に加算される。
  const micro = naturalMicroMotion(elapsedSec, seed, buffer?.microMotion);
  const microIntensity = MICRO_MOTION_INTENSITY[state] * behaviorScale;
  addAxis(pose, 'head', 'x', micro.headX * microIntensity);
  addAxis(pose, 'head', 'y', micro.headY * microIntensity);
  addAxis(pose, 'neck', 'x', micro.neckX * microIntensity);
  addAxis(pose, 'neck', 'y', micro.neckY * microIntensity);
  addAxis(pose, 'chest', 'y', micro.chestY * microIntensity);

  // 状態別の動的モーション。
  if (state === 'greeting') {
    // 右手を小さく振る。
    addAxis(pose, 'rightLowerArm', 'z', Math.sin(elapsedSec * 6) * 0.25);
  } else if (state === 'confirming') {
    // 小さく頷く。
    addAxis(pose, 'neck', 'x', Math.abs(Math.sin(elapsedSec * 2.5)) * 0.06);
  } else if (state === 'farewell') {
    // ゆっくり会釈（前傾を周期的に深める）。
    addAxis(pose, 'spine', 'x', Math.abs(Math.sin(elapsedSec * 1.2)) * 0.06);
  }
  return pose;
}
