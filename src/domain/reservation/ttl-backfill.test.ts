import { describe, expect, it } from 'vitest';
import { reservationTtlSeconds } from './retention';
import {
  planReservationTtlBackfill,
  type StoredReservationRetentionFields,
} from './ttl-backfill';

const DAY = 24 * 60 * 60 * 1000;
// 固定日付にしない（CLAUDE.md「検証の作法」: 実時刻と並べる fixture は相対で作る）。
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

function row(over: Partial<StoredReservationRetentionFields> = {}): StoredReservationRetentionFields {
  return {
    id: 'r-1',
    visitAt: iso(NOW + DAY),
    expiresAt: iso(NOW + 2 * DAY),
    retentionDays: 30,
    ...over,
  };
}

describe('planReservationTtlBackfill (#1022 backfill)', () => {
  it('ttl の無い計算可能なレコードには、アプリの書き込みと同じ関数で ttl を付ける', () => {
    const r = row();
    const plan = planReservationTtlBackfill([r], NOW);
    expect(plan.actions).toEqual([{ id: 'r-1', ttl: reservationTtlSeconds(r as never) }]);
    expect(plan.summary).toMatchObject({ scanned: 1, toSet: 1, alreadySet: 0, uncomputable: 0 });
  });

  it('ttl は now に依存しない（同じレコードは now が違っても同じ値）', () => {
    const r = row();
    const a = planReservationTtlBackfill([r], NOW).actions;
    const b = planReservationTtlBackfill([r], NOW + 400 * DAY).actions;
    expect(a).toEqual(b);
  });

  it('retentionDays 欠落の旧レコードは既定 30 日で計算する（読み取り側と同じ規則）', () => {
    const r = row({ retentionDays: undefined });
    const plan = planReservationTtlBackfill([r], NOW);
    expect(plan.actions[0]?.ttl).toBe(
      Math.ceil((Date.parse(r.expiresAt as string) + 30 * DAY) / 1000),
    );
  });

  it('期限を計算できないレコードは飛ばさず、件数と id を報告する（review2 MINOR-2）', () => {
    const rows = [
      row({ id: 'ok' }),
      row({ id: 'zero', retentionDays: 0 }),
      row({ id: 'str', retentionDays: '30' }),
      row({ id: 'huge', retentionDays: 2 ** 53 }),
      row({ id: 'bad-date', visitAt: 'not a date' }),
      row({ id: 'no-expires', expiresAt: undefined }),
    ];
    const plan = planReservationTtlBackfill(rows, NOW);
    expect(plan.summary.uncomputable).toBe(5);
    expect(plan.uncomputableIds).toEqual(['zero', 'str', 'huge', 'bad-date', 'no-expires']);
    // 計算できないものは書き込み対象に入れない（ttl を付けられない）。
    expect(plan.actions.map((a) => a.id)).toEqual(['ok']);
    // 件数の総和が走査件数に一致する ＝ どの区分にも入らず消えるレコードが無い。
    const s = plan.summary;
    expect(s.toSet + s.alreadySet + s.mismatch + s.uncomputable).toBe(s.scanned);
  });

  it('期限を計算できないレコードは ttl を持っていても uncomputable として報告する', () => {
    const plan = planReservationTtlBackfill([row({ retentionDays: 0, ttl: 123 })], NOW);
    expect(plan.summary).toMatchObject({ uncomputable: 1, alreadySet: 0, mismatch: 0 });
  });

  it('計算値と一致する ttl を持つレコードは触らない', () => {
    const r = row();
    const plan = planReservationTtlBackfill([{ ...r, ttl: reservationTtlSeconds(r as never) }], NOW);
    expect(plan.actions).toEqual([]);
    expect(plan.summary).toMatchObject({ alreadySet: 1, toSet: 0 });
  });

  it('計算値と違う ttl（数値以外を含む）は書き換えず、件数と id を報告する', () => {
    const r = row();
    const good = reservationTtlSeconds(r as never)!;
    const plan = planReservationTtlBackfill(
      [
        { ...r, id: 'off-by-one', ttl: good - 1 },
        { ...r, id: 'string', ttl: String(good) },
      ],
      NOW,
    );
    expect(plan.actions).toEqual([]);
    expect(plan.summary.mismatch).toBe(2);
    expect(plan.mismatchIds).toEqual(['off-by-one', 'string']);
  });

  it('付ける ttl が既に過去のもの（付けた時点で TTL 削除対象）を別に数える', () => {
    const past = row({
      id: 'past',
      visitAt: iso(NOW - 40 * DAY),
      expiresAt: iso(NOW - 39 * DAY),
    });
    // 期限のちょうど 1 秒前（境界のすぐ内側）は「まだ過去ではない」。
    const edgeEnd = NOW - 30 * DAY + 1000;
    const edge = row({ id: 'edge', visitAt: iso(edgeEnd), expiresAt: iso(edgeEnd) });
    const plan = planReservationTtlBackfill([past, edge, row({ id: 'future' })], NOW);
    expect(plan.summary.toSet).toBe(3);
    expect(plan.summary.toSetAlreadyExpired).toBe(1);
  });

  it('付ける ttl ちょうどの時刻は「既に過去」に数え、その 1ms 前は数えない（境界）', () => {
    const r = row();
    const ttlMs = reservationTtlSeconds(r as never)! * 1000;
    expect(planReservationTtlBackfill([r], ttlMs).summary.toSetAlreadyExpired).toBe(1);
    expect(planReservationTtlBackfill([r], ttlMs - 1).summary.toSetAlreadyExpired).toBe(0);
  });

  it('id は報告にだけ載り、日時や PII のフィールドは summary に出さない', () => {
    const plan = planReservationTtlBackfill([row({ retentionDays: 0 })], NOW);
    const text = JSON.stringify(plan.summary);
    expect(text).not.toContain('visitAt');
    expect(text).not.toContain(iso(NOW + DAY));
  });
});
