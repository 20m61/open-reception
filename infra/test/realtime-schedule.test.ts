import { describe, it, expect } from 'vitest';
import { isWithinBusinessHours, desiredCapacityFor, toJstHour } from '../lib/config/realtime-schedule';

const WINDOW = { timezone: 'Asia/Tokyo' as const, startHour: 8, stopHour: 23 };

/** JST の年月日時から UTC の Date を作る（JST = UTC+9 固定）。 */
function jst(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - 9 * 60 * 60 * 1000);
}

describe('toJstHour', () => {
  it('UTC を JST(+9h) の時に変換する', () => {
    // 2026-07-23 00:00 UTC = 2026-07-23 09:00 JST
    expect(toJstHour(new Date('2026-07-23T00:00:00Z'))).toBe(9);
  });

  it('UTC 日付をまたぐケースも正しく変換する', () => {
    // 2026-07-22 15:30 UTC = 2026-07-23 00:30 JST
    expect(toJstHour(new Date('2026-07-22T15:30:00Z'))).toBe(0);
  });
});

describe('isWithinBusinessHours (issue #366 初期ポリシー: 08:00-23:00 JST)', () => {
  it('開始時刻ちょうど(08:00 JST)は営業時間内', () => {
    expect(isWithinBusinessHours(jst(2026, 7, 23, 8, 0), WINDOW)).toBe(true);
  });

  it('開始直前(07:59 JST)は営業時間外', () => {
    expect(isWithinBusinessHours(jst(2026, 7, 23, 7, 59), WINDOW)).toBe(false);
  });

  it('停止時刻ちょうど(23:00 JST)は営業時間外（半開区間）', () => {
    expect(isWithinBusinessHours(jst(2026, 7, 23, 23, 0), WINDOW)).toBe(false);
  });

  it('停止直前(22:59 JST)は営業時間内', () => {
    expect(isWithinBusinessHours(jst(2026, 7, 23, 22, 59), WINDOW)).toBe(true);
  });

  it('日中(12:00 JST)は営業時間内', () => {
    expect(isWithinBusinessHours(jst(2026, 7, 23, 12, 0), WINDOW)).toBe(true);
  });

  it('深夜(0:00 JST)は営業時間外', () => {
    expect(isWithinBusinessHours(jst(2026, 7, 23, 0, 0), WINDOW)).toBe(false);
  });
});

describe('desiredCapacityFor', () => {
  it('営業時間内は 1 を返す', () => {
    expect(desiredCapacityFor(jst(2026, 7, 23, 10, 0), WINDOW)).toBe(1);
  });

  it('営業時間外は 0 を返す', () => {
    expect(desiredCapacityFor(jst(2026, 7, 23, 23, 30), WINDOW)).toBe(0);
  });
});
