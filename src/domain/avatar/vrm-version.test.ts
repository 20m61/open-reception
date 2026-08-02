import { describe, expect, it } from 'vitest';
import { resolveVrmSpecVersion, vrmVersionAttribute } from './vrm-version';

/**
 * VRM 仕様版の観測 (#578 増分 1)。
 *
 * 実機で「モーションが変」と分かっても、いまは版がどこにも出ていないので
 * モデル版・モーション・カメラのどれに帰属するか切り分けられない。ここは
 * **判別できたか / できなかったか**を嘘なく表に出すことだけを担う。
 */

describe('resolveVrmSpecVersion', () => {
  it('three-vrm v3 の metaVersion を読む', () => {
    expect(resolveVrmSpecVersion({ metaVersion: '0' })).toBe('0');
    expect(resolveVrmSpecVersion({ metaVersion: '1' })).toBe('1');
  });

  it('数値で来ても読める（実装差で number になることがある）', () => {
    expect(resolveVrmSpecVersion({ metaVersion: 0 })).toBe('0');
    expect(resolveVrmSpecVersion({ metaVersion: 1 })).toBe('1');
  });

  /**
   * **推測で埋めない。** 既定を `'1'` などに倒すと、判別失敗が「1.0 だった」として
   * 記録され、実機の切り分けで嘘をつく。分からないことは分からないと出す。
   */
  it('判別できなければ unknown（既定へ倒さない）', () => {
    expect(resolveVrmSpecVersion({})).toBe('unknown');
    expect(resolveVrmSpecVersion({ metaVersion: '2' })).toBe('unknown');
    expect(resolveVrmSpecVersion({ metaVersion: null })).toBe('unknown');
    expect(resolveVrmSpecVersion(null)).toBe('unknown');
    expect(resolveVrmSpecVersion(undefined)).toBe('unknown');
    expect(resolveVrmSpecVersion('1')).toBe('unknown');
  });
});

describe('vrmVersionAttribute', () => {
  it('読み込めていれば版をそのまま出す', () => {
    expect(vrmVersionAttribute({ loaded: true, version: '0' })).toBe('0');
    expect(vrmVersionAttribute({ loaded: true, version: '1' })).toBe('1');
  });

  /**
   * 「まだ読んでいない / 読めなかった」と「読めたが版が不明」を区別する。
   * まとめると、実機で観測したときにどちらの状態か分からなくなる。
   */
  it('未読込は none、読込済みで不明は unknown', () => {
    expect(vrmVersionAttribute({ loaded: false, version: 'unknown' })).toBe('none');
    expect(vrmVersionAttribute({ loaded: false, version: '0' })).toBe('none');
    expect(vrmVersionAttribute({ loaded: true, version: 'unknown' })).toBe('unknown');
  });
});
