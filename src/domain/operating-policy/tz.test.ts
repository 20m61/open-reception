import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  addDaysToYmd,
  getZonedParts,
  isValidTimeZone,
  mmddKey,
  previousWeekday,
  weekdayPlusDays,
  ymdKey,
  zonedTimeToUtcMs,
} from './tz';

describe('isValidTimeZone', () => {
  it('既知の IANA タイムゾーンは true', () => {
    expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('不正な文字列や空文字は false', () => {
    expect(isValidTimeZone('Not/A/Zone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('getZonedParts', () => {
  it('UTC の深夜0時を Asia/Tokyo の午前9時（同日）へ変換する', () => {
    // 2026-07-22T00:00:00Z は Asia/Tokyo(+09:00) で 2026-07-22 09:00:00 (水)
    const ms = Date.UTC(2026, 6, 22, 0, 0, 0);
    const zoned = getZonedParts(ms, 'Asia/Tokyo');
    expect(zoned).toEqual({ year: 2026, month: 7, day: 22, hour: 9, minute: 0, second: 0, weekday: 'wed' });
  });

  it('日跨ぎ: UTC 15:30 は Asia/Tokyo で翌日 0:30', () => {
    // 2026-07-22T15:30:00Z → 2026-07-23 00:30:00 (木)
    const ms = Date.UTC(2026, 6, 22, 15, 30, 0);
    const zoned = getZonedParts(ms, 'Asia/Tokyo');
    expect(zoned).toEqual({ year: 2026, month: 7, day: 23, hour: 0, minute: 30, second: 0, weekday: 'thu' });
  });
});

describe('zonedTimeToUtcMs', () => {
  it('Asia/Tokyo 現地 09:00 を UTC epoch へ変換する（往復一致）', () => {
    const ms = zonedTimeToUtcMs({ year: 2026, month: 7, day: 22, hour: 9, minute: 0 }, 'Asia/Tokyo');
    expect(ms).toBe(Date.UTC(2026, 6, 22, 0, 0, 0));
  });

  it('変換結果を再度 getZonedParts すると同じ現地日時に戻る（往復整合）', () => {
    const local = { year: 2026, month: 1, day: 1, hour: 0, minute: 0 };
    const ms = zonedTimeToUtcMs(local, 'Asia/Tokyo');
    const back = getZonedParts(ms, 'Asia/Tokyo');
    expect(back).toMatchObject(local);
  });
});

describe('addDaysToYmd', () => {
  it('月またぎを正しく繰り上げる', () => {
    expect(addDaysToYmd({ year: 2026, month: 1, day: 31 }, 1)).toEqual({ year: 2026, month: 2, day: 1 });
  });

  it('年またぎ（年末年始）を正しく繰り上げる', () => {
    expect(addDaysToYmd({ year: 2025, month: 12, day: 31 }, 1)).toEqual({ year: 2026, month: 1, day: 1 });
  });

  it('負の delta で前日へ戻せる', () => {
    expect(addDaysToYmd({ year: 2026, month: 3, day: 1 }, -1)).toEqual({ year: 2026, month: 2, day: 28 });
  });
});

describe('previousWeekday / weekdayPlusDays', () => {
  it('previousWeekday は巡回する（mon の前日は sun）', () => {
    expect(previousWeekday('mon')).toBe('sun');
    expect(previousWeekday('wed')).toBe('tue');
  });

  it('weekdayPlusDays は 7 日で一周する', () => {
    expect(weekdayPlusDays('mon', 7)).toBe('mon');
    expect(weekdayPlusDays('fri', 3)).toBe('mon');
  });
});

describe('ymdKey / mmddKey', () => {
  it('0埋めした YYYY-MM-DD / MM-DD を返す', () => {
    expect(ymdKey({ year: 2026, month: 1, day: 3 })).toBe('2026-01-03');
    expect(mmddKey({ year: 2026, month: 1, day: 3 })).toBe('01-03');
  });
});

it('DEFAULT_TIMEZONE は Asia/Tokyo', () => {
  expect(DEFAULT_TIMEZONE).toBe('Asia/Tokyo');
});
