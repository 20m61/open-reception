import { describe, expect, it } from 'vitest';
import {
  isPendingUpdate,
  summarizeUpdateStatuses,
  toUpdateStatusRow,
  type UpdateStatus,
} from './update-status';

function upd(over: Partial<UpdateStatus>): UpdateStatus {
  return {
    id: 'u1',
    scope: 'device',
    component: 'kiosk-app',
    currentVersion: '1.0.0',
    latestVersion: '1.0.0',
    state: 'up_to_date',
    checkedAt: '2026-06-20T00:00:00.000Z',
    updatedBy: 'platform:demo',
    ...over,
  };
}

describe('isPendingUpdate', () => {
  it('up_to_date のみ pending でない', () => {
    expect(isPendingUpdate({ state: 'up_to_date' })).toBe(false);
    for (const s of ['update_available', 'updating', 'failed'] as const) {
      expect(isPendingUpdate({ state: s })).toBe(true);
    }
  });
});

describe('toUpdateStatusRow', () => {
  it('whitelist 射影し updatedBy を落とす・pending を導出', () => {
    const row = toUpdateStatusRow(
      upd({ id: 'u9', state: 'failed', tenantId: 't1', updatedBy: 'platform:ops@x' }),
    );
    expect(row).toEqual({
      id: 'u9',
      scope: 'device',
      tenantId: 't1',
      siteId: undefined,
      deviceId: undefined,
      component: 'kiosk-app',
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      state: 'failed',
      checkedAt: '2026-06-20T00:00:00.000Z',
      pending: true,
    });
    expect('updatedBy' in row).toBe(false);
  });
});

describe('summarizeUpdateStatuses', () => {
  it('pending 優先 → 状況の重み降順 → 確認新しい順で並べ、件数/内訳を返す', () => {
    const rows = summarizeUpdateStatuses([
      upd({ id: 'ok', state: 'up_to_date', checkedAt: '2026-06-25T00:00:00.000Z' }),
      upd({ id: 'avail', state: 'update_available', checkedAt: '2026-06-21T00:00:00.000Z' }),
      upd({ id: 'fail', state: 'failed', checkedAt: '2026-06-20T00:00:00.000Z' }),
      upd({ id: 'updating', state: 'updating', checkedAt: '2026-06-22T00:00:00.000Z' }),
    ]);
    // pending 3 件が先頭（failed→update_available→updating の重み順）、最後に up_to_date。
    expect(rows.updates.map((r) => r.id)).toEqual(['fail', 'avail', 'updating', 'ok']);
    expect(rows.pendingCount).toBe(3);
    expect(rows.totalCount).toBe(4);
    expect(rows.byState).toEqual({ up_to_date: 1, update_available: 1, updating: 1, failed: 1 });
  });

  it('同一状況内は確認新しい順', () => {
    const rows = summarizeUpdateStatuses([
      upd({ id: 'old', state: 'failed', checkedAt: '2026-06-20T00:00:00.000Z' }),
      upd({ id: 'new', state: 'failed', checkedAt: '2026-06-24T00:00:00.000Z' }),
    ]);
    expect(rows.updates.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('空配列は 0 件', () => {
    const s = summarizeUpdateStatuses([]);
    expect(s.pendingCount).toBe(0);
    expect(s.totalCount).toBe(0);
    expect(s.updates).toEqual([]);
  });
});
