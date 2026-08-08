import { describe, expect, it } from 'vitest';
import { cameraFramingAttribute, resolveCameraFraming } from './camera-framing';

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

/**
 * **有限だが非現実的なスケール** (#578 レビュー M7)。
 *
 * 従来のテストは `0 / -1 / NaN / Infinity`（すべて fallback へ落ちる経路）しか突いておらず、
 * **実際に壊れる値を 1 つも通していなかった**。cm/dm スケールの VRM は far 平面（20）の外へ
 * 出て真っ黒になり、極小モデルは near 平面（0.1）の内側でクリップされる。
 * どちらも「読めているのに何も映らない」ので観測から切り分けられない。
 */
describe('resolveCameraFraming / 非現実的なスケール (#578 レビュー M7)', () => {
  const NEAR = 0.1;
  const FAR = 20;

  it('cm スケール（135）でも far 平面の内側に収まる', () => {
    const f = resolveCameraFraming({ headHeight: 135, aspect: 3 / 4 });
    expect(f.position.z).toBeLessThan(FAR);
  });

  it('dm スケール（13）でも far 平面の内側に収まる', () => {
    const f = resolveCameraFraming({ headHeight: 13, aspect: 16 / 9 });
    expect(f.position.z).toBeLessThan(FAR);
  });

  it('極小モデル（0.05）でも near 平面の外側に立つ', () => {
    const f = resolveCameraFraming({ headHeight: 0.05, aspect: 3 / 4 });
    expect(f.position.z).toBeGreaterThan(NEAR);
  });

  it('実測の既定モデル（1.3035m）は素通しする（クランプが常用域を歪めない）', () => {
    // public/avatar/default.vrm の head ワールド Y を実測した値。
    const f = resolveCameraFraming({ headHeight: 1.3035, aspect: 3 / 4 });
    expect(f.position.y).toBeCloseTo(1.3035, 4);
  });
});

describe('画角を観測可能にする (#578 増分 1 の残り)', () => {
  // 版（`data-vrm-version`）とモーション（`data-motion-state`）は観測できるようになったが、
  // **カメラだけが出ていない**ため、実機で「顔が切れる / 真っ黒」を見ても帰属先を絞れない。
  //
  // とくに `resolveCameraFraming` は**黙って既定へ倒し、黙ってクランプする**。
  // cm スケール（135）のモデルを渡されたときの出力は、正常なモデルの出力と**外からは
  // 見分けがつかない**。倒したこと・寄せたこと自体を観測できないと切り分けにならない。

  it('頭の高さを実測できたときは measured と報告する', () => {
    expect(resolveCameraFraming({ headHeight: 1.3, aspect: 0.75 }).headHeightSource).toBe(
      'measured',
    );
  });

  it('頭の高さが取れず既定へ倒したことを報告する', () => {
    expect(resolveCameraFraming({ aspect: 0.75 }).headHeightSource).toBe('fallback');
  });

  it('妥当域へ寄せたことを報告する（cm スケールを黙って飲まない）', () => {
    // 135m の頭は cm スケールの VRM。クランプ自体は正しいが、**黙ると
    // 「そういうモデルを渡された」事実が消える**。
    expect(resolveCameraFraming({ headHeight: 135, aspect: 0.75 }).headHeightSource).toBe(
      'clamped',
    );
  });

  it('まだ画角が決まっていなければ none', () => {
    // VRM 読込前は `data-vrm-version=none` と揃う。空文字にすると
    // 「属性が無い」のか「未確定」なのかが実機で区別できない。
    expect(cameraFramingAttribute(undefined)).toBe('none');
  });

  it('fov・距離・目線の高さ・頭の高さの出どころを載せる', () => {
    const attr = cameraFramingAttribute(resolveCameraFraming({ headHeight: 1.3, aspect: 4 / 3 }));
    expect(attr).toContain('fov=30');
    expect(attr).toContain('eye=1.30');
    expect(attr).toContain('src=measured');
    // 距離は aspect で変わる唯一の値なので、回転追従が効いているかの判定に使う。
    // 1.3 * (1.6 + (4/3 - 1) * 0.55) = 2.3183…
    expect(attr).toContain('dist=2.32');
  });

  it('丸めて出す（微小な浮動小数差で毎フレーム変わらない）', () => {
    // ResizeObserver は 1px 未満の変化でも発火する。丸めずに出すと属性が毎フレーム
    // 変わり、**React の再レンダリングが canvas の実寸を揺らす**ループの燃料になる
    // （増分 3 で踏んだ発散と同じ入口）。
    const a = cameraFramingAttribute(resolveCameraFraming({ headHeight: 1.3, aspect: 1.333333 }));
    const b = cameraFramingAttribute(resolveCameraFraming({ headHeight: 1.3, aspect: 1.333334 }));
    expect(a).toBe(b);
  });
});
