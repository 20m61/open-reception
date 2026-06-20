/**
 * Canvas フレーム差分による軽量モーション量算出 (issue #79)。
 *
 * 常時 AI 推論は行わず、低解像度に縮小したフレームの差分だけを見る低負荷方式。
 * この関数群は実カメラ・Canvas・DOM に一切依存せず、グレースケール値配列
 * （0..255 の Uint8 相当）を入力に取る純粋関数として実装する。
 * これにより、実カメラなしでユニットテスト可能にする（次増分で実 Canvas に配線）。
 *
 * 低負荷方針:
 *   - 80x60 程度の小さい内部フレームを前提に O(N) で走査する。
 *   - 中央受付ゾーン (ROI) のみを評価し、通行人（端や周縁）の動きを無視する。
 *   - 1 ピクセルあたりの差分は小さなしきい値で 2 値化し、ノイズを切り捨てる。
 */

/** 中央受付ゾーン（関心領域）。正規化座標 (0..1)。 */
export type RegionOfInterest = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

/** 既定 ROI。中央やや縦長（立ち止まる人の胴体〜顔を見る）。issue #79 の例に準拠。 */
export const DEFAULT_ROI: RegionOfInterest = {
  xMin: 0.25,
  xMax: 0.75,
  yMin: 0.15,
  yMax: 0.9,
};

export type MotionDiffOptions = {
  /** フレームの幅（ピクセル数 / 列数）。 */
  width: number;
  /** フレームの高さ（ピクセル数 / 行数）。 */
  height: number;
  /** 評価する中央ゾーン。省略時は DEFAULT_ROI。 */
  roi?: RegionOfInterest;
  /**
   * 1 ピクセルを「動いた」とみなす輝度差のしきい値 (0..255)。
   * カメラノイズ・微小なちらつきを無視するために使う。既定 24。
   */
  pixelThreshold?: number;
};

export type MotionDiffResult = {
  /** ROI 内で「動いた」とみなしたピクセルの割合 (0..1)。state.ts のしきい値判定に使う。 */
  motionLevel: number;
  /** 動いたピクセル数（デバッグ/チューニング用）。 */
  changedPixels: number;
  /** ROI に含まれる総ピクセル数。 */
  totalPixels: number;
};

const DEFAULT_PIXEL_THRESHOLD = 24;

/** ROI を整数ピクセル境界へ変換する。範囲は [start, end)（end は排他）。 */
function roiBounds(
  roi: RegionOfInterest,
  width: number,
  height: number,
): { x0: number; x1: number; y0: number; y1: number } {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = Math.floor(clamp01(roi.xMin) * width);
  const x1 = Math.ceil(clamp01(roi.xMax) * width);
  const y0 = Math.floor(clamp01(roi.yMin) * height);
  const y1 = Math.ceil(clamp01(roi.yMax) * height);
  return {
    x0,
    x1: Math.max(x0, Math.min(width, x1)),
    y0,
    y1: Math.max(y0, Math.min(height, y1)),
  };
}

/**
 * 2 つのグレースケールフレームの差分から、中央ゾーンのモーション量を算出する。
 *
 * @param previous 直前フレームの輝度配列（length === width*height、行優先）。
 * @param current  現フレームの輝度配列（previous と同じ形状）。
 * @returns 中央ゾーンの変化割合などを含む結果。
 * @throws フレーム長が width*height と一致しない、または width/height が不正な場合。
 */
export function computeCenterMotion(
  previous: ArrayLike<number>,
  current: ArrayLike<number>,
  options: MotionDiffOptions,
): MotionDiffResult {
  const { width, height } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid frame size: ${width}x${height}`);
  }
  const expected = width * height;
  if (previous.length !== expected || current.length !== expected) {
    throw new Error(
      `Frame length mismatch: expected ${expected}, got prev=${previous.length} cur=${current.length}`,
    );
  }

  const roi = options.roi ?? DEFAULT_ROI;
  const pixelThreshold = options.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const { x0, x1, y0, y1 } = roiBounds(roi, width, height);

  let changedPixels = 0;
  let totalPixels = 0;
  for (let y = y0; y < y1; y++) {
    const rowStart = y * width;
    for (let x = x0; x < x1; x++) {
      const i = rowStart + x;
      totalPixels++;
      // 長さは検証済みなので添字は安全。noUncheckedIndexedAccess 対策に既定 0 を補う。
      const diff = Math.abs((current[i] ?? 0) - (previous[i] ?? 0));
      if (diff >= pixelThreshold) {
        changedPixels++;
      }
    }
  }

  // 空の ROI（極端な座標指定）では motionLevel=0 とし、0 除算を避ける。
  const motionLevel = totalPixels === 0 ? 0 : changedPixels / totalPixels;
  return { motionLevel, changedPixels, totalPixels };
}

/**
 * RGBA の ImageData 風バッファ（length === width*height*4）を
 * グレースケール輝度配列へ縮約する純粋関数。
 *
 * 実 Canvas の `getImageData().data` をそのまま渡せる形にしておき、
 * computeCenterMotion の入力に使う。輝度は ITU-R BT.601 係数で近似する。
 */
export function rgbaToGrayscale(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const pixels = width * height;
  if (rgba.length !== pixels * 4) {
    throw new Error(`RGBA length mismatch: expected ${pixels * 4}, got ${rgba.length}`);
  }
  const out = new Uint8Array(pixels);
  for (let p = 0; p < pixels; p++) {
    // 長さは検証済み。noUncheckedIndexedAccess 対策に既定 0 を補う。
    const r = rgba[p * 4] ?? 0;
    const g = rgba[p * 4 + 1] ?? 0;
    const b = rgba[p * 4 + 2] ?? 0;
    // 0.299R + 0.587G + 0.114B を整数演算で近似（>>10 で /1024）。
    out[p] = (r * 306 + g * 601 + b * 117) >> 10;
  }
  return out;
}
