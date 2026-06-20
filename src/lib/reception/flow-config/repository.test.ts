import { describe, expect, it } from 'vitest';
import { asReceptionFlowId } from '@/domain/reception/custom-flow';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { MemoryReceptionFlowRepository } from './repository';
import type { StoredReceptionFlow } from './types';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_A1 = asSiteId('site-a1');
const S_A2 = asSiteId('site-a2');

function flow(over: Partial<StoredReceptionFlow> & Pick<StoredReceptionFlow, 'id'>): StoredReceptionFlow {
  return {
    tenantId: T_A,
    siteId: S_A1,
    purposeKey: 'general',
    displayName: '通常',
    order: 0,
    enabled: true,
    steps: ['purpose', 'confirm', 'call'],
    fields: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
    id: over.id,
  } as StoredReceptionFlow;
}

describe('MemoryReceptionFlowRepository (#100)', () => {
  it('テナント境界でフィルタする', async () => {
    const repo = new MemoryReceptionFlowRepository([
      flow({ id: asReceptionFlowId('f1'), tenantId: T_A }),
      flow({ id: asReceptionFlowId('f2'), tenantId: T_B, purposeKey: 'x' }),
    ]);
    expect((await repo.listFlows(T_A)).map((f) => f.id)).toEqual(['f1']);
  });

  it('siteId 指定で絞り込む', async () => {
    const repo = new MemoryReceptionFlowRepository([
      flow({ id: asReceptionFlowId('f1'), siteId: S_A1 }),
      flow({ id: asReceptionFlowId('f2'), siteId: S_A2, purposeKey: 'x' }),
    ]);
    expect((await repo.listFlows(T_A, S_A2)).map((f) => f.id)).toEqual(['f2']);
  });

  it('他テナントの get は undefined（境界隔離）', async () => {
    const repo = new MemoryReceptionFlowRepository([flow({ id: asReceptionFlowId('f1') })]);
    expect(await repo.getFlow(T_B, asReceptionFlowId('f1'))).toBeUndefined();
  });

  it('重複 id の作成は conflict', async () => {
    const repo = new MemoryReceptionFlowRepository([flow({ id: asReceptionFlowId('f1') })]);
    const r = await repo.createFlow(flow({ id: asReceptionFlowId('f1') }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('conflict');
  });

  it('同一サイト内の purposeKey 重複は conflict', async () => {
    const repo = new MemoryReceptionFlowRepository([
      flow({ id: asReceptionFlowId('f1'), purposeKey: 'interview' }),
    ]);
    const r = await repo.createFlow(
      flow({ id: asReceptionFlowId('f2'), purposeKey: 'interview' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('conflict');
  });

  it('別サイトなら同じ purposeKey でも作成できる', async () => {
    const repo = new MemoryReceptionFlowRepository([
      flow({ id: asReceptionFlowId('f1'), siteId: S_A1, purposeKey: 'interview' }),
    ]);
    const r = await repo.createFlow(
      flow({ id: asReceptionFlowId('f2'), siteId: S_A2, purposeKey: 'interview' }),
    );
    expect(r.ok).toBe(true);
  });

  it('他テナントの delete は not_found（越境削除拒否）', async () => {
    const repo = new MemoryReceptionFlowRepository([flow({ id: asReceptionFlowId('f1'), tenantId: T_A })]);
    const r = await repo.deleteFlow(T_B, asReceptionFlowId('f1'));
    expect(r.ok).toBe(false);
    expect(await repo.getFlow(T_A, asReceptionFlowId('f1'))).toBeDefined();
  });

  it('返り値は防御的コピー（外部変更が内部状態に波及しない）', async () => {
    const repo = new MemoryReceptionFlowRepository([flow({ id: asReceptionFlowId('f1') })]);
    const got = await repo.getFlow(T_A, asReceptionFlowId('f1'));
    got!.displayName = 'mutated';
    expect((await repo.getFlow(T_A, asReceptionFlowId('f1')))!.displayName).toBe('通常');
  });
});
