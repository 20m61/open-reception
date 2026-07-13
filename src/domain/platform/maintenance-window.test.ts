/**
 * 予定メンテナンス集計の単体テスト (issue #83 §8 / #90 increment 3e)。
 */
import { describe, expect, it } from 'vitest';
import {
  buildMaintenanceWindow,
  isOpenWindow,
  resolveActiveMaintenance,
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

describe('resolveActiveMaintenance（kiosk enforcement 解決 #290 item3）', () => {
  const NOW = new Date('2026-07-01T12:00:00.000Z'); // win 既定 [00:00, 16:00] の内側
  const inWindow = { startsAt: '2026-07-01T00:00:00.000Z', endsAt: '2026-07-01T16:00:00.000Z' };

  it('platform スコープの進行中メンテは全端末に影響する', () => {
    const r = resolveActiveMaintenance(
      [win({ id: 'p', status: 'active', scope: 'platform', impact: 'read_only', ...inWindow })],
      { tenantId: 'acme', siteId: 'hq', deviceId: 'kiosk-1' },
      NOW,
    );
    expect(r).toEqual({ impact: 'read_only', message: 'm', endsAt: inWindow.endsAt });
  });

  it('tenant スコープは同一 tenantId のみ影響する', () => {
    const windows = [win({ id: 't', status: 'active', scope: 'tenant', tenantId: 'acme', ...inWindow })];
    expect(resolveActiveMaintenance(windows, { tenantId: 'acme' }, NOW)).not.toBeNull();
    expect(resolveActiveMaintenance(windows, { tenantId: 'other' }, NOW)).toBeNull();
    expect(resolveActiveMaintenance(windows, {}, NOW)).toBeNull();
  });

  it('site スコープは同一 siteId のみ影響する', () => {
    const windows = [win({ id: 's', status: 'active', scope: 'site', siteId: 'hq', ...inWindow })];
    expect(resolveActiveMaintenance(windows, { siteId: 'hq' }, NOW)).not.toBeNull();
    expect(resolveActiveMaintenance(windows, { siteId: 'branch' }, NOW)).toBeNull();
    expect(resolveActiveMaintenance(windows, {}, NOW)).toBeNull();
  });

  it('device スコープは同一 deviceId のみ影響する', () => {
    const windows = [win({ id: 'd', status: 'active', scope: 'device', deviceId: 'kiosk-1', ...inWindow })];
    expect(resolveActiveMaintenance(windows, { deviceId: 'kiosk-1' }, NOW)).not.toBeNull();
    expect(resolveActiveMaintenance(windows, { deviceId: 'kiosk-2' }, NOW)).toBeNull();
  });

  it('now が [startsAt, endsAt] の外なら enforcement しない（open でも）', () => {
    const before = new Date('2026-06-30T00:00:00.000Z');
    const after = new Date('2026-07-02T00:00:00.000Z');
    const windows = [win({ id: 'p', status: 'scheduled', scope: 'platform', ...inWindow })];
    expect(resolveActiveMaintenance(windows, {}, before)).toBeNull();
    expect(resolveActiveMaintenance(windows, {}, after)).toBeNull();
    // 内側なら scheduled でも時刻到来で enforcement する。
    expect(resolveActiveMaintenance(windows, {}, NOW)).not.toBeNull();
  });

  it('completed / cancelled は時間内でも enforcement しない', () => {
    expect(
      resolveActiveMaintenance([win({ id: 'c', status: 'completed', scope: 'platform', ...inWindow })], {}, NOW),
    ).toBeNull();
    expect(
      resolveActiveMaintenance([win({ id: 'x', status: 'cancelled', scope: 'platform', ...inWindow })], {}, NOW),
    ).toBeNull();
  });

  it('複数該当時は最も影響度の重いものを返す', () => {
    const r = resolveActiveMaintenance(
      [
        win({ id: 'n', status: 'active', scope: 'platform', impact: 'notice_only', ...inWindow }),
        win({ id: 'u', status: 'active', scope: 'platform', impact: 'unavailable', ...inWindow }),
        win({ id: 'l', status: 'active', scope: 'platform', impact: 'limited', ...inWindow }),
      ],
      {},
      NOW,
    );
    expect(r?.impact).toBe('unavailable');
  });

  it('該当なし・空配列は null', () => {
    expect(resolveActiveMaintenance([], { tenantId: 'acme' }, NOW)).toBeNull();
  });
});
