import { describe, expect, it } from 'vitest';
import {
  computeCenterMotion,
  DEFAULT_ROI,
  rgbaToGrayscale,
  type MotionDiffOptions,
} from './motion-diff';

/** width*height のグレースケールフレームを fill 値で埋めて作る。 */
function frame(width: number, height: number, fill: number): Uint8Array {
  return new Uint8Array(width * height).fill(fill);
}

describe('computeCenterMotion', () => {
  it('同一フレームならモーション量は 0', () => {
    const f = frame(80, 60, 100);
    const r = computeCenterMotion(f, f, { width: 80, height: 60 });
    expect(r.motionLevel).toBe(0);
    expect(r.changedPixels).toBe(0);
    expect(r.totalPixels).toBeGreaterThan(0);
  });

  it('ROI 全体が大きく変化すれば motionLevel は 1', () => {
    const prev = frame(80, 60, 0);
    const cur = frame(80, 60, 255);
    const r = computeCenterMotion(prev, cur, { width: 80, height: 60 });
    expect(r.motionLevel).toBe(1);
    expect(r.changedPixels).toBe(r.totalPixels);
  });

  it('ROI 外（周縁）だけの変化は検知しない（通行人の横切り抑制）', () => {
    const width = 80;
    const height = 60;
    const prev = frame(width, height, 0);
    const cur = frame(width, height, 0);
    // ROI 外（左端の列 x=0）だけを変化させる。DEFAULT_ROI.xMin=0.25 → x=0 は範囲外。
    for (let y = 0; y < height; y++) {
      cur[y * width + 0] = 255;
    }
    const r = computeCenterMotion(prev, cur, { width, height });
    expect(r.changedPixels).toBe(0);
    expect(r.motionLevel).toBe(0);
  });

  it('ROI 内の変化のみカウントする（中央列を変化）', () => {
    const width = 80;
    const height = 60;
    const prev = frame(width, height, 0);
    const cur = frame(width, height, 0);
    const midX = Math.floor(width / 2);
    for (let y = 0; y < height; y++) {
      cur[y * width + midX] = 255;
    }
    const r = computeCenterMotion(prev, cur, { width, height });
    expect(r.changedPixels).toBeGreaterThan(0);
    expect(r.motionLevel).toBeGreaterThan(0);
  });

  it('pixelThreshold 未満の輝度差は無視する（ノイズ除去・境界）', () => {
    const width = 4;
    const height = 4;
    const prev = frame(width, height, 100);
    const cur = frame(width, height, 100 + 23); // 差 23
    const fullRoi = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
    const opts: MotionDiffOptions = { width, height, roi: fullRoi, pixelThreshold: 24 };
    expect(computeCenterMotion(prev, cur, opts).changedPixels).toBe(0);

    const cur2 = frame(width, height, 100 + 24); // 差 24 = しきい値
    expect(computeCenterMotion(prev, cur2, opts).changedPixels).toBe(width * height);
  });

  it('フレーム長が不一致なら throw', () => {
    expect(() =>
      computeCenterMotion(frame(80, 60, 0), frame(80, 59, 0), { width: 80, height: 60 }),
    ).toThrowError(/length mismatch/);
  });

  it('不正なフレームサイズは throw', () => {
    expect(() => computeCenterMotion([], [], { width: 0, height: 10 })).toThrowError(
      /Invalid frame size/,
    );
  });

  it('DEFAULT_ROI は中央領域を指す', () => {
    expect(DEFAULT_ROI.xMin).toBeGreaterThan(0);
    expect(DEFAULT_ROI.xMax).toBeLessThan(1);
  });
});

describe('rgbaToGrayscale', () => {
  it('白は 255 付近、黒は 0 に縮約する', () => {
    const white = rgbaToGrayscale(new Uint8Array([255, 255, 255, 255]), 1, 1);
    expect(white[0] ?? 0).toBeGreaterThanOrEqual(254);
    const black = rgbaToGrayscale(new Uint8Array([0, 0, 0, 255]), 1, 1);
    expect(black[0]).toBe(0);
  });

  it('緑が最も輝度に寄与する（BT.601 係数）', () => {
    const g = rgbaToGrayscale(new Uint8Array([0, 255, 0, 255]), 1, 1)[0] ?? 0;
    const r = rgbaToGrayscale(new Uint8Array([255, 0, 0, 255]), 1, 1)[0] ?? 0;
    const b = rgbaToGrayscale(new Uint8Array([0, 0, 255, 255]), 1, 1)[0] ?? 0;
    expect(g).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(b);
  });

  it('RGBA 長が不一致なら throw', () => {
    expect(() => rgbaToGrayscale(new Uint8Array([0, 0, 0]), 1, 1)).toThrowError(/length mismatch/);
  });

  it('grayscale 出力は computeCenterMotion にそのまま渡せる', () => {
    const width = 2;
    const height = 2;
    const rgbaPrev = new Uint8Array(width * height * 4).fill(0);
    const rgbaCur = new Uint8Array(width * height * 4).fill(255);
    const prev = rgbaToGrayscale(rgbaPrev, width, height);
    const cur = rgbaToGrayscale(rgbaCur, width, height);
    const r = computeCenterMotion(prev, cur, {
      width,
      height,
      roi: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
    });
    expect(r.motionLevel).toBe(1);
  });
});
