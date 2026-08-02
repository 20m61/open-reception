import { describe, expect, it } from 'vitest';
import { resolveCameraFraming } from './camera-framing';

/**
 * 画角の算出 (#578 増分 3)。
 *
 * 従来は `position.set(0, 1.3, 2.2)` / `fov=30` の決め打ちで、**モデルの背丈に依存しな
 * かった**。VRM は身長差が大きいので、差し替えると顔が切れる / 遠すぎるという形で出る。
 * 実際に自然に見えるかは実機 UAT（#65）。ここでは算術の性質だけを固定する。
 */

describe('resolveCameraFraming', () => {
  it('目線の高さを頭の高さに合わせる（決め打ちしない）', () => {
    expect(resolveCameraFraming({ headHeight: 1.6, aspect: 0.75 }).position.y).toBe(1.6);
    expect(resolveCameraFraming({ headHeight: 1.0, aspect: 0.75 }).position.y).toBe(1.0);
  });

  it('背の低いモデルほど近づく（同じ距離だと小さく映る）', () => {
    const tall = resolveCameraFraming({ headHeight: 1.7, aspect: 0.75 });
    const short = resolveCameraFraming({ headHeight: 1.0, aspect: 0.75 });
    expect(short.position.z).toBeLessThan(tall.position.z);
  });

  /**
   * **横長では引かないと顔が切れる。** 垂直方向に余裕が無くなるため。
   * `fov` は動かさない — 動かすとパースの付き方が変わり印象が安定しない。
   */
  it('横長になるほど距離を取る（fov は変えない）', () => {
    const portrait = resolveCameraFraming({ headHeight: 1.4, aspect: 3 / 4 });
    const landscape = resolveCameraFraming({ headHeight: 1.4, aspect: 4 / 3 });
    const wide = resolveCameraFraming({ headHeight: 1.4, aspect: 16 / 9 });

    expect(landscape.position.z).toBeGreaterThan(portrait.position.z);
    expect(wide.position.z).toBeGreaterThan(landscape.position.z);
    expect(portrait.fov).toBe(landscape.fov);
    expect(landscape.fov).toBe(wide.fov);
  });

  it('顔が画面のやや上に来るよう注視点を頭より下げる', () => {
    const f = resolveCameraFraming({ headHeight: 1.4, aspect: 0.75 });
    expect(f.target.y).toBeLessThan(f.position.y);
    // 下げすぎない（胸から下を見上げる画にしない）。
    expect(f.position.y - f.target.y).toBeLessThan(0.2);
  });

  it('注視点はモデルの正面中心（原点）に置く', () => {
    const f = resolveCameraFraming({ headHeight: 1.4, aspect: 0.75 });
    expect(f.target.x).toBe(0);
    expect(f.target.z).toBe(0);
    expect(f.position.x).toBe(0);
    // `rotateVRM0` 適用後はモデルが +Z を向くので、カメラは +Z 側から見る。
    expect(f.position.z).toBeGreaterThan(0);
  });

  /**
   * humanoid から頭が取れないモデルでも破綻させない。**0 や NaN をそのまま使うと
   * カメラが原点に埋まる**（何も映らない）。
   */
  it('頭の高さが取れなければ既定へ倒す', () => {
    const fallback = resolveCameraFraming({ aspect: 0.75 });
    expect(fallback.position.y).toBeGreaterThan(1);
    expect(fallback.position.z).toBeGreaterThan(1);

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = resolveCameraFraming({ headHeight: bad, aspect: 0.75 });
      expect(f.position.y).toBe(fallback.position.y);
      expect(f.position.z).toBe(fallback.position.z);
    }
  });

  it('縦横比が不正でも破綻させない', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = resolveCameraFraming({ headHeight: 1.4, aspect: bad });
      expect(Number.isFinite(f.position.z)).toBe(true);
      expect(f.position.z).toBeGreaterThan(0);
    }
  });
});
