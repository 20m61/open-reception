/**
 * StayRepository の契約テスト（#274 ①: visitstay の repository 標準化）。
 *
 * §9.2（docs/persistence-design.md）の標準どおり、実装は getBackend() 委譲の 1 つだけ。
 * memory backend（DATA_BACKEND 既定）で round-trip・テナント/サイト境界・listPresent の
 * 契約を検証する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { asStayId, type VisitStay } from '@/domain/visit/types';
import { __resetBackend } from '@/lib/data';
import { DataBackedStayRepository } from './repository';

const T = asTenantId('tenant-a');
const S = asSiteId('site-1');
const OTHER_T = asTenantId('tenant-b');
const OTHER_S = asSiteId('site-2');

afterEach(() => {
  __resetBackend();
});

function stay(over: Partial<VisitStay> = {}): VisitStay {
  return {
    id: asStayId('stay-1'),
    tenantId: T,
    siteId: S,
    status: 'present',
    checkedInAt: '2026-06-20T09:00:00.000Z',
    retentionDays: 30,
    createdAt: '2026-06-20T09:00:00.000Z',
    updatedAt: '2026-06-20T09:00:00.000Z',
    ...over,
  };
}

function makeRepo(seed: VisitStay[] = []) {
  __resetBackend();
  return new DataBackedStayRepository(() => seed.map((s) => ({ ...s })));
}

describe('DataBackedStayRepository (#274 ①)', () => {
  it('seed が memory backend に投入され list で返る（サイト境界フィルタ）', async () => {
    const repo = makeRepo([
      stay(),
      stay({ id: asStayId('stay-2'), siteId: OTHER_S }),
      stay({ id: asStayId('stay-3'), tenantId: OTHER_T }),
    ]);
    expect((await repo.list(T, S)).map((s) => s.id)).toEqual(['stay-1']);
  });

  it('listPresent は在館中（present）のみ返す', async () => {
    const repo = makeRepo([
      stay(),
      stay({ id: asStayId('stay-2'), status: 'checked_out' }),
      stay({ id: asStayId('stay-3'), siteId: OTHER_S }),
    ]);
    expect((await repo.listPresent(T, S)).map((s) => s.id)).toEqual(['stay-1']);
  });

  it('get は tenantId/siteId が一致しないと undefined（越境を返さない）', async () => {
    const repo = makeRepo([stay()]);
    expect(await repo.get(T, S, asStayId('stay-1'))).toMatchObject({ id: 'stay-1' });
    expect(await repo.get(T, OTHER_S, asStayId('stay-1'))).toBeUndefined();
    expect(await repo.get(OTHER_T, S, asStayId('stay-1'))).toBeUndefined();
  });

  it('create は id 重複を conflict にする', async () => {
    const repo = makeRepo([stay()]);
    const dup = await repo.create(stay());
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe('conflict');
    const fresh = await repo.create(stay({ id: asStayId('stay-9') }));
    expect(fresh.ok).toBe(true);
  });

  it('put → get が round-trip する（上書き）', async () => {
    const repo = makeRepo([stay()]);
    await repo.put(stay({ status: 'checked_out', checkedOutAt: '2026-06-20T10:00:00.000Z' }));
    expect((await repo.get(T, S, asStayId('stay-1')))?.status).toBe('checked_out');
  });

  it('reset で seed 状態へ戻る（テスト導線）', async () => {
    const repo = makeRepo([stay()]);
    await repo.put(stay({ id: asStayId('stay-extra') }));
    await repo.reset();
    expect((await repo.list(T, S)).map((s) => s.id)).toEqual(['stay-1']);
  });
});
