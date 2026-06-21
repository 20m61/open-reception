import { describe, expect, it } from 'vitest';
import type { AuditLog } from '@/domain/reception/log';
import { auditActionFacets, filterAuditLogs, matchesAuditFilter } from './audit-filter';

function alog(over: Partial<AuditLog> & Pick<AuditLog, 'id' | 'action' | 'at'>): AuditLog {
  return {
    actor: 'admin',
    ...over,
  };
}

const LOGS: AuditLog[] = [
  alog({ id: '1', action: 'security.updated', actor: 'admin', at: '2026-06-01T09:00:00.000Z', targetType: 'security' }),
  alog({ id: '2', action: 'reception.connected', actor: 'kiosk:k-1', at: '2026-06-10T09:00:00.000Z', targetType: 'reception', targetId: 'rcp-42' }),
  alog({ id: '3', action: 'reception.timeout', actor: 'kiosk:k-2', at: '2026-06-20T09:00:00.000Z', targetType: 'reception', targetId: 'rcp-99' }),
  alog({ id: '4', action: 'integration.tested', actor: 'admin', at: '2026-05-15T09:00:00.000Z', metadata: { result: 'ok' } }),
];

describe('matchesAuditFilter (#89 inc2)', () => {
  it('条件なしは全件一致', () => {
    expect(LOGS.every((l) => matchesAuditFilter(l, {}))).toBe(true);
  });

  it('開始日（含む）で下限を絞る', () => {
    const r = filterAuditLogs(LOGS, { start: '2026-06-01T00:00:00.000Z' });
    expect(r.map((l) => l.id)).toEqual(['1', '2', '3']);
  });

  it('終了日（日付のみ）はその日いっぱいを含める', () => {
    const r = filterAuditLogs(LOGS, { end: '2026-06-10' });
    expect(r.map((l) => l.id)).toEqual(['1', '2', '4']);
  });

  it('期間 [start, end] で両端を絞る', () => {
    const r = filterAuditLogs(LOGS, { start: '2026-06-01', end: '2026-06-15' });
    expect(r.map((l) => l.id)).toEqual(['1', '2']);
  });

  it('アクション種別の完全一致（複数 OR）で絞る', () => {
    const r = filterAuditLogs(LOGS, { actions: ['reception.connected', 'reception.timeout'] });
    expect(r.map((l) => l.id)).toEqual(['2', '3']);
  });

  it('空のアクション配列は絞り込まない', () => {
    expect(filterAuditLogs(LOGS, { actions: [] })).toHaveLength(4);
  });

  it('主体（actor）は部分一致・大文字小文字無視', () => {
    expect(filterAuditLogs(LOGS, { actor: 'KIOSK' }).map((l) => l.id)).toEqual(['2', '3']);
    expect(filterAuditLogs(LOGS, { actor: 'k-1' }).map((l) => l.id)).toEqual(['2']);
  });

  it('キーワードは対象種別・対象ID・アクション・metadata を横断する', () => {
    expect(filterAuditLogs(LOGS, { keyword: 'rcp-42' }).map((l) => l.id)).toEqual(['2']);
    expect(filterAuditLogs(LOGS, { keyword: 'security' }).map((l) => l.id)).toEqual(['1']);
    expect(filterAuditLogs(LOGS, { keyword: 'ok' }).map((l) => l.id)).toEqual(['4']);
  });

  it('複数条件は AND で結合する', () => {
    const r = filterAuditLogs(LOGS, { start: '2026-06-01', actor: 'kiosk', actions: ['reception.timeout'] });
    expect(r.map((l) => l.id)).toEqual(['3']);
  });

  it('一致しない条件は空配列', () => {
    expect(filterAuditLogs(LOGS, { actor: 'no-such-actor' })).toEqual([]);
  });

  it('空白のみの actor/keyword は絞り込まない', () => {
    expect(filterAuditLogs(LOGS, { actor: '   ', keyword: '  ' })).toHaveLength(4);
  });
});

describe('auditActionFacets (#89 inc2)', () => {
  it('実在アクションを出現頻度つきで返す（件数降順→名前昇順）', () => {
    const facets = auditActionFacets([
      alog({ id: 'a', action: 'reception.connected', at: '2026-06-01T00:00:00.000Z' }),
      alog({ id: 'b', action: 'reception.connected', at: '2026-06-01T00:00:00.000Z' }),
      alog({ id: 'c', action: 'security.updated', at: '2026-06-01T00:00:00.000Z' }),
    ]);
    expect(facets).toEqual([
      { action: 'reception.connected', count: 2 },
      { action: 'security.updated', count: 1 },
    ]);
  });

  it('空ログは空の facets', () => {
    expect(auditActionFacets([])).toEqual([]);
  });
});
