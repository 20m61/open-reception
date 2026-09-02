import { describe, expect, it } from 'vitest';

import { validatePolicyInput } from './schedule';
import { validateRuntimePolicyInput } from '../runtime-policy/validate';

function operatingResult(date: string) {
  return validatePolicyInput({ exceptionDates: [{ date, closed: true }] });
}

function holidayResult(mmdd: string) {
  return validatePolicyInput({ fixedHolidays: [mmdd] });
}

function runtimeResult(date: string) {
  return validateRuntimePolicyInput({
    commonSchedule: {
      timezone: 'Asia/Tokyo',
      weeklySchedule: {},
      fixedHolidays: [],
      exceptionDates: [{ date, closed: true }],
    },
  });
}

describe('exceptionDates Gregorian calendar validity (#805)', () => {
  it.each(['2026-02-29', '2026-02-30', '2026-04-31'])(
    '暦として存在しない %s を拒否する',
    (date) => {
      const result = operatingResult(date);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'exceptionDates[0].date',
            message: expect.stringContaining('Gregorian calendar date'),
          }),
        ]),
      );
      // 診断へ入力値自体を反射しない。運用ログ・PR・スクショへの不要な値露出を増やさない。
      expect(result.error.issues.map((issue) => issue.message).join(' ')).not.toContain(date);
    },
  );

  it.each(['2028-02-29', '2000-02-29'])('正当な leap day %s は受理する', (date) => {
    const result = operatingResult(date);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exceptionDates).toEqual([{ date, closed: true }]);
  });

  it('400年規則を満たさない世紀年 2100-02-29 を拒否する', () => {
    expect(operatingResult('2100-02-29').ok).toBe(false);
  });

  it('月末の正当な日付は狭めない', () => {
    for (const date of ['2026-01-31', '2026-04-30', '2026-12-31']) {
      expect(operatingResult(date).ok, date).toBe(true);
    }
  });

  it('runtime-policy の共通営業時間も同じ正本へ委譲して不正日付を拒否する', () => {
    const invalid = runtimeResult('2026-02-30');
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.issues.map((issue) => issue.field)).toContain(
      'commonSchedule.exceptionDates[0].date',
    );

    expect(runtimeResult('2028-02-29').ok).toBe(true);
  });
});

/**
 * `fixedHolidays` は `MM-DD`（毎年繰り返す固定休業日）なので、**年が無い**。
 * よって判定規則が `exceptionDates` と変わる ── **`02-29` は残さなければならない**
 * （閏年には実在するので、拒否すると 4 年に 1 度の休業日を設定できなくなる）。
 * 拒否すべきは「どの年にも存在し得ない日」だけである。
 */
describe('fixedHolidays Gregorian calendar validity (#805)', () => {
  it.each(['02-30', '02-31', '04-31', '06-31', '09-31', '11-31'])(
    'どの年にも存在しない %s を拒否する',
    (mmdd) => {
      const result = holidayResult(mmdd);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'fixedHolidays[0]',
            message: expect.stringContaining('Gregorian calendar date'),
          }),
        ]),
      );
      // 診断へ入力値自体を反射しない（exceptionDates 側と同じ方針）。
      expect(result.error.issues.map((issue) => issue.message).join(' ')).not.toContain(mmdd);
    },
  );

  /**
   * 🔴 **下界を縛る。** 「不正を拒否する」だけなら、`fixedHolidays` を全部拒否する実装で
   * 空虚に満たせる。閏日と各月の月末を通すことまで見る。
   */
  it.each(['02-29', '01-31', '04-30', '02-28', '12-31'])('実在しうる %s は通す', (mmdd) => {
    expect(holidayResult(mmdd).ok, mmdd).toBe(true);
  });

  it('不正な要素の位置を index で指す（複数件でも取り違えない）', () => {
    const result = validatePolicyInput({ fixedHolidays: ['01-01', '04-31', '12-31'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.map((issue) => issue.field)).toContain('fixedHolidays[1]');
  });
});
