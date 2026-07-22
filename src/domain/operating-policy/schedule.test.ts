import { describe, expect, it } from 'vitest';
import { evaluateOperatingStatus, resolveKioskOperatingStatus, validatePolicyInput } from './schedule';
import type { ServiceOperatingPolicy } from './types';

type BasePolicy = Pick<ServiceOperatingPolicy, 'timezone' | 'weeklySchedule' | 'fixedHolidays' | 'exceptionDates'>;

const WEEKDAY_9_18: BasePolicy = {
  timezone: 'Asia/Tokyo',
  weeklySchedule: {
    mon: [{ start: '09:00', end: '18:00' }],
    tue: [{ start: '09:00', end: '18:00' }],
    wed: [{ start: '09:00', end: '18:00' }],
    thu: [{ start: '09:00', end: '18:00' }],
    fri: [{ start: '09:00', end: '18:00' }],
  },
  fixedHolidays: [],
  exceptionDates: [],
};

/** Asia/Tokyo の現地日時から UTC epoch ms を作る小ヘルパ（テスト用）。 */
function tokyo(y: number, m: number, d: number, hh: number, mm: number, ss = 0): number {
  // Asia/Tokyo は UTC+9 固定（DST なし）。
  return Date.UTC(y, m - 1, d, hh - 9, mm, ss);
}

describe('evaluateOperatingStatus 境界: 開店直前/直後', () => {
  it('開店直前（08:59:59）は closed・reopenAt=開店時刻', () => {
    // 2026-07-22 は水曜日。
    const at = tokyo(2026, 7, 22, 8, 59, 59);
    const result = evaluateOperatingStatus(WEEKDAY_9_18, at);
    expect(result.state).toBe('closed');
    expect(result.reopenAt).toBe(new Date(tokyo(2026, 7, 22, 9, 0, 0)).toISOString());
  });

  it('開店直後（09:00:00）は open', () => {
    const at = tokyo(2026, 7, 22, 9, 0, 0);
    expect(evaluateOperatingStatus(WEEKDAY_9_18, at).state).toBe('open');
  });

  it('閉店直前（17:59:59）は open', () => {
    const at = tokyo(2026, 7, 22, 17, 59, 59);
    expect(evaluateOperatingStatus(WEEKDAY_9_18, at).state).toBe('open');
  });

  it('閉店直後（18:00:00）は closed', () => {
    const at = tokyo(2026, 7, 22, 18, 0, 0);
    const result = evaluateOperatingStatus(WEEKDAY_9_18, at);
    expect(result.state).toBe('closed');
    // 次の営業日（2026-07-23 木曜）09:00 が reopenAt。
    expect(result.reopenAt).toBe(new Date(tokyo(2026, 7, 23, 9, 0, 0)).toISOString());
  });
});

describe('evaluateOperatingStatus 境界: 週末→翌営業日', () => {
  it('土曜（休業日設定なし=weeklyキー無し）は closed・reopenAtは月曜09:00', () => {
    // 2026-07-25 は土曜日。weeklySchedule に sat/sun キーが無い＝終日休業。
    const at = tokyo(2026, 7, 25, 12, 0, 0);
    const result = evaluateOperatingStatus(WEEKDAY_9_18, at);
    expect(result.state).toBe('closed');
    expect(result.reopenAt).toBe(new Date(tokyo(2026, 7, 27, 9, 0, 0)).toISOString());
  });
});

describe('evaluateOperatingStatus 境界: 日跨ぎ区間（crossesMidnight）', () => {
  const OVERNIGHT: BasePolicy = {
    timezone: 'Asia/Tokyo',
    weeklySchedule: {
      fri: [{ start: '22:00', end: '02:00', crossesMidnight: true }],
    },
    fixedHolidays: [],
    exceptionDates: [],
  };

  it('金曜22:00開始・土曜早朝は持ち越しで open（0:30・1:59）', () => {
    // 2026-07-24 は金曜日。
    expect(evaluateOperatingStatus(OVERNIGHT, tokyo(2026, 7, 24, 22, 0, 0)).state).toBe('open');
    expect(evaluateOperatingStatus(OVERNIGHT, tokyo(2026, 7, 25, 0, 30, 0)).state).toBe('open');
    expect(evaluateOperatingStatus(OVERNIGHT, tokyo(2026, 7, 25, 1, 59, 59)).state).toBe('open');
  });

  it('日跨ぎ区間の終了（土曜02:00:00）ちょうどで closed になる', () => {
    const result = evaluateOperatingStatus(OVERNIGHT, tokyo(2026, 7, 25, 2, 0, 0));
    expect(result.state).toBe('closed');
    // 次の営業開始は翌週金曜 22:00。
    expect(result.reopenAt).toBe(new Date(tokyo(2026, 7, 31, 22, 0, 0)).toISOString());
  });

  it('金曜21:59は日跨ぎ開始前でまだ closed', () => {
    expect(evaluateOperatingStatus(OVERNIGHT, tokyo(2026, 7, 24, 21, 59, 59)).state).toBe('closed');
  });
});

describe('evaluateOperatingStatus 境界: 年末年始（固定休業日）', () => {
  const WITH_NEW_YEAR: BasePolicy = {
    ...WEEKDAY_9_18,
    weeklySchedule: {
      ...WEEKDAY_9_18.weeklySchedule,
      thu: [{ start: '09:00', end: '18:00' }],
    },
    fixedHolidays: ['01-01', '01-02', '01-03'],
  };

  it('12/31（木、通常営業日）は open', () => {
    // 2026-12-31 は木曜日。
    expect(evaluateOperatingStatus(WITH_NEW_YEAR, tokyo(2026, 12, 31, 10, 0, 0)).state).toBe('open');
  });

  it('1/1は固定休業日で closed・reopenAtは1/4（日曜を挟むため翌週の最初の平日）', () => {
    // 2027-01-01 は金曜日。1/1-1/3 固定休業。1/4(月)は weeklySchedule に mon があるため営業。
    const result = evaluateOperatingStatus(WITH_NEW_YEAR, tokyo(2027, 1, 1, 10, 0, 0));
    expect(result.state).toBe('closed');
    expect(result.reopenAt).toBe(new Date(tokyo(2027, 1, 4, 9, 0, 0)).toISOString());
  });

  it('単発の例外日（exceptionDates）は固定休業日より優先し、臨時営業を反映する', () => {
    const policy: BasePolicy = {
      ...WITH_NEW_YEAR,
      exceptionDates: [{ date: '2027-01-01', closed: false, ranges: [{ start: '10:00', end: '12:00' }] }],
    };
    expect(evaluateOperatingStatus(policy, tokyo(2027, 1, 1, 10, 30, 0)).state).toBe('open');
    expect(evaluateOperatingStatus(policy, tokyo(2027, 1, 1, 13, 0, 0)).state).toBe('closed');
  });

  it('単発の休業指定（exceptionDates closed:true）は通常営業日を上書きする', () => {
    const policy: BasePolicy = {
      ...WEEKDAY_9_18,
      exceptionDates: [{ date: '2026-07-22', closed: true }],
    };
    expect(evaluateOperatingStatus(policy, tokyo(2026, 7, 22, 12, 0, 0)).state).toBe('closed');
  });
});

describe('evaluateOperatingStatus: policy 未設定に近い状態（全曜日休業）', () => {
  it('weeklySchedule が空なら常に closed で reopenAt は undefined（探索上限内に開店日なし）', () => {
    const policy: BasePolicy = { timezone: 'Asia/Tokyo', weeklySchedule: {}, fixedHolidays: [], exceptionDates: [] };
    const result = evaluateOperatingStatus(policy, tokyo(2026, 7, 22, 12, 0, 0));
    expect(result.state).toBe('closed');
    expect(result.reopenAt).toBeUndefined();
  });
});

describe('resolveKioskOperatingStatus', () => {
  it('KioskOperatingStatus 契約（state/reopenAt/emergencyContactLabel）へ写像する', () => {
    const policy = { ...WEEKDAY_9_18, emergencyContactLabel: '警備室内線' };
    const result = resolveKioskOperatingStatus(policy, tokyo(2026, 7, 22, 18, 0, 0));
    expect(result).toEqual({
      state: 'closed',
      reopenAt: new Date(tokyo(2026, 7, 23, 9, 0, 0)).toISOString(),
      emergencyContactLabel: '警備室内線',
    });
  });

  it('open のときは reopenAt を含まない', () => {
    const result = resolveKioskOperatingStatus(WEEKDAY_9_18, tokyo(2026, 7, 22, 10, 0, 0));
    expect(result).toEqual({ state: 'open' });
  });
});

describe('validatePolicyInput: 正常系', () => {
  it('最小構成（空スケジュール）を許可する', () => {
    const result = validatePolicyInput({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timezone).toBe('Asia/Tokyo');
      expect(result.value.weeklySchedule).toEqual({});
    }
  });

  it('妥当な曜日別スケジュール・固定休業日・単発例外・緊急連絡ラベルを受け付ける', () => {
    const result = validatePolicyInput({
      timezone: 'Asia/Tokyo',
      weeklySchedule: { mon: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }] },
      fixedHolidays: ['01-01'],
      exceptionDates: [{ date: '2026-08-15', closed: true }],
      emergencyContactLabel: '警備室内線',
    });
    expect(result.ok).toBe(true);
  });

  it('crossesMidnight:true の日跨ぎ区間（end < start）を受け付ける', () => {
    const result = validatePolicyInput({
      weeklySchedule: { fri: [{ start: '22:00', end: '02:00', crossesMidnight: true }] },
    });
    expect(result.ok).toBe(true);
  });
});

describe('validatePolicyInput: fixedHolidays の件数上限', () => {
  it('366 件超は invalid_input（ストア肥大・評価コスト増の防止）', () => {
    const result = validatePolicyInput({
      fixedHolidays: Array.from({ length: 367 }, () => '01-01'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.some((i) => i.field === 'fixedHolidays' && /too many/.test(i.message))).toBe(true);
    }
  });
});

describe('validatePolicyInput: 不正時間帯 (逆転区間等) は invalid_input', () => {
  it('crossesMidnight 未指定で end <= start（逆転区間）は拒否する', () => {
    const result = validatePolicyInput({ weeklySchedule: { mon: [{ start: '18:00', end: '09:00' }] } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.issues.some((i) => i.field === 'weeklySchedule.mon[0]')).toBe(true);
    }
  });

  it('start と end が同一（ゼロ長区間）は拒否する', () => {
    const result = validatePolicyInput({ weeklySchedule: { mon: [{ start: '09:00', end: '09:00' }] } });
    expect(result.ok).toBe(false);
  });

  it('crossesMidnight:true なのに end >= start（矛盾）は拒否する', () => {
    const result = validatePolicyInput({
      weeklySchedule: { mon: [{ start: '09:00', end: '18:00', crossesMidnight: true }] },
    });
    expect(result.ok).toBe(false);
  });

  it('不正な時刻フォーマットは拒否する', () => {
    const result = validatePolicyInput({ weeklySchedule: { mon: [{ start: '9:00', end: '18:00' }] } });
    expect(result.ok).toBe(false);
  });

  it('同一曜日内で区間が重複する場合は拒否する', () => {
    const result = validatePolicyInput({
      weeklySchedule: { mon: [{ start: '09:00', end: '15:00' }, { start: '12:00', end: '18:00' }] },
    });
    expect(result.ok).toBe(false);
  });

  it('未知のタイムゾーン名は拒否する', () => {
    const result = validatePolicyInput({ timezone: 'Not/A/Zone' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((i) => i.field === 'timezone')).toBe(true);
  });

  it('未知の曜日キーは拒否する', () => {
    const result = validatePolicyInput({ weeklySchedule: { funday: [{ start: '09:00', end: '18:00' }] } });
    expect(result.ok).toBe(false);
  });

  it('fixedHolidays の不正フォーマットは拒否する', () => {
    const result = validatePolicyInput({ fixedHolidays: ['2026-01-01'] });
    expect(result.ok).toBe(false);
  });

  it('exceptionDates: closed=true と ranges の同時指定は拒否する', () => {
    const result = validatePolicyInput({
      exceptionDates: [{ date: '2026-01-01', closed: true, ranges: [{ start: '09:00', end: '12:00' }] }],
    });
    expect(result.ok).toBe(false);
  });

  it('exceptionDates: closed=false なのに ranges が空/無指定は拒否する', () => {
    const result = validatePolicyInput({ exceptionDates: [{ date: '2026-01-01', closed: false }] });
    expect(result.ok).toBe(false);
  });

  it('body が object でなければ拒否する', () => {
    expect(validatePolicyInput(null).ok).toBe(false);
    expect(validatePolicyInput('x').ok).toBe(false);
  });
});
