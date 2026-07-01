/**
 * 障害・インシデント集計の単体テスト (issue #83 §6 / #90 increment 3e)。
 */
import { describe, expect, it } from 'vitest';
import {
  buildIncident,
  isActiveIncident,
  summarizeIncidents,
  toIncidentRow,
  type Incident,
} from './incident';

const OPTS = { id: 'inc-1', now: new Date('2026-07-01T00:00:00.000Z'), updatedBy: 'platform' };

describe('buildIncident (#83 AC7)', () => {
  it('妥当な入力から Incident を組み立てる（status 既定 investigating・startedAt 既定 now）', () => {
    const r = buildIncident({ scope: 'platform', severity: 'major', title: 't', message: 'm' }, OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({ id: 'inc-1', scope: 'platform', status: 'investigating', updatedBy: 'platform' });
      expect(r.value.startedAt).toBe('2026-07-01T00:00:00.000Z');
    }
  });

  it('不正な enum・空 title/message は error', () => {
    expect(buildIncident({ scope: 'x', severity: 'major', title: 't', message: 'm' }, OPTS).ok).toBe(false);
    expect(buildIncident({ scope: 'platform', severity: 'x', title: 't', message: 'm' }, OPTS).ok).toBe(false);
    expect(buildIncident({ scope: 'platform', severity: 'major', title: '  ', message: 'm' }, OPTS).ok).toBe(false);
  });

  it('スコープ整合: tenant は tenantId、device は tenantId+siteId+deviceId が要る', () => {
    expect(buildIncident({ scope: 'tenant', severity: 'minor', title: 't', message: 'm' }, OPTS).ok).toBe(false);
    const ok = buildIncident({ scope: 'tenant', tenantId: 'x', severity: 'minor', title: 't', message: 'm' }, OPTS);
    expect(ok.ok).toBe(true);
    expect(buildIncident({ scope: 'device', tenantId: 'x', siteId: 's', severity: 'minor', title: 't', message: 'm' }, OPTS).ok).toBe(false);
  });

  it('platform スコープでは下位 id を落とす', () => {
    const r = buildIncident({ scope: 'platform', tenantId: 'x', severity: 'info', title: 't', message: 'm' }, OPTS);
    expect(r.ok && r.value.tenantId).toBeUndefined();
  });

  it('status=resolved は resolvedAt を now で埋める', () => {
    const r = buildIncident({ scope: 'platform', severity: 'info', status: 'resolved', title: 't', message: 'm' }, OPTS);
    expect(r.ok && r.value.resolvedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('title/message が長すぎると error（貼り付け抑制）', () => {
    expect(buildIncident({ scope: 'platform', severity: 'info', title: 'a'.repeat(201), message: 'm' }, OPTS).ok).toBe(false);
    expect(buildIncident({ scope: 'platform', severity: 'info', title: 't', message: 'm'.repeat(2001) }, OPTS).ok).toBe(false);
  });

  it('startedAt は ISO に正規化して保存する（非 ISO の parse 可能値も）', () => {
    const r = buildIncident(
      { scope: 'platform', severity: 'info', title: 't', message: 'm', startedAt: '2026-06-01T09:00:00+09:00' },
      OPTS,
    );
    expect(r.ok && r.value.startedAt).toBe('2026-06-01T00:00:00.000Z'); // +09:00 → UTC ISO
    // parse 不能は now。
    const bad = buildIncident({ scope: 'platform', severity: 'info', title: 't', message: 'm', startedAt: 'not-a-date' }, OPTS);
    expect(bad.ok && bad.value.startedAt).toBe('2026-07-01T00:00:00.000Z');
  });
});

function incident(args: Partial<Incident> & Pick<Incident, 'id' | 'severity' | 'status'>): Incident {
  return {
    scope: 'platform',
    title: 't',
    message: 'm',
    startedAt: '2026-06-01T00:00:00.000Z',
    updatedBy: 'platform:op-1',
    ...args,
  };
}

describe('isActiveIncident', () => {
  it('resolved 以外は active', () => {
    expect(isActiveIncident({ status: 'investigating' })).toBe(true);
    expect(isActiveIncident({ status: 'monitoring' })).toBe(true);
    expect(isActiveIncident({ status: 'resolved' })).toBe(false);
  });
});

describe('toIncidentRow', () => {
  it('表示用フィールドのみを射影し、updatedBy（操作者識別子）は載せない', () => {
    const row = toIncidentRow(
      incident({ id: 'i1', severity: 'major', status: 'monitoring', updatedBy: 'platform:secret-op' }),
    );
    expect(row).toMatchObject({ id: 'i1', severity: 'major', status: 'monitoring', active: true });
    expect('updatedBy' in row).toBe(false);
    expect(JSON.stringify(row)).not.toContain('secret-op');
  });
});

describe('summarizeIncidents', () => {
  it('進行中優先 → 重大度降順 → 発生新しい順に並べる', () => {
    const rows = summarizeIncidents([
      incident({ id: 'resolved-critical', severity: 'critical', status: 'resolved' }),
      incident({ id: 'active-minor', severity: 'minor', status: 'investigating' }),
      incident({
        id: 'active-critical-old',
        severity: 'critical',
        status: 'identified',
        startedAt: '2026-06-01T00:00:00.000Z',
      }),
      incident({
        id: 'active-critical-new',
        severity: 'critical',
        status: 'identified',
        startedAt: '2026-06-05T00:00:00.000Z',
      }),
    ]).incidents.map((r) => r.id);
    expect(rows).toEqual([
      'active-critical-new',
      'active-critical-old',
      'active-minor',
      'resolved-critical',
    ]);
  });

  it('activeCount / totalCount / activeBySeverity を集計する（resolved は active に数えない）', () => {
    const summary = summarizeIncidents([
      incident({ id: 'a', severity: 'critical', status: 'investigating' }),
      incident({ id: 'b', severity: 'major', status: 'monitoring' }),
      incident({ id: 'c', severity: 'critical', status: 'resolved' }),
    ]);
    expect(summary.totalCount).toBe(3);
    expect(summary.activeCount).toBe(2);
    expect(summary.activeBySeverity).toEqual({ info: 0, minor: 0, major: 1, critical: 1 });
  });

  it('空配列は activeCount 0 / 空行', () => {
    const summary = summarizeIncidents([]);
    expect(summary.activeCount).toBe(0);
    expect(summary.totalCount).toBe(0);
    expect(summary.incidents).toEqual([]);
  });
});
