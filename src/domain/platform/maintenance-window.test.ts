/**
 * 予定メンテナンス集計の単体テスト (issue #83 §8 / #90 increment 3e)。
 */
import { describe, expect, it } from 'vitest';
import {
  buildMaintenanceWindow,
  isOpenWindow,
  summarizeMaintenanceWindows,
  toMaintenanceWindowRow,
  type MaintenanceWindow,
} from './maintenance-window';

const MW_OPTS = { id: 'mw-1', now: new Date('2026-07-01T00:00:00.000Z'), createdBy: 'platform' };
const MW_VALID = {
  scope: 'platform',
  impact: 'limited',
  message: '定期メンテナンス',
  startsAt: '2026-07-10T00:00:00.000Z',
  endsAt: '2026-07-10T02:00:00.000Z',
};

describe('buildMaintenanceWindow (#83 メンテナンス)', () => {
  it('妥当な入力から組み立てる（status 既定 scheduled・updatedAt=now）', () => {
    const r = buildMaintenanceWindow(MW_VALID, MW_OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ id: 'mw-1', scope: 'platform', status: 'scheduled', impact: 'limited', updatedAt: '2026-07-01T00:00:00.000Z' });
  });

  it('不正 enum・空 message・長すぎる message は error', () => {
    expect(buildMaintenanceWindow({ ...MW_VALID, scope: 'x' }, MW_OPTS).ok).toBe(false);
    expect(buildMaintenanceWindow({ ...MW_VALID, impact: 'x' }, MW_OPTS).ok).toBe(false);
    expect(buildMaintenanceWindow({ ...MW_VALID, message: '  ' }, MW_OPTS).ok).toBe(false);
    expect(buildMaintenanceWindow({ ...MW_VALID, message: 'm'.repeat(2001) }, MW_OPTS).ok).toBe(false);
  });

  it('startsAt/endsAt の妥当性と前後関係を検証（ISO 正規化）', () => {
    expect(buildMaintenanceWindow({ ...MW_VALID, endsAt: 'nope' }, MW_OPTS).ok).toBe(false);
    // endsAt <= startsAt。
    expect(buildMaintenanceWindow({ ...MW_VALID, endsAt: MW_VALID.startsAt }, MW_OPTS).ok).toBe(false);
    // +09:00 は UTC ISO へ正規化。
    const r = buildMaintenanceWindow({ ...MW_VALID, startsAt: '2026-07-10T09:00:00+09:00' }, MW_OPTS);
    expect(r.ok && r.value.startsAt).toBe('2026-07-10T00:00:00.000Z');
  });

  it('スコープ整合: tenant は tenantId が要る／platform は下位 id を落とす', () => {
    expect(buildMaintenanceWindow({ ...MW_VALID, scope: 'tenant' }, MW_OPTS).ok).toBe(false);
    const r = buildMaintenanceWindow({ ...MW_VALID, tenantId: 'x' }, MW_OPTS);
    expect(r.ok && r.value.tenantId).toBeUndefined(); // platform スコープ
  });
});

function win(
  args: Partial<MaintenanceWindow> & Pick<MaintenanceWindow, 'id' | 'status' | 'startsAt'>,
): MaintenanceWindow {
  return {
    scope: 'platform',
    endsAt: '2026-07-01T16:00:00.000Z',
    message: 'm',
    impact: 'read_only',
    createdBy: 'platform:op-1',
    updatedAt: '2026-06-20T00:00:00.000Z',
    ...args,
  };
}

describe('isOpenWindow', () => {
  it('scheduled / active を open とみなす', () => {
    expect(isOpenWindow({ status: 'scheduled' })).toBe(true);
    expect(isOpenWindow({ status: 'active' })).toBe(true);
    expect(isOpenWindow({ status: 'completed' })).toBe(false);
    expect(isOpenWindow({ status: 'cancelled' })).toBe(false);
  });
});

describe('toMaintenanceWindowRow', () => {
  it('表示用フィールドのみを射影し、createdBy（操作者識別子）は載せない', () => {
    const row = toMaintenanceWindowRow(
      win({ id: 'w1', status: 'active', startsAt: '2026-07-01T15:00:00.000Z', createdBy: 'platform:secret-op' }),
    );
    expect(row).toMatchObject({ id: 'w1', status: 'active', impact: 'read_only', open: true });
    expect('createdBy' in row).toBe(false);
    expect(JSON.stringify(row)).not.toContain('secret-op');
  });
});

describe('summarizeMaintenanceWindows', () => {
  it('open 優先 → 開始予定の早い順に並べる', () => {
    const ids = summarizeMaintenanceWindows([
      win({ id: 'completed-early', status: 'completed', startsAt: '2026-06-01T00:00:00.000Z' }),
      win({ id: 'scheduled-late', status: 'scheduled', startsAt: '2026-07-10T00:00:00.000Z' }),
      win({ id: 'active-early', status: 'active', startsAt: '2026-07-01T00:00:00.000Z' }),
    ]).windows.map((w) => w.id);
    expect(ids).toEqual(['active-early', 'scheduled-late', 'completed-early']);
  });

  it('active / scheduled / total を集計する', () => {
    const summary = summarizeMaintenanceWindows([
      win({ id: 'a', status: 'active', startsAt: '2026-07-01T00:00:00.000Z' }),
      win({ id: 's', status: 'scheduled', startsAt: '2026-07-02T00:00:00.000Z' }),
      win({ id: 'c', status: 'cancelled', startsAt: '2026-07-03T00:00:00.000Z' }),
    ]);
    expect(summary.activeCount).toBe(1);
    expect(summary.scheduledCount).toBe(1);
    expect(summary.totalCount).toBe(3);
  });

  it('空配列は 0 件', () => {
    const summary = summarizeMaintenanceWindows([]);
    expect(summary).toMatchObject({ activeCount: 0, scheduledCount: 0, totalCount: 0, windows: [] });
  });
});
