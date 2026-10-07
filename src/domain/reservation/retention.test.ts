/**
 * 予約 PII の保存期間 (#1022)。
 *
 * 期待値を分岐ごとに書かず、**不変条件**で縛る:
 *   - 上界: 期限（来訪の終わり + retentionDays）以降は保持しない
 *   - 下界: 来訪の終わり + retentionDays の**すぐ内側**までは必ず保持する
 *   - 起点は来訪の終わり（visitAt と expiresAt の遅い方）であり、作成・更新日時ではない
 *   - 物理削除（TTL）は読み取り側の期限より先に起きない
 *
 * 日付はすべて `Date.now()` 相対で作る（固定日付は time bomb になる）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESERVATION_RETENTION_DAYS,
  isReservationRetainedAt,
  reservationRetentionDeadlineMs,
  reservationTtlSeconds,
} from './retention';

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/** 現在時刻を基準に、来訪予定・有効期限・保持日数の組合せを総当たりする。 */
function cases(base: number) {
  const offsets = [-400 * DAY, -31 * DAY, -1 * DAY, -1, 0, 1, 1 * DAY, 90 * DAY];
  const days = [1, 7, 30, 365];
  const out: { visitAt: number; expiresAt: number; retentionDays: number }[] = [];
  for (const v of offsets)
    for (const gap of [0, 1, 6 * 60 * 60 * 1000, 7 * DAY, -3 * DAY])
      for (const d of days) out.push({ visitAt: base + v, expiresAt: base + v + gap, retentionDays: d });
  return out;
}

function rec(c: { visitAt: number; expiresAt: number; retentionDays: number }) {
  return { visitAt: iso(c.visitAt), expiresAt: iso(c.expiresAt), retentionDays: c.retentionDays };
}

describe('reservation retention (#1022)', () => {
  const base = Date.now();

  it('来訪の終わり + retentionDays のすぐ内側までは必ず保持する（下界）', () => {
    for (const c of cases(base)) {
      const end = Math.max(c.visitAt, c.expiresAt);
      const r = rec(c);
      const justInside = end + c.retentionDays * DAY - 1;
      expect(isReservationRetainedAt(r, new Date(justInside)), JSON.stringify(c)).toBe(true);
      // 来訪の終わりそのもの・来訪の始まり・作成直後も当然保持している。
      expect(isReservationRetainedAt(r, new Date(end))).toBe(true);
      expect(isReservationRetainedAt(r, new Date(Math.min(c.visitAt, c.expiresAt)))).toBe(true);
    }
  });

  it('期限ちょうど以降は保持しない（上界）', () => {
    for (const c of cases(base)) {
      const end = Math.max(c.visitAt, c.expiresAt);
      const r = rec(c);
      const deadline = end + c.retentionDays * DAY;
      expect(isReservationRetainedAt(r, new Date(deadline)), JSON.stringify(c)).toBe(false);
      expect(isReservationRetainedAt(r, new Date(deadline + 1))).toBe(false);
      expect(isReservationRetainedAt(r, new Date(deadline + 400 * DAY))).toBe(false);
    }
  });

  it('起点は visitAt と expiresAt の遅い方（どちらが後でも、早い方からは数えない）', () => {
    const visitAt = base + 10 * DAY;
    // expiresAt が後
    const later = rec({ visitAt, expiresAt: visitAt + 5 * DAY, retentionDays: 2 });
    expect(isReservationRetainedAt(later, new Date(visitAt + 2 * DAY + 1))).toBe(true);
    expect(isReservationRetainedAt(later, new Date(visitAt + 7 * DAY - 1))).toBe(true);
    // visitAt が後（入力検証は弾くが、判定は順序に依存しない）
    const earlier = rec({ visitAt, expiresAt: visitAt - 5 * DAY, retentionDays: 2 });
    expect(isReservationRetainedAt(earlier, new Date(visitAt - 3 * DAY + 1))).toBe(true);
    expect(isReservationRetainedAt(earlier, new Date(visitAt + 2 * DAY - 1))).toBe(true);
    expect(isReservationRetainedAt(earlier, new Date(visitAt + 2 * DAY))).toBe(false);
  });

  it('作成・更新日時は起点にしない（先の日付の予約が来訪前に消えない）', () => {
    const r = {
      ...rec({ visitAt: base + 60 * DAY, expiresAt: base + 61 * DAY, retentionDays: 1 }),
      createdAt: iso(base - 400 * DAY),
      updatedAt: iso(base - 400 * DAY),
    };
    expect(isReservationRetainedAt(r, new Date(base))).toBe(true);
    expect(isReservationRetainedAt(r, new Date(base + 61 * DAY + DAY - 1))).toBe(true);
  });

  it('既定の保持日数は 30 日', () => {
    // 作成リクエストで省略したときの既定も同じ定数（request.test.ts が縛る）。
    expect(DEFAULT_RESERVATION_RETENTION_DAYS).toBe(30);
  });

  it('retentionDays が欠落・不正な旧レコードは既定日数で判定する', () => {
    const end = base - 2 * DAY;
    for (const bad of [undefined, 0, -1, 1.5, Number.NaN, '30']) {
      const r = { visitAt: iso(end), expiresAt: iso(end), retentionDays: bad as unknown as number };
      expect(
        isReservationRetainedAt(r, new Date(end + DEFAULT_RESERVATION_RETENTION_DAYS * DAY - 1)),
        String(bad),
      ).toBe(true);
      expect(isReservationRetainedAt(r, new Date(end + DEFAULT_RESERVATION_RETENTION_DAYS * DAY))).toBe(
        false,
      );
    }
  });

  it('日付を解釈できないレコードは保持しない（PII を残す側へ倒さない）・TTL は付けない', () => {
    for (const r of [
      { visitAt: 'not-a-date', expiresAt: iso(base + DAY), retentionDays: 30 },
      { visitAt: iso(base + DAY), expiresAt: '', retentionDays: 30 },
    ]) {
      expect(isReservationRetainedAt(r, new Date(base))).toBe(false);
      expect(reservationTtlSeconds(r)).toBeUndefined();
    }
  });

  it('TTL（物理削除）は読み取り側の期限より先に起きず、遅れても 1 秒未満', () => {
    for (const c of cases(base)) {
      // ミリ秒端数を持つ起点も混ぜる
      for (const frac of [0, 1, 999]) {
        const r = rec({ ...c, visitAt: c.visitAt + frac, expiresAt: c.expiresAt + frac });
        const ttl = reservationTtlSeconds(r)!;
        expect(Number.isInteger(ttl)).toBe(true);
        const deadline = reservationRetentionDeadlineMs(r);
        // TTL 時刻の時点でも読み取り側は保持していない（ttl*1000 >= 期限）
        expect(ttl * 1000).toBeGreaterThanOrEqual(deadline);
        expect(isReservationRetainedAt(r, new Date(ttl * 1000))).toBe(false);
        // TTL の 1 秒前はまだ保持期間内か、期限が端数で直前にある（遅れ < 1 秒）
        expect(ttl * 1000 - deadline).toBeLessThan(1000);
      }
    }
  });
});
