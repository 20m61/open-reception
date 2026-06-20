import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import type { AuditAction } from '@/domain/reception/log';
import { asSignageItemId, type SignageItem } from '@/domain/signage/types';
import { MemorySignageRepository } from './memory-repository';
import { SignageService, type AppendAudit, type UpdateSignageInput } from './service';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_1 = asSiteId('site-1');

const tenantAdminA: Actor = {
  status: 'active',
  assignments: [{ role: 'tenant_admin', tenantId: T_A, siteId: null, deviceId: null }],
};
const viewerA: Actor = {
  status: 'active',
  assignments: [{ role: 'viewer', tenantId: T_A, siteId: null, deviceId: null }],
};

function makeService() {
  const audits: Array<{ action: AuditAction; metadata?: Record<string, string> }> = [];
  const appendAudit: AppendAudit = vi.fn(async (action, _target, metadata) => {
    audits.push({ action, metadata });
  });
  const repo = new MemorySignageRepository();
  const svc = new SignageService({ repo, appendAudit, now: () => new Date('2026-06-20T00:00:00.000Z') });
  return { svc, audits, repo };
}

function clockItem(): SignageItem {
  return { id: asSignageItemId('c1'), type: 'clock', enabled: true };
}

function input(over: Partial<UpdateSignageInput> = {}): UpdateSignageInput {
  return {
    tenantId: T_A,
    siteId: S_1,
    enabled: true,
    defaultIntervalSeconds: 10,
    items: [clockItem()],
    ...over,
  };
}

describe('SignageService.get (#101)', () => {
  it('未保存なら安全な既定（無効・時計なし）を返す', async () => {
    const { svc } = makeService();
    const r = await svc.get(tenantAdminA, T_A, S_1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.enabled).toBe(false);
      expect(r.value.items).toEqual([]);
    }
  });

  it('他テナントは forbidden', async () => {
    const { svc } = makeService();
    const r = await svc.get(tenantAdminA, T_B, S_1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });
});

describe('SignageService.update (#101)', () => {
  it('valid な設定を保存し signage.updated を監査する（PII なし）', async () => {
    const { svc, audits } = makeService();
    const r = await svc.update(tenantAdminA, input());
    expect(r.ok).toBe(true);
    expect(audits.map((a) => a.action)).toEqual(['signage.updated']);
    expect(audits[0]?.metadata).toMatchObject({ enabled: 'true', itemCount: '1' });
  });

  it('enabled かつ再生可能項目なしは invalid_input（fields 付き）', async () => {
    const { svc } = makeService();
    const r = await svc.update(tenantAdminA, input({ items: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_input');
      expect(r.error.fields?.length).toBeGreaterThan(0);
    }
  });

  it('viewer は write 不可（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.update(viewerA, input());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('他テナントへの書き込みは forbidden', async () => {
    const { svc, audits } = makeService();
    const r = await svc.update(tenantAdminA, input({ tenantId: T_B }));
    expect(r.ok).toBe(false);
    expect(audits).toEqual([]);
  });

  it('保存後 get で読み戻せる', async () => {
    const { svc } = makeService();
    await svc.update(tenantAdminA, input({ defaultIntervalSeconds: 15 }));
    const r = await svc.get(tenantAdminA, T_A, S_1);
    expect(r.ok && r.value.defaultIntervalSeconds).toBe(15);
  });
});
