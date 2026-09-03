/**
 * VRM 読込直後の「公式例どおりの後処理」を 1 箇所にまとめる (three-vrm 3.5 準拠の点検で追加)。
 *
 * `@pixiv/three-vrm` の公式例（`packages/three-vrm/examples/basic.html` /
 * `packages/three-vrm-animation/examples/loader-plugin.html`）は読込後に必ず次を行う:
 *
 * 1. `VRMUtils.removeUnnecessaryVertices(scene)` … 未参照頂点を落とす
 * 2. `VRMUtils.combineSkeletons(scene)` … スケルトンを統合して描画呼び出しを減らす
 *    （旧 `removeUnnecessaryJoints` は deprecated。次のメジャーで削除される）
 * 3. `VRMUtils.combineMorphs(vrm)` … 表情に基づいてモーフを統合し VRAM を減らす。
 *    **モバイル GPU でのシェーダエラーを防ぐ**（v3.3.0 のリリースノート）＝ iPad に直結
 * 4. `obj.frustumCulled = false` … スキンメッシュの bounding sphere が動かない三者の
 *    仕様上、腕を大きく動かすと視錐台判定で**モデルが消える**のを防ぐ
 * 5. `VRMLookAtQuaternionProxy` を**名前付きで**足す … 無いと `createVRMAnimationClip` が
 *    console.warn しながら自動生成する（挙動は同じだが警告がノイズになる）
 *
 * ここへ寄せた理由は 2 つ:
 * - `VrmAvatarViewer` は three を effect 内で動的 import するので jsdom では配線を検証
 *   できない。**依存を引数で受ける**ことで、呼び出しの有無と順序を unit で縛れる
 * - three-vrm の版を上げるとき、追従すべき手順が 1 箇所に集まっている
 *
 * three / three-vrm を**実行時に import しない**（型のみ）。呼び出し側が渡す。
 */
import type { VRM, VRMLookAt, VRMUtils } from '@pixiv/three-vrm';
import type { Object3D, Vector3 } from 'three';

/** 公式例と同じ名前。空文字だと `createVRMAnimationClip` が警告する。 */
export const VRM_LOOK_AT_PROXY_NAME = 'VRMLookAtQuaternionProxy';

export type VrmPrepareDeps = {
  utils: Pick<
    typeof VRMUtils,
    'removeUnnecessaryVertices' | 'combineSkeletons' | 'combineMorphs' | 'rotateVRM0'
  >;
  /** `@pixiv/three-vrm-animation` の `VRMLookAtQuaternionProxy`。 */
  LookAtProxy: new (lookAt: VRMLookAt) => Object3D;
};

export type VrmPrepareResult = {
  /** lookAt を持つモデルで proxy を足したか。`vrmPreparedAttribute` で `data-vrm-prepared` に載る。 */
  lookAtProxyAdded: boolean;
};

/**
 * `data-vrm-prepared` の値。**配線を観測可能にする。**
 *
 * `prepareLoadedVrm` の呼び出しを丸ごと落としても unit は全部緑のままで、描画も「それらしく」
 * 見える（独立レビューの実測）。実描画検査（`scripts/vrm-visual-check.mjs`）がこの属性を
 * 名指しで期待することで、公式手順が実際に通ったことを画素ではなく事実で確かめる。
 * `none` は未読込／VRM でない glTF。
 */
export function vrmPreparedAttribute(result: VrmPrepareResult): string {
  return result.lookAtProxyAdded ? 'optimized;lookat-proxy' : 'optimized';
}

/**
 * 読込済み VRM に公式例どおりの後処理を施す。
 *
 * **順序が効くのは最適化 3 つ**（公式例と同じ `removeUnnecessaryVertices` → `combineSkeletons`
 * → `combineMorphs`）。`combineSkeletons` が共有ジオメトリを複製して `morphAttributes` を
 * 別物にするので、その後の `combineMorphs`（元ジオメトリの `morphAttributes` を空にする）が
 * 兄弟メッシュを壊さない。逆にすると実際に壊れる。
 *
 * `rotateVRM0` は公式例（1.0 モデル）には無い本 repo の追加で、位置はどこでもよい
 * （`combineSkeletons` は bindMatrix を恒等にするので scene の回転は 1 回だけ効く）。
 * VRM 1.0 には no-op。0.x は -Z 向き規約なので回さないと後ろ姿になる（実描画検証 2026-07-22）。
 */
export function prepareLoadedVrm(vrm: VRM, deps: VrmPrepareDeps): VrmPrepareResult {
  deps.utils.removeUnnecessaryVertices(vrm.scene);
  deps.utils.combineSkeletons(vrm.scene);
  deps.utils.combineMorphs(vrm);
  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });
  deps.utils.rotateVRM0(vrm);
  if (!vrm.lookAt) return { lookAtProxyAdded: false };
  const proxy = new deps.LookAtProxy(vrm.lookAt);
  proxy.name = VRM_LOOK_AT_PROXY_NAME;
  vrm.scene.add(proxy);
  return { lookAtProxyAdded: true };
}

/**
 * humanoid の head 正規化ボーンからワールド Y（頭の高さ）を実測する。
 * 取れない・非有限・非正なら `undefined`（呼び出し側が既定へ倒し、その事実を観測に出す。
 * 0 を返すとカメラが原点へ埋まる）。
 *
 * `makeVector` は `() => new THREE.Vector3()`。ここで three を import しないための注入。
 */
export function measureHeadHeight(vrm: VRM, makeVector: () => Vector3): number | undefined {
  const head = vrm.humanoid?.getNormalizedBoneNode('head');
  if (!head) return undefined;
  const { y } = head.getWorldPosition(makeVector());
  return Number.isFinite(y) && y > 0 ? y : undefined;
}
