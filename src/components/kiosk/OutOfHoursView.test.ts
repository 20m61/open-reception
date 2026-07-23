import { describe, expect, it } from 'vitest';
import { formatReopen } from './OutOfHoursView';

/**
 * reopenAt のポリシー TZ 整形 (#367 polish)。
 *
 * kiosk 端末の TZ 設定は保証されない（UTC 運用もありうる）。営業時間ポリシーが
 * Asia/Tokyo の 09:00 を reopenAt として返しても、端末 TZ で整形すると UTC 端末では
 * 0:00 と表示されてしまう。`timezone` を渡せばポリシー TZ で整形されることを固定する。
 * このテスト自体は TZ=UTC（vitest 既定）で走る前提。
 */
describe('formatReopen (#367 polish: ポリシー TZ 整形)', () => {
  const REOPEN_09_00_JST = '2026-07-24T00:00:00.000Z'; // = Asia/Tokyo 09:00

  it('timezone 指定時はポリシー TZ（Asia/Tokyo）で 9時台に整形される', () => {
    const text = formatReopen(REOPEN_09_00_JST, 'ja', 'Asia/Tokyo');
    expect(text).not.toBeNull();
    expect(text).toMatch(/9:00|09:00/);
    // UTC 表示（0:00）になっていないことも固定する。
    expect(text).not.toMatch(/0:00/);
  });

  it('timezone 未指定時は端末 TZ（このテスト環境では UTC）にフォールバックし 0:00 になる', () => {
    const text = formatReopen(REOPEN_09_00_JST, 'ja');
    expect(text).not.toBeNull();
    expect(text).toMatch(/0:00/);
  });

  it('reopenAt が不正/欠落なら timezone の有無に関わらず null', () => {
    expect(formatReopen(undefined, 'ja', 'Asia/Tokyo')).toBeNull();
    expect(formatReopen('not-a-date', 'ja', 'Asia/Tokyo')).toBeNull();
  });

  it('en ロケールでもポリシー TZ を優先する', () => {
    const text = formatReopen(REOPEN_09_00_JST, 'en', 'Asia/Tokyo');
    expect(text).not.toBeNull();
    expect(text).toMatch(/9:00 ?AM|09:00/);
  });
});
