import { describe, expect, it } from 'vitest';
import { formatExceptionsText, formatTimeRanges, parseExceptionsText, parseTimeRangesText } from './text-format';

describe('formatTimeRanges / parseTimeRangesText 往復', () => {
  it('単一区間', () => {
    const ranges = [{ start: '09:00', end: '18:00' }];
    expect(formatTimeRanges(ranges)).toBe('09:00-18:00');
    expect(parseTimeRangesText('09:00-18:00')).toEqual(ranges);
  });

  it('複数区間（カンマ区切り）', () => {
    const ranges = [
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '18:00' },
    ];
    expect(formatTimeRanges(ranges)).toBe('09:00-12:00, 13:00-18:00');
    expect(parseTimeRangesText('09:00-12:00, 13:00-18:00')).toEqual(ranges);
  });

  it('日跨ぎ区間は末尾 * で表す', () => {
    const ranges = [{ start: '22:00', end: '02:00', crossesMidnight: true }];
    expect(formatTimeRanges(ranges)).toBe('22:00-02:00*');
    expect(parseTimeRangesText('22:00-02:00*')).toEqual(ranges);
  });

  it('空文字は空配列', () => {
    expect(parseTimeRangesText('')).toEqual([]);
    expect(parseTimeRangesText('   ')).toEqual([]);
  });

  it('不正トークン（区切りが無い等）は無視する', () => {
    expect(parseTimeRangesText('09:00-18:00, garbage, 13:00-15:00')).toEqual([
      { start: '09:00', end: '18:00' },
      { start: '13:00', end: '15:00' },
    ]);
  });
});

describe('formatExceptionsText / parseExceptionsText 往復', () => {
  it('closed=true は ":closed"', () => {
    const list = [{ date: '2026-01-01', closed: true }];
    expect(formatExceptionsText(list)).toBe('2026-01-01:closed');
    expect(parseExceptionsText('2026-01-01:closed')).toEqual(list);
  });

  it('closed=false は日付:区間', () => {
    const list = [{ date: '2026-08-15', closed: false, ranges: [{ start: '10:00', end: '15:00' }] }];
    expect(formatExceptionsText(list)).toBe('2026-08-15:10:00-15:00');
    expect(parseExceptionsText('2026-08-15:10:00-15:00')).toEqual(list);
  });

  it('複数行（空行は無視）', () => {
    const text = '2026-01-01:closed\n\n2026-08-15:10:00-15:00\n';
    expect(parseExceptionsText(text)).toEqual([
      { date: '2026-01-01', closed: true },
      { date: '2026-08-15', closed: false, ranges: [{ start: '10:00', end: '15:00' }] },
    ]);
  });

  it('コロン省略/空欄は closed 扱い', () => {
    expect(parseExceptionsText('2026-01-01')).toEqual([{ date: '2026-01-01', closed: true }]);
    expect(parseExceptionsText('2026-01-01:')).toEqual([{ date: '2026-01-01', closed: true }]);
  });
});
