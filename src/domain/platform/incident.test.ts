/**
 * 障害・インシデント集計の単体テスト (issue #83 §6 / #90 increment 3e)。
 */
import { describe, expect, it } from 'vitest';
import {
  isActiveIncident,
  summarizeIncidents,
  toIncidentRow,
  type Incident,
} from './incident';

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
