/**
 * アバターの画角をモデルから導出する (#578 増分 3)。
 *
 * ## なぜ要るか
 *
 * `VrmAvatarViewer` のカメラは固定値の決め打ちだった:
 *
 * ```ts
 * new THREE.PerspectiveCamera(30, w / h, 0.1, 20);
 * camera.position.set(0, 1.3, 2.2);   // lookAt() は呼ばれていない
 * ```
 *
 * VRM は身長差が大きい（子供キャラと成人キャラでは頭の高さが 50cm 以上違う）のに、
 * 目線の高さも距離も決め打ちなので、**モデルを差し替えると顔が切れる / 遠すぎる**。
 * humanoid から頭の高さが取れるのだから、そこから決める。
 *
 * ここは three.js に依存しない純粋な算術だけを持つ（GPU 無しでテストできる）。
 * 実際に自然に見えるかは実機 UAT（#65）。
 */

/**
 * 頭の高さをどこから得たか (#578 増分 1)。
 *
 * **黙って倒す・黙って寄せるのをやめるため**に返す。cm スケールの VRM を渡されたときの
 * 画角は、正常なモデルの画角と**外からは見分けがつかない**（どちらも「それらしい数値」）。
 * 倒したこと・寄せたこと自体が観測できないと、実機で顔が切れたときにモデル・モーション・
 * カメラのどれに帰属するのかを絞れない。
 */
export type HeadHeightSource =
  /** humanoid から実測できた値をそのまま使った。 */
  | 'measured'
  /** 実測できず既定値へ倒した。 */
  | 'fallback'
  /** 実測できたが非現実的な値だったので妥当域へ寄せた（cm/dm スケールのモデル）。 */
  | 'clamped';

/** 画角の算出結果。three.js の PerspectiveCamera へそのまま流す。 */
export type CameraFraming = {
  /** カメラ位置。モデルは原点に立ち、+Z を向いている前提（`rotateVRM0` 適用後）。 */
  position: { x: number; y: number; z: number };
  /** 注視点。`lookAt` へ渡す。 */
  target: { x: number; y: number; z: number };
  /** 垂直画角（度）。 */
  fov: number;
  /** 頭の高さの出どころ。描画には使わず、観測のためだけに持つ。 */
  headHeightSource: HeadHeightSource;
};

/** 既定の頭の高さ（m）。humanoid から取れなかったときだけ使う成人相当の値。 */
const FALLBACK_HEAD_HEIGHT = 1.35;

/**
 * 頭の高さの妥当域（m）。
 *
 * **スケールの怪しいモデルこそがこの機能の主対象**なので、有限でも非現実的な値を
 * そのまま使わない。cm スケール（135）や dm スケール（13）の VRM を渡されると
 * `distanceRatio` 倍した距離が far 平面（20）を越え、**モデル全体が描画されず真っ黒**になる。
 * 逆に極小（0.05）だと near 平面（0.1）の内側に頭が入ってクリップされる。
 * どちらも「読めているのに何も映らない」ため、観測からは切り分けられない。
 */
const MIN_HEAD_HEIGHT = 0.4;
const MAX_HEAD_HEIGHT = 2.5;

/** 垂直画角。狭いほど望遠的で歪みが少ない。上半身の対話距離としてこの辺り。 */
const DEFAULT_FOV = 30;

/**
 * 顔をどれだけ画面の上寄りに置くか（0=中央、正=上寄り）。
 * 受付では顔の下に UI が載るので、やや上に置くと収まりがよい。
 */
const HEAD_OFFSET_RATIO = 0.08;

/**
 * 画角を決める。
 *
 * **縦横比で距離を変えるのが要点。** 横長（横向き iPad）では垂直方向に余裕が無く、
 * 同じ距離だと顔が切れる。`fov` は固定のまま距離で調整する — `fov` を動かすと
 * パースの付き方が変わって印象が安定しない。
 */
export function resolveCameraFraming(input: {
  /** humanoid の頭のワールド高さ（m）。取れなければ undefined。 */
  headHeight?: number;
  /** 描画領域の縦横比（幅 / 高さ）。0 以下や非有限値は既定の縦長として扱う。 */
  aspect: number;
}): CameraFraming {
  const measured = Number.isFinite(input.headHeight) && (input.headHeight ?? 0) > 0;
  const rawHeadHeight = measured ? (input.headHeight as number) : FALLBACK_HEAD_HEIGHT;
  // 有限でも非現実的な値は妥当域へ寄せる（cm/dm スケールのモデルで真っ黒にしない）。
  const headHeight = Math.min(Math.max(rawHeadHeight, MIN_HEAD_HEIGHT), MAX_HEAD_HEIGHT);
  // 倒した／寄せたを区別する。既定値は妥当域の内側なので `fallback` が `clamped` に化けない。
  const headHeightSource: HeadHeightSource = !measured
    ? 'fallback'
    : headHeight !== rawHeadHeight
      ? 'clamped'
      : 'measured';
  const aspect = Number.isFinite(input.aspect) && input.aspect > 0 ? input.aspect : 3 / 4;

  /**
   * 頭の高さに対して何倍の距離を取るか。縦長（aspect<1）は垂直に余裕があるので寄れる。
   * 横長になるほど引かないと顔が切れる。
   */
  const distanceRatio = aspect >= 1 ? 1.6 + (aspect - 1) * 0.55 : 1.6;
  const eyeY = headHeight;

  return {
    position: { x: 0, y: eyeY, z: headHeight * distanceRatio },
    // 注視点を頭よりわずかに下げる＝顔が画面のやや上に来る。
    target: { x: 0, y: eyeY - headHeight * HEAD_OFFSET_RATIO, z: 0 },
    fov: DEFAULT_FOV,
    headHeightSource,
  };
}

/**
 * 実効画角を `data-camera-framing` に載せる表示値 (#578 増分 1 の残り)。
 *
 * 版（`data-vrm-version`）とモーション（`data-motion-state`）は観測できるのに
 * **カメラだけが出ていなかった**ため、実機で「顔が切れる / 真っ黒」を見ても帰属先を
 * 絞れなかった。ここを埋めて切り分けの三角形を閉じる。
 *
 * **丸めて出す。** `ResizeObserver` は 1px 未満の変化でも発火するので、生の浮動小数を
 * 載せると属性が毎フレーム変わる。属性の変化が再レンダリングを呼び、それが canvas の
 * 実寸を揺らす — 増分 3 で踏んだ発散と同じ入口になる。
 */
export function cameraFramingAttribute(framing: CameraFraming | undefined): string {
  // 未確定を空文字にしない。「属性が無い」のか「まだ決まっていない」のかが実機で
  // 区別できなくなる（`data-vrm-version` の `none` と揃える）。
  if (!framing) return 'none';
  return [
    `fov=${framing.fov}`,
    `eye=${framing.position.y.toFixed(2)}`,
    `dist=${framing.position.z.toFixed(2)}`,
    `src=${framing.headHeightSource}`,
  ].join(';');
}
