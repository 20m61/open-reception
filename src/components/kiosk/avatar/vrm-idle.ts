/**
 * VRM の手続き的アイドル姿勢・呼吸 (issue #31)。
 *
 * モーション（.vrma）が割り当てられていない待機時、T-pose のままだと不自然なため、
 * コードで「腕を下ろした自然な立ち姿（A-pose 相当）」と「ゆるやかな呼吸」を与える。
 * 外部モーションアセットに依存しない（ライセンス・配信不要）純データ/純関数で定義し、
 * VrmAvatarViewer が humanoid 正規化ボーンへ適用する。実描画の確認は実機 UAT（#65）。
 *
 * 注意: .vrma モーション再生中は AnimationMixer がボーンを駆動するため、本姿勢は適用しない
 *       （VrmAvatarViewer 側で「再生中でない」ときのみ適用）。
 */

/** ボーンに与えるオイラー回転（ラジアン）。未指定軸は 0。 */
export type BoneEuler = { x?: number; y?: number; z?: number };

/**
 * T-pose（腕が水平）から自然な立ち姿へ落とすための固定回転。
 * VRM 正規化空間では左上腕は +X、右上腕は −X を向くため、Z 回りに回して下ろす。
 * 値は控えめな A-pose（上腕 約60°・前腕を軽く内側）。実機で微調整可（#65）。
 */
export const IDLE_REST_POSE: Readonly<Record<string, BoneEuler>> = {
  leftUpperArm: { z: 1.25, x: 0.05 },
  rightUpperArm: { z: -1.25, x: 0.05 },
  leftLowerArm: { z: 0.15 },
  rightLowerArm: { z: -0.15 },
};

/** 呼吸の微小回転（spine の前後傾き, ラジアン）。経過秒の sine。約 ±0.025rad・周期 ~4.5s。 */
export function breathingRotation(elapsedSec: number): number {
  return Math.sin(elapsedSec * 1.4) * 0.025;
}

/** 体の自然な揺れ（chest の左右, ラジアン）。呼吸とは別位相でゆっくり。約 ±0.015rad。 */
export function swayRotation(elapsedSec: number): number {
  return Math.sin(elapsedSec * 0.6) * 0.015;
}
