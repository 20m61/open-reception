import { describe, expect, it } from 'vitest';
import {
  daysInJstMonth,
  jstDayKey,
  jstDayOfMonth,
  jstDayStartIso,
  jstMonthStartIso,
  jstYearMonth,
} from './jst';

describe('jstDayKey (#254)', () => {
  it('UTC+9 の暦日キーを返す', () => {
    // 2026-06-30T20:00Z = 2026-07-01 05:00 JST → 07-01。
    expect(jstDayKey(Date.parse('2026-06-30T20:00:00.000Z'))).toBe('2026-07-01');
    // 2026-06-30T14:00Z = 2026-06-30 23:00 JST → 06-30。
    expect(jstDayKey(Date.parse('2026-06-30T14:00:00.000Z'))).toBe('2026-06-30');
  });
  it('無効な ms は null', () => {
    expect(jstDayKey(NaN)).toBeNull();
  });
});

describe('jstYearMonth / jstMonthStartIso (#254)', () => {
  it('JST 暦月と JST 月初(UTC ISO)を返す', () => {
    // 2026-06-30T20:00Z = 2026-07-01 05:00 JST → 7 月（m=6）。
    expect(jstYearMonth(new Date('2026-06-30T20:00:00.000Z'))).toEqual({ y: 2026, m: 6 });
    // 2026-07-01 00:00 JST = 2026-06-30T15:00Z。
    expect(jstMonthStartIso(2026, 6)).toBe('2026-06-30T15:00:00.000Z');
  });
  it('1 月の桁下げ（前年12月）を処理する', () => {
    // 2025-12-01 00:00 JST = 2025-11-30T15:00Z。
    expect(jstMonthStartIso(2026, -1)).toBe('2025-11-30T15:00:00.000Z');
  });
});

describe('jstDayOfMonth / daysInJstMonth (#254)', () => {
  it('JST 月内日と JST 月の総日数', () => {
    expect(jstDayOfMonth(new Date('2026-06-20T12:00:00.000Z'))).toBe(20); // JST 06-20 21:00
    expect(jstDayOfMonth(new Date('2026-06-30T20:00:00.000Z'))).toBe(1); // JST 07-01 05:00
    expect(daysInJstMonth(2026, 5)).toBe(30); // 6 月
    expect(daysInJstMonth(2025, 1)).toBe(28); // 2025 年 2 月
  });
  it('無効な now は NaN', () => {
    expect(jstDayOfMonth(new Date('invalid'))).toBeNaN();
  });
});

describe('jstDayStartIso (#254)', () => {
  it('当日 JST 00:00 の UTC ISO を返す', () => {
    // JST 2026-07-01 の任意時刻 → 2026-07-01 00:00 JST = 2026-06-30T15:00Z。
    expect(jstDayStartIso(new Date('2026-06-30T20:00:00.000Z'))).toBe('2026-06-30T15:00:00.000Z');
    expect(jstDayStartIso(new Date('2026-07-01T05:00:00.000Z'))).toBe('2026-06-30T15:00:00.000Z');
  });
  it('無効な now は null', () => {
    expect(jstDayStartIso(new Date('invalid'))).toBeNull();
  });
});
