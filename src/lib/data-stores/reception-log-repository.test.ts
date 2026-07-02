/**
 * ReceptionLogRepository / AuditLogRepository の契約テスト（#274 ⑥）。
 *
 * §9.2（docs/persistence-design.md）の標準どおり、実装は getBackend() の LogStore 委譲の
 * 1 つだけ。memory backend（DATA_BACKEND 既定）で LogStore 契約を固定する:
 *   - list / listSince は新しい順（timestampField 降順）。
 *   - listSince は `timestampField >= sinceIso`（含む）の範囲クエリ (issue #254)。
 *   - findByReceptionId は receptionId 一致の最新 1 件。
 * 監査エントリの組み立て・PII 最小化は reception-log-store.test.ts が固定する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditLog, ReceptionLog } from '@/domain/reception/log';
import { __resetBackend } from '@/lib/data';
import {
  DataBackedAuditLogRepository,
  DataBackedReceptionLogRepository,
} from './reception-log-repository';

afterEach(() => {
  __resetBackend();
});

function rcpLog(over: Partial<ReceptionLog> & { id: string; createdAt: string }): ReceptionLog {
  return {
    receptionId: `rcp-${over.id}`,
    kioskId: 'kiosk-1',
    purpose: 'meeting',
    targetType: 'staff',
    targetId: 'staff-1',
    targetLabel: '佐藤 太郎',
    outcome: 'connected',
    fallbackUsed: false,
    startedAt: over.createdAt,
    endedAt: over.createdAt,
    durationMs: 0,
    ...over,
  };
}

describe('DataBackedReceptionLogRepository (#274 ⑥)', () => {
  it('list は新しい順（createdAt 降順）で返す', async () => {
    __resetBackend();
    const repo = new DataBackedReceptionLogRepository();
    await repo.put(rcpLog({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z' }));
    await repo.put(rcpLog({ id: 'b', createdAt: '2026-07-02T00:00:00.000Z' }));
    await repo.put(rcpLog({ id: 'c', createdAt: '2026-06-30T00:00:00.000Z' }));
    expect((await repo.list()).map((l) => l.id)).toEqual(['b', 'a', 'c']);
  });

  it('listSince は sinceIso を含む範囲（>=）のみを新しい順で返す（#254 の範囲クエリ固定）', async () => {
    __resetBackend();
    const repo = new DataBackedReceptionLogRepository();
    await repo.put(rcpLog({ id: 'old', createdAt: '2026-06-30T23:59:59.999Z' }));
    await repo.put(rcpLog({ id: 'edge', createdAt: '2026-07-01T00:00:00.000Z' }));
    await repo.put(rcpLog({ id: 'new', createdAt: '2026-07-02T00:00:00.000Z' }));
    const since = await repo.listSince('2026-07-01T00:00:00.000Z');
    expect(since.map((l) => l.id)).toEqual(['new', 'edge']); // 境界を含む・降順・old は出ない
  });

  it('findByReceptionId は一致の 1 件を返し、put は同一 id を置換する（fallbackUsed 更新経路）', async () => {
    __resetBackend();
    const repo = new DataBackedReceptionLogRepository();
    await repo.put(rcpLog({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z' }));
    const found = await repo.findByReceptionId('rcp-a');
    expect(found?.id).toBe('a');
    await repo.put({ ...found!, fallbackUsed: true });
    expect((await repo.findByReceptionId('rcp-a'))?.fallbackUsed).toBe(true);
    expect(await repo.list()).toHaveLength(1);
    expect(await repo.findByReceptionId('rcp-none')).toBeUndefined();
  });

  it('reset で初期状態へ戻る（テスト導線）', async () => {
    __resetBackend();
    const repo = new DataBackedReceptionLogRepository();
    await repo.put(rcpLog({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z' }));
    await repo.reset();
    expect(await repo.list()).toEqual([]);
  });
});

describe('DataBackedAuditLogRepository (#274 ⑥)', () => {
  it('put → list が新しい順（at 降順）で round-trip する', async () => {
    __resetBackend();
    const repo = new DataBackedAuditLogRepository();
    const base: Omit<AuditLog, 'id' | 'at'> = {
      action: 'reception.completed',
      actor: 'kiosk:kiosk-1',
      targetType: 'reception',
      targetId: 'rcp-1',
    };
    await repo.put({ ...base, id: 'a1', at: '2026-07-01T00:00:00.000Z' });
    await repo.put({ ...base, id: 'a2', at: '2026-07-02T00:00:00.000Z' });
    expect((await repo.list()).map((l) => l.id)).toEqual(['a2', 'a1']);
    await repo.reset();
    expect(await repo.list()).toEqual([]);
  });
});
