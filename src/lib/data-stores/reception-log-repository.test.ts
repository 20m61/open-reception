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
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditLog, ReceptionLog } from '@/domain/reception/log';
import {
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  DEFAULT_RECEPTION_LOG_RETENTION_DAYS,
  MIN_AUDIT_LOG_RETENTION_DAYS,
} from '@/domain/tenant/limits';
import { __resetBackend } from '@/lib/data';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';
import { DataBackedTenantLimitsRepository } from '@/lib/tenant/limits-store';
import {
  DataBackedAuditLogRepository,
  DataBackedReceptionLogRepository,
} from './reception-log-repository';

afterEach(() => {
  __resetBackend();
  vi.useRealTimers();
});

const DAY_MS = 24 * 60 * 60 * 1000;

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

  it('put が付与する ttl は返却時に見えず（内部属性）、既定保持日数を過ぎると読み取りから外れる（#313）', async () => {
    __resetBackend();
    const repo = new DataBackedReceptionLogRepository();
    const createdAt = '2026-07-01T00:00:00.000Z';
    await repo.put(rcpLog({ id: 'a', createdAt }));

    const [before] = await repo.list();
    expect(before).not.toHaveProperty('ttl');

    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdAt).getTime() + DEFAULT_RECEPTION_LOG_RETENTION_DAYS * DAY_MS - DAY_MS);
    expect(await repo.list()).toHaveLength(1); // 保持期間内はまだ見える

    vi.setSystemTime(new Date(createdAt).getTime() + (DEFAULT_RECEPTION_LOG_RETENTION_DAYS + 1) * DAY_MS);
    expect(await repo.list()).toHaveLength(0); // 保持期間超過で読み取りから外れる
  });

  it('テナントの receptionLogRetentionDays を短く設定すると、以後の書き込みが短い保持期間で失効する（#313）', async () => {
    __resetBackend();
    const tenantId = defaultTenantIdFrom();
    await new DataBackedTenantLimitsRepository().put({
      id: tenantId,
      receptionLogRetentionDays: 1,
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    const repo = new DataBackedReceptionLogRepository();
    const createdAt = '2026-07-01T00:00:00.000Z';
    await repo.put(rcpLog({ id: 'a', createdAt }));

    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdAt).getTime() + 2 * DAY_MS);
    expect(await repo.list()).toHaveLength(0); // 1 日保持 → 2 日後には消えている
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

  it('put が付与する ttl は返却時に見えず、既定保持日数（受付履歴より長め）を過ぎると読み取りから外れる（#313）', async () => {
    __resetBackend();
    const repo = new DataBackedAuditLogRepository();
    const at = '2026-07-01T00:00:00.000Z';
    await repo.put({
      id: 'a1',
      at,
      action: 'reception.completed',
      actor: 'kiosk:kiosk-1',
      targetType: 'reception',
      targetId: 'rcp-1',
    });

    const [before] = await repo.list();
    expect(before).not.toHaveProperty('ttl');
    expect(DEFAULT_AUDIT_LOG_RETENTION_DAYS).toBeGreaterThan(DEFAULT_RECEPTION_LOG_RETENTION_DAYS);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(at).getTime() + (DEFAULT_AUDIT_LOG_RETENTION_DAYS + 1) * DAY_MS);
    expect(await repo.list()).toHaveLength(0);
  });

  it('テナントが下限より短い監査ログ保持日数を設定しても、下限（MIN_AUDIT_LOG_RETENTION_DAYS）までは読み取り可能（#313 の下限保護）', async () => {
    __resetBackend();
    const tenantId = defaultTenantIdFrom();
    await new DataBackedTenantLimitsRepository().put({
      id: tenantId,
      auditLogRetentionDays: 1, // 下限より大幅に短い要求 → 下限へ切り上げられるはず
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    const repo = new DataBackedAuditLogRepository();
    const at = '2026-07-01T00:00:00.000Z';
    await repo.put({
      id: 'a1',
      at,
      action: 'reception.completed',
      actor: 'kiosk:kiosk-1',
      targetType: 'reception',
      targetId: 'rcp-1',
    });

    vi.useFakeTimers();
    // 「短い設定」が素通りしていれば 2 日後には消えているはずだが、下限保護で残っているべき。
    vi.setSystemTime(new Date(at).getTime() + 2 * DAY_MS);
    expect(await repo.list()).toHaveLength(1);

    // 下限を過ぎればさすがに消える。
    vi.setSystemTime(new Date(at).getTime() + (MIN_AUDIT_LOG_RETENTION_DAYS + 1) * DAY_MS);
    expect(await repo.list()).toHaveLength(0);
  });
});
