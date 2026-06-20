import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { MemoryCallRouteRepository } from './repository';
import { asCallRouteId, type CallRoute } from './types';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_A1 = asSiteId('site-a1');
const S_A2 = asSiteId('site-a2');

function route(id: string, tenantId = T_A, siteId = S_A1): CallRoute {
  return {
    id: asCallRouteId(id),
    tenantId,
    siteId,
    name: id,
    groups: [],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('MemoryCallRouteRepository (#88)', () => {
  it('テナント境界でフィルタする', async () => {
    const repo = new MemoryCallRouteRepository([route('r1', T_A), route('r2', T_B)]);
    expect((await repo.listRoutes(T_A)).map((r) => r.id)).toEqual(['r1']);
  });

  it('siteId 指定で絞り込む', async () => {
    const repo = new MemoryCallRouteRepository([route('r1', T_A, S_A1), route('r2', T_A, S_A2)]);
    expect((await repo.listRoutes(T_A, S_A2)).map((r) => r.id)).toEqual(['r2']);
  });

  it('他テナントの get は undefined（境界隔離）', async () => {
    const repo = new MemoryCallRouteRepository([route('r1', T_A)]);
    expect(await repo.getRoute(T_B, asCallRouteId('r1'))).toBeUndefined();
  });

  it('重複 id の作成は conflict', async () => {
    const repo = new MemoryCallRouteRepository([route('r1')]);
    const r = await repo.createRoute(route('r1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('conflict');
  });

  it('他テナントの delete は not_found（越境削除拒否）', async () => {
    const repo = new MemoryCallRouteRepository([route('r1', T_A)]);
    const r = await repo.deleteRoute(T_B, asCallRouteId('r1'));
    expect(r.ok).toBe(false);
    // 越境削除されていないこと。
    expect(await repo.getRoute(T_A, asCallRouteId('r1'))).toBeDefined();
  });

  it('返り値は防御的コピー（外部変更が内部状態に波及しない）', async () => {
    const repo = new MemoryCallRouteRepository([route('r1')]);
    const got = await repo.getRoute(T_A, asCallRouteId('r1'));
    got!.name = 'mutated';
    expect((await repo.getRoute(T_A, asCallRouteId('r1')))!.name).toBe('r1');
  });
});
