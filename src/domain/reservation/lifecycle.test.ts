import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import {
  applyEdit,
  applyReissue,
  cancelReservation,
  isExpiredAt,
  isUsableAt,
  markExpiredIfNeeded,
  markUsed,
  revokeReservation,
  validateCreateInput,
} from './lifecycle';
import {
  asReservationId,
  asReservationTokenHash,
  type CreateReservationInput,
  type VisitReservation,
} from './types';

const T = asTenantId('tenant-a');
const S = asSiteId('site-1');

function reservation(over: Partial<VisitReservation> = {}): VisitReservation {
  return {
    id: asReservationId('rsv-1'),
    tenantId: T,
    siteId: S,
    visitorName: '山田太郎',
    visitAt: '2026-06-20T01:00:00.000Z',
    targetType: 'staff',
    targetId: 'staff-1',
    tokenHash: asReservationTokenHash('hash-1'),
    usagePolicy: 'single_use',
    expiresAt: '2026-06-27T00:00:00.000Z',
    status: 'active',
    retentionDays: 30,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    ...over,
  };
}

function input(over: Partial<CreateReservationInput> = {}): CreateReservationInput {
  return {
    tenantId: T,
    siteId: S,
    visitorName: '山田太郎',
    visitAt: '2026-06-20T01:00:00.000Z',
    targetType: 'staff',
    targetId: 'staff-1',
    usagePolicy: 'single_use',
    expiresAt: '2026-06-27T00:00:00.000Z',
    retentionDays: 30,
    ...over,
  };
}

/** 作成時点。既定の input() は来訪の終わり + 30 日より十分前。 */
const CREATE_NOW = new Date('2026-06-19T00:00:00.000Z');

describe('validateCreateInput (#97)', () => {
  it('正常入力を受理する', () => {
    expect(validateCreateInput(input(), CREATE_NOW).ok).toBe(true);
  });
  it.each([
    ['visitorName 空', input({ visitorName: ' ' })],
    ['visitAt 不正', input({ visitAt: 'nope' })],
    ['expiresAt 不正', input({ expiresAt: 'nope' })],
    ['targetId 空', input({ targetId: '' })],
    ['retentionDays 0', input({ retentionDays: 0 })],
    ['expiresAt < visitAt', input({ expiresAt: '2026-06-19T00:00:00.000Z' })],
  ])('%s を拒否する', (_label, bad) => {
    const r = validateCreateInput(bad, CREATE_NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });
});

describe('期限・使用可否判定 (#97)', () => {
  const now = new Date('2026-06-20T02:00:00.000Z');
  it('isExpiredAt: 期限後で true', () => {
    expect(isExpiredAt(reservation({ expiresAt: '2026-06-20T01:00:00.000Z' }), now)).toBe(true);
    expect(isExpiredAt(reservation({ expiresAt: '2026-06-21T00:00:00.000Z' }), now)).toBe(false);
  });
  it('isUsableAt: active かつ期限内なら true', () => {
    expect(isUsableAt(reservation(), now)).toBe(true);
  });
  it('isUsableAt: 非 active は false', () => {
    expect(isUsableAt(reservation({ status: 'revoked' }), now)).toBe(false);
    expect(isUsableAt(reservation({ status: 'used' }), now)).toBe(false);
  });
  it('isUsableAt: same_day は当日のみ', () => {
    const sameDay = reservation({ usagePolicy: 'same_day' });
    expect(isUsableAt(sameDay, new Date('2026-06-20T05:00:00.000Z'))).toBe(true);
    expect(isUsableAt(sameDay, new Date('2026-06-21T05:00:00.000Z'))).toBe(false);
  });
});

describe('状態遷移 (#97)', () => {
  const now = new Date('2026-06-20T02:00:00.000Z');

  it('cancel: active → cancelled、終端からは不可', () => {
    const ok = cancelReservation(reservation(), now);
    expect(ok.ok && ok.value.status).toBe('cancelled');
    const bad = cancelReservation(reservation({ status: 'used' }), now);
    expect(bad.ok).toBe(false);
  });

  it('revoke: active → revoked、終端からは不可', () => {
    const ok = revokeReservation(reservation(), now);
    expect(ok.ok && ok.value.status).toBe('revoked');
    expect(revokeReservation(reservation({ status: 'cancelled' }), now).ok).toBe(false);
  });

  it('markExpiredIfNeeded: 期限切れ active のみ expired（冪等）', () => {
    const expired = markExpiredIfNeeded(reservation({ expiresAt: '2026-06-20T01:00:00.000Z' }), now);
    expect(expired.ok && expired.value.status).toBe('expired');
    const stillActive = markExpiredIfNeeded(reservation(), now);
    expect(stillActive.ok && stillActive.value.status).toBe('active');
  });

  it('markUsed: 利用可能なら used、不可なら invalid_state', () => {
    const used = markUsed(reservation(), now);
    expect(used.ok && used.value.status).toBe('used');
    expect(used.ok && used.value.usedAt).toBeDefined();
    const bad = markUsed(reservation({ status: 'revoked' }), now);
    expect(bad.ok).toBe(false);
  });

  it('applyReissue: 新トークン hash・期限を適用し active へ戻す', () => {
    const revoked = reservation({ status: 'revoked', tokenHash: asReservationTokenHash('old-hash') });
    const r = applyReissue(revoked, asReservationTokenHash('new-hash'), '2026-07-01T00:00:00.000Z', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tokenHash).toBe('new-hash');
      expect(r.value.status).toBe('active');
      expect(r.value.usedAt).toBeUndefined();
    }
  });

  it('applyReissue: cancelled からは不可', () => {
    const r = applyReissue(reservation({ status: 'cancelled' }), asReservationTokenHash('x'), '2026-07-01T00:00:00.000Z', now);
    expect(r.ok).toBe(false);
  });

  it('applyEdit: active のみ編集可、終端は拒否', () => {
    const ok = applyEdit(reservation(), { visitorName: '田中花子' }, now);
    expect(ok.ok && ok.value.visitorName).toBe('田中花子');
    const bad = applyEdit(reservation({ status: 'used' }), { visitorName: 'x' }, now);
    expect(bad.ok).toBe(false);
  });

  it('applyEdit: expiresAt < visitAt を拒否', () => {
    const r = applyEdit(reservation(), { expiresAt: '2026-06-19T00:00:00.000Z' }, now);
    expect(r.ok).toBe(false);
  });
});

/**
 * 保存期限がすでに過ぎる入力の拒否 (#1022 M3) と、期限を計算できない入力の fail-closed (N1)。
 *
 * 分岐ごとの期待値ではなく、作成・編集・再発行の 3 経路に同じ不変条件を当てる:
 *   - 上界: 結果の保存期限（来訪の終わり + retentionDays）が now 以前なら必ず拒否する
 *   - 下界: 期限が now の**すぐ後**（1ms）なら受理する（全部拒否で空虚に満たさない）
 */
describe('保存期限が過去・計算不能になる入力を拒否する (#1022)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date('2026-08-01T00:00:00.000Z');
  const at = (ms: number) => new Date(ms).toISOString();
  /** 保存期限が now + delta になる visitAt/expiresAt/retentionDays の組。 */
  function shape(deltaMs: number, days = 3, gapMs = 0) {
    const end = now.getTime() + deltaMs - days * DAY;
    return { visitAt: at(end - gapMs), expiresAt: at(end), retentionDays: days };
  }
  const deltas = [-400 * DAY, -DAY, -1, 0, 1, DAY];
  const gaps = [0, 6 * 60 * 60 * 1000];

  type Path = (f: { visitAt: string; expiresAt: string; retentionDays: number }) =>
    | { ok: true }
    | { ok: false; error: { code: string } };
  const paths: [string, Path][] = [
    ['create', (f) => validateCreateInput(input(f), now)],
    [
      'edit',
      // 現在の予約は保持中。パッチで期限を動かす。
      (f) => applyEdit(reservation({ visitAt: at(now.getTime()), expiresAt: at(now.getTime() + DAY) }), f, now),
    ],
    [
      'reissue',
      // visitAt と retentionDays は既存値、新しい expiresAt で期限が決まる。
      (f) =>
        applyReissue(
          reservation({ status: 'expired', visitAt: f.visitAt, retentionDays: f.retentionDays }),
          asReservationTokenHash('new'),
          f.expiresAt,
          now,
        ),
    ],
  ];

  for (const [name, run] of paths) {
    it(`${name}: 期限 ≤ now は拒否し、期限 > now は受理する`, () => {
      for (const d of deltas)
        for (const g of gaps)
          for (const days of [1, 30]) {
            const r = run(shape(d, days, g));
            expect(r.ok, `${name} delta=${d} gap=${g} days=${days}`).toBe(d > 0);
            if (!r.ok) expect(r.error.code).toBe('invalid_input');
          }
    });

    it(`${name}: 期限を計算できない retentionDays（非有限・巨大・非整数）は拒否する`, () => {
      for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, 1e308, Number.MAX_VALUE, 2 ** 53, 1.5, -1, 0]) {
        const f = { ...shape(DAY, 1), retentionDays: bad };
        expect(run(f).ok, `${name} retentionDays=${bad}`).toBe(false);
      }
    });
  }

  it('edit: retentionDays を縮めて期限が過去になる編集を拒否する（日付を変えない）', () => {
    const current = reservation({ visitAt: at(now.getTime() - 5 * DAY), expiresAt: at(now.getTime() - 5 * DAY), retentionDays: 30 });
    expect(applyEdit(current, { retentionDays: 5 }, now).ok).toBe(false);
    expect(applyEdit(current, { retentionDays: 6 }, now).ok).toBe(true);
  });
});

/**
 * 日時の形 (#1022 N3)。オフセットの無い日時はローカル TZ で解釈されるので受け付けない。
 * 日付のみは ECMAScript が UTC と定めているので受け付ける。
 */
describe('日時はオフセット必須 (#1022 N3)', () => {
  const accepted = [
    '2026-06-20T01:00:00.000Z',
    '2026-06-20T01:00:00Z',
    '2026-06-20T10:00:00+09:00',
    '2026-06-20T01:00Z',
    '2026-06-19T20:00:00.123-05:00',
    '2026-06-20T01:00:00.123456Z', // マイクロ秒（小数部 6 桁）
    '2026-06-20T10:00:00.123456789+09:00', // ナノ秒（小数部 9 桁 = 上限）
    '2026-06-20',
  ];
  const rejected = [
    '2026-06-20T01:00:00', // オフセット無し
    '2026-06-20T01:00:00.000', // オフセット無し
    '2026-06-20T01:00', // datetime-local の生値
    '2026-06-20 01:00:00Z', // 区切りが空白
    'Sat Jun 20 2026 10:00:00 GMT+0900', // Date.parse は通るが ISO ではない
    ' 2026-06-20T01:00:00Z', // 前後の空白
    '2026-13-01T00:00:00Z', // 形は合うが日付として不正
    '+002026-06-20T01:00:00Z', // 拡張年表記（Date.parse は通る）
    '2026-06-20T01:00:00.1234567890Z', // 小数部 10 桁
    '2026-06-20T01:00:00.Z', // 小数点だけ
    '2026-02-31T10:00:00Z', // 暦に無い日（Date.parse は 3/3 へ繰り上げて通す）
    '2026-02-29', // 平年の 2/29（日付のみの形も同じ）
    '2026-04-31T00:00:00+09:00', // 30 日の月の 31 日
    '',
  ];
  type R = { ok: true } | { ok: false; error: { message: string } };
  const visitPaths: [string, (v: string) => R][] = [
    ['create visitAt', (v) => validateCreateInput(input({ visitAt: v, expiresAt: '2026-06-27T00:00:00.000Z' }), CREATE_NOW)],
    ['create expiresAt', (v) => validateCreateInput(input({ visitAt: '2026-06-19T00:00:00.000Z', expiresAt: v }), CREATE_NOW)],
    ['edit visitAt', (v) => applyEdit(reservation(), { visitAt: v }, CREATE_NOW)],
    ['edit expiresAt', (v) => applyEdit(reservation({ visitAt: '2026-06-19T00:00:00.000Z' }), { expiresAt: v }, CREATE_NOW)],
    [
      'reissue newExpiresAt',
      (v) =>
        applyReissue(
          reservation({ status: 'revoked', visitAt: '2026-06-19T00:00:00.000Z' }),
          asReservationTokenHash('n'),
          v,
          CREATE_NOW,
        ),
    ],
  ];
  for (const [name, run] of visitPaths) {
    it(`${name}: オフセット付き日時・日付のみは受理する`, () => {
      for (const v of accepted) expect(run(v).ok, `${name} ${v}`).toBe(true);
    });
    it(`${name}: オフセット無し・ISO 以外の形は「日時の形」として拒否する`, () => {
      for (const v of rejected) {
        const r = run(v);
        expect(r.ok, `${name} ${JSON.stringify(v)}`).toBe(false);
        // 後段（保存期限の計算不能）に飲み込まれず、形の検証で落ちていること。
        if (!r.ok) expect(r.error.message, `${name} ${JSON.stringify(v)}`).toMatch(/must be an ISO date/);
      }
    });
  }
});

/**
 * 暦の上で存在しない日付 (#1022 NIT-2)。`Date.parse` は `2026-02-31` を 3/3 へ繰り上げて受理する
 * ので、保存される文字列と期限が数日ずれる。暦どおりの日は（閏日を含め）受理する（下界）。
 */
describe('日付は暦どおり (#1022 NIT-2)', () => {
  const now = new Date('2023-01-01T00:00:00.000Z');
  const valid = (d: string) =>
    validateCreateInput(input({ visitAt: d, expiresAt: '2030-01-01T00:00:00.000Z' }), now);

  it('各月の末日は受理し、その翌日（暦に無い日）は形の検証で拒否する', () => {
    const lastDay: Record<string, number> = {
      '2024-02': 29, // 閏年
      '2025-02': 28,
      '2025-04': 30,
      '2025-06': 30,
      '2025-09': 30,
      '2025-11': 30,
      '2025-01': 31,
      '2025-12': 31,
    };
    for (const [ym, last] of Object.entries(lastDay)) {
      expect(valid(`${ym}-${last}T00:00:00Z`).ok, `${ym}-${last}`).toBe(true);
      const over = valid(`${ym}-${last + 1}T00:00:00Z`);
      expect(over.ok, `${ym}-${last + 1}`).toBe(false);
      if (!over.ok) expect(over.error.message).toMatch(/must be an ISO date/);
    }
  });

  it('日 00 と月 00 は拒否する', () => {
    for (const d of ['2025-01-00T00:00:00Z', '2025-00-10T00:00:00Z']) expect(valid(d).ok, d).toBe(false);
  });
});

/**
 * 再発行で `expiresAt` を省いたときは**保存済みの値**を引き継ぐ (#1022 review2 MINOR-1)。
 *
 * 保存済みの値は、検証を厳しくする前（N3 / NIT-2 より前）に書かれたものでありうる。それを
 * 厳しい検証器へ戻すと、読み取り・受付では使えている予約が再発行だけできなくなる。
 * 引き継ぐ値は読み取り側と**同じ解釈**（`Date.parse`）で正規化する —— 期限の意味は変わらない。
 */
describe('再発行: expiresAt を省くと保存済みの値を正規化して引き継ぐ (#1022 review2 MINOR-1)', () => {
  const now = new Date('2026-06-19T00:00:00.000Z');
  const stored = [
    '2099-06-27T10:00:00', // オフセット無し（N3 より前に API から作られた形）
    '2099-06-27T10:00', // datetime-local の生値
    '2099-02-31T10:00:00Z', // 暦に無い日（NIT-2 より前は通っていた）
    'Sat Jun 27 2099 10:00:00 GMT+0900', // ISO ではないが Date.parse は通る
    '2099-06-27T10:00:00.000Z', // 対照: 正規形
    '2099-06-27', // 対照: 日付のみ
  ];

  for (const s of stored) {
    it(`保存値 ${JSON.stringify(s)}: 受理し、期限の意味を保ち、正規形で書き戻す`, () => {
      const r = applyReissue(
        reservation({ status: 'revoked', visitAt: '2026-06-20T01:00:00.000Z', expiresAt: s }),
        asReservationTokenHash('n'),
        undefined,
        now,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // 不変条件 1: 読み取り側の解釈（Date.parse）で同じ時刻を指す。
      expect(Date.parse(r.value.expiresAt)).toBe(Date.parse(s));
      // 不変条件 2: 書き戻す値は厳しい検証器を通る（明示指定と同じ結果になる）。
      const explicit = applyReissue(
        reservation({ status: 'revoked', visitAt: '2026-06-20T01:00:00.000Z', expiresAt: s }),
        asReservationTokenHash('n'),
        r.value.expiresAt,
        now,
      );
      expect(explicit.ok && explicit.value.expiresAt).toBe(r.value.expiresAt);
    });
  }

  it('保存値を解釈できなければ invalid_input（黙って別の期限にしない）', () => {
    const r = applyReissue(
      reservation({ status: 'revoked', expiresAt: 'not-a-date' }),
      asReservationTokenHash('n'),
      undefined,
      now,
    );
    expect(r.ok).toBe(false);
    // 保存期限の検査に飲み込まれず、「保存値を解釈できない・明示せよ」と言って落ちる。
    if (!r.ok) expect(r.error).toEqual({ code: 'invalid_input', message: expect.stringMatching(/stored expiresAt/) });
  });

  it('引き継いでも保存期限の検証は掛かる（期限が過去なら拒否）', () => {
    const r = applyReissue(
      reservation({ status: 'expired', visitAt: '2026-01-01T00:00:00', expiresAt: '2026-01-02T00:00:00', retentionDays: 1 }),
      asReservationTokenHash('n'),
      undefined,
      now,
    );
    expect(r.ok).toBe(false);
  });

  it('明示した expiresAt は従来どおり厳しく検証する（保存値の寛容さを明示入力へ広げない）', () => {
    for (const v of ['2099-06-27T10:00:00', '2099-02-31T10:00:00Z']) {
      const r = applyReissue(reservation({ status: 'revoked' }), asReservationTokenHash('n'), v, now);
      expect(r.ok, v).toBe(false);
    }
  });
});
