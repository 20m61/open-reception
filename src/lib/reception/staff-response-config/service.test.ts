/**
 * 担当者応答設定サービスの単体テスト (issue #99 inc2)。
 * 設定解決（既定フォールバック・上書き）・更新（有効無効/文言）・認可境界・respond 向け
 * resolveOverrides を検証する。
 */
import { describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { getStaffResponseDefinition } from '@/domain/reception/staff-response';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { MemoryStaffResponseConfigRepository } from './repository';
import { MESSAGE_OVERRIDE_MAX, StaffResponseConfigService } from './service';
import type { StoredStaffResponseConfig } from './types';

const T_A = asTenantId('tenant-a');
const S_A1 = asSiteId('site-a1');
const S_A2 = asSiteId('site-a2');

const tenantAdminA: Actor = {
  status: 'active',
  assignments: [{ role: 'tenant_admin', tenantId: T_A, siteId: null, deviceId: null }],
};
const siteManagerA1: Actor = {
  status: 'active',
  assignments: [{ role: 'site_manager', tenantId: T_A, siteId: S_A1, deviceId: null }],
};
const viewerA: Actor = {
  status: 'active',
  assignments: [{ role: 'viewer', tenantId: T_A, siteId: null, deviceId: null }],
};

function makeService(seed: StoredStaffResponseConfig[] = []) {
  const repo = new MemoryStaffResponseConfigRepository(seed);
  const svc = new StaffResponseConfigService({
    repo,
    now: () => new Date('2026-06-20T00:00:00.000Z'),
  });
  return { svc, repo };
}

describe('StaffResponseConfigService.getView (#99 inc2)', () => {
  it('未保存サイトでも全種別を既定で返す', async () => {
    const { svc } = makeService();
    const r = await svc.getView(tenantAdminA, T_A, S_A1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.definitions).toHaveLength(5);
      const coming = r.value.definitions.find((d) => d.action === 'coming')!;
      expect(coming.enabled).toBe(getStaffResponseDefinition('coming').defaultEnabled);
      expect(coming.isMessageOverridden).toBe(false);
      expect(r.value.updatedAt).toBeUndefined();
    }
  });

  it('保存済み上書きを実効定義に反映する', async () => {
    const { svc } = makeService([
      {
        id: `${T_A}#${S_A1}`,
        tenantId: T_A,
        siteId: S_A1,
        overrides: { decline: { enabled: false, messageOverride: '本日終了' } },
        createdAt: '2026-06-19T00:00:00.000Z',
        updatedAt: '2026-06-19T00:00:00.000Z',
      },
    ]);
    const r = await svc.getView(tenantAdminA, T_A, S_A1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const decline = r.value.definitions.find((d) => d.action === 'decline')!;
      expect(decline.enabled).toBe(false);
      expect(decline.visitorMessage).toBe('本日終了');
      expect(decline.isMessageOverridden).toBe(true);
    }
  });

  it('viewer でも読める / 他サイト管理者は読めない', async () => {
    const { svc } = makeService();
    expect((await svc.getView(viewerA, T_A, S_A1)).ok).toBe(true);
    const r = await svc.getView(siteManagerA1, T_A, S_A2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });
});

describe('StaffResponseConfigService.updateAction (#99 inc2)', () => {
  it('有効無効を切り替えて永続化する', async () => {
    const { svc, repo } = makeService();
    const r = await svc.updateAction(tenantAdminA, T_A, S_A1, { action: 'coming', enabled: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.definitions.find((d) => d.action === 'coming')!.enabled).toBe(false);
    const stored = await repo.get(T_A, S_A1);
    expect(stored?.overrides.coming?.enabled).toBe(false);
    expect(stored?.updatedAt).toBe('2026-06-20T00:00:00.000Z');
  });

  it('文言を上書きし、空文字で既定へ戻す', async () => {
    const { svc, repo } = makeService();
    await svc.updateAction(tenantAdminA, T_A, S_A1, { action: 'wait', messageOverride: 'あと少しお待ちを' });
    expect((await repo.get(T_A, S_A1))?.overrides.wait?.messageOverride).toBe('あと少しお待ちを');

    const r = await svc.updateAction(tenantAdminA, T_A, S_A1, { action: 'wait', messageOverride: '' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const wait = r.value.definitions.find((d) => d.action === 'wait')!;
      expect(wait.isMessageOverridden).toBe(false);
      expect(wait.visitorMessage).toBe(getStaffResponseDefinition('wait').defaultVisitorMessage);
    }
    // 上書きが何も残らない種別はレコードから削除される（既定へ戻る）。
    expect((await repo.get(T_A, S_A1))?.overrides.wait).toBeUndefined();
  });

  it('未知の種別 / 長すぎる文言は invalid_input', async () => {
    const { svc } = makeService();
    const bad = await svc.updateAction(tenantAdminA, T_A, S_A1, {
      // @ts-expect-error 不正種別を明示的にテスト
      action: 'nope',
    });
    expect(bad.ok).toBe(false);
    const long = await svc.updateAction(tenantAdminA, T_A, S_A1, {
      action: 'coming',
      messageOverride: 'あ'.repeat(MESSAGE_OVERRIDE_MAX + 1),
    });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.code).toBe('invalid_input');
  });

  it('viewer は書き込めない / 他サイトも書けない', async () => {
    const { svc } = makeService();
    const v = await svc.updateAction(viewerA, T_A, S_A1, { action: 'coming', enabled: false });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe('forbidden');
    const cross = await svc.updateAction(siteManagerA1, T_A, S_A2, { action: 'coming', enabled: false });
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.error.code).toBe('forbidden');
  });
});

describe('StaffResponseConfigService.resolveOverrides (#99 inc2)', () => {
  it('認可なしで overrides を返す / 未保存は空', async () => {
    const { svc } = makeService([
      {
        id: `${T_A}#${S_A1}`,
        tenantId: T_A,
        siteId: S_A1,
        overrides: { coming: { enabled: false } },
        createdAt: '2026-06-19T00:00:00.000Z',
        updatedAt: '2026-06-19T00:00:00.000Z',
      },
    ]);
    expect(await svc.resolveOverrides(T_A, S_A1)).toEqual({ coming: { enabled: false } });
    expect(await svc.resolveOverrides(T_A, S_A2)).toEqual({});
  });
});
