/**
 * 受付状態ごとの手続き的ポーズ・ジェスチャー (issue #31)。
 *
 * 正規ライセンスの .vrma モーションが無くても、状態に応じた所作の variation を与える。
 * arms-down の idle rest pose（vrm-idle.ts）を基準に、状態ごとに控えめな差分を重ね、
 * 一部の状態は時間変化（手を振る/頷く/会釈）を加える。すべて純データ/純関数で定義し、
 * VrmAvatarViewer が `.vrma` 非再生時に humanoid 正規化ボーンへ適用する。実描画は実機 UAT（#65）。
 *
 * 値は安全側（rest からの小さな変位）に留め、未調整でも破綻しないようにしている。
 * 腕の向きの符号は dev 実描画で確定（左 upperArm +Z / 右 -Z で下ろす）。
 */
import type { AvatarState } from '@/domain/reception/ui-contract';
import { IDLE_REST_POSE, breathingRotation, swayRotation, type BoneEuler } from './vrm-idle';

/** 状態ごとの「rest pose からの上書き差分」。idle は上書きなし（rest のまま）。 */
const STATE_OVERRIDES: Partial<Record<AvatarState, Readonly<Record<string, BoneEuler>>>> = {
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

function addAxis(base: BoneEuler | undefined, axis: 'x' | 'y' | 'z', delta: number): BoneEuler {
  return { ...(base ?? {}), [axis]: (base?.[axis] ?? 0) + delta };
}

/**
 * 状態 + 経過秒から、適用すべき humanoid ボーン回転（Euler, ラジアン）を解決する純関数。
 * ベース(rest) + 状態上書き + 常時の生命感(呼吸/揺れ) + 状態別の動的モーションを合成する。
 */
export function resolveStatePose(
  state: AvatarState,
  elapsedSec: number,
): Record<string, BoneEuler> {
  const pose: Record<string, BoneEuler> = {};
  // ベース: idle rest pose。
  for (const [bone, e] of Object.entries(IDLE_REST_POSE)) pose[bone] = { ...e };
  // 状態の上書きをマージ。
  for (const [bone, e] of Object.entries(STATE_OVERRIDES[state] ?? {})) {
    pose[bone] = { ...(pose[bone] ?? {}), ...e };
  }
  // 常時の生命感: 呼吸(spine.x) と 揺れ(chest.z) を加算。
  pose.spine = addAxis(pose.spine, 'x', breathingRotation(elapsedSec));
  pose.chest = addAxis(pose.chest, 'z', swayRotation(elapsedSec));
  // 状態別の動的モーション。
  if (state === 'greeting') {
    // 右手を小さく振る。
    pose.rightLowerArm = addAxis(pose.rightLowerArm, 'z', Math.sin(elapsedSec * 6) * 0.25);
  } else if (state === 'confirming') {
    // 小さく頷く。
    pose.neck = addAxis(pose.neck, 'x', Math.abs(Math.sin(elapsedSec * 2.5)) * 0.06);
  } else if (state === 'farewell') {
    // ゆっくり会釈（前傾を周期的に深める）。
    pose.spine = addAxis(pose.spine, 'x', Math.abs(Math.sin(elapsedSec * 1.2)) * 0.06);
  }
  return pose;
}
