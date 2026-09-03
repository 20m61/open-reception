import { describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditAction } from '@/domain/reception/log';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { MemoryContactEndpointRepository, MemoryRoutingPolicyRepository } from './repository';
import { RoutingService } from './service';
import type { StoredContactEndpoint, StoredRoutingPolicy } from './types';
import { VONAGE_RINGING_TIMER_MAX_SECONDS } from '@/domain/routing/voice-initiator';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_A1 = asSiteId('site-a1');

const developer: Actor = {
  status: 'active',
  assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }],
};
const tenantAdminA: Actor = {
  status: 'active',
  assignments: [{ role: 'tenant_admin', tenantId: T_A, siteId: null, deviceId: null }],
};
const viewerA: Actor = {
  status: 'active',
  assignments: [{ role: 'viewer', tenantId: T_A, siteId: null, deviceId: null }],
};
const tenantAdminB: Actor = {
  status: 'active',
  assignments: [{ role: 'tenant_admin', tenantId: T_B, siteId: null, deviceId: null }],
};

function storedEndpoint(
  over: Partial<StoredContactEndpoint> & Pick<StoredContactEndpoint, 'id'>,
): StoredContactEndpoint {
  return {
    ownerType: 'staff',
    ownerId: 'staff-1',
    channel: 'pstn',
    e164: '+81312345678',
    providerKey: 'vonage',
    enabled: true,
    label: '担当者A',
    tenantId: String(T_A),
    siteId: String(S_A1),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as StoredContactEndpoint;
}

function storedPolicy(over: Partial<StoredRoutingPolicy> & Pick<StoredRoutingPolicy, 'id'>): StoredRoutingPolicy {
  return {
    tenantId: String(T_A),
    siteId: String(S_A1),
    name: '標準ルート',
    enabled: true,
    steps: [{ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as StoredRoutingPolicy;
}

function makeService(opts: { endpoints?: StoredContactEndpoint[]; policies?: StoredRoutingPolicy[] } = {}) {
  const audits: Array<{ action: AuditAction; target: { type: string; id?: string }; metadata?: Record<string, string> }> = [];
  const appendAudit = async (
    action: AuditAction,
    target: { type: string; id?: string },
    metadata?: Record<string, string>,
  ) => {
    audits.push({ action, target, metadata });
    return undefined;
  };
  let counter = 0;
  const service = new RoutingService({
    endpoints: new MemoryContactEndpointRepository(opts.endpoints ?? []),
    policies: new MemoryRoutingPolicyRepository(opts.policies ?? []),
    appendAudit,
    now: () => new Date('2026-07-01T00:00:00.000Z'),
    newId: () => `gen-${++counter}`,
  });
  return { service, audits };
}

describe('RoutingService endpoints', () => {
  it('作成: EndpointView を返し、アドレス（e164）を構造的に含めない', async () => {
    const { service, audits } = makeService();
    const r = await service.createEndpoint(tenantAdminA, {
      tenantId: T_A,
      siteId: S_A1,
      raw: { id: 'x', ownerType: 'staff', ownerId: 's1', channel: 'pstn', e164: '+81312349999', providerKey: 'vonage', enabled: true, label: '総務代表' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).not.toHaveProperty('e164');
    expect(r.value).not.toHaveProperty('uri');
    expect(r.value.maskedAddress).toBe('****9999');
    expect(r.value.label).toBe('総務代表');
    // 監査にアドレスが載らない。
    const created = audits.find((a) => a.action === 'contact_endpoint.created');
    expect(created).toBeDefined();
    expect(JSON.stringify(created?.metadata ?? {})).not.toContain('9999');
    expect(JSON.stringify(created?.metadata ?? {})).not.toContain('81312349999');
  });

  it('作成: 不正な e164 は invalid_input', async () => {
    const { service } = makeService();
    const r = await service.createEndpoint(tenantAdminA, {
      tenantId: T_A,
      siteId: S_A1,
      raw: { id: 'x', ownerType: 'staff', ownerId: 's1', channel: 'pstn', e164: '0312345678', providerKey: 'vonage', enabled: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });

  it('作成: viewer は forbidden', async () => {
    const { service } = makeService();
    const r = await service.createEndpoint(viewerA, {
      tenantId: T_A,
      siteId: S_A1,
      raw: { id: 'x', ownerType: 'staff', ownerId: 's1', channel: 'pstn', e164: '+81312349999', providerKey: 'vonage', enabled: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('作成: 他テナント actor は forbidden（越境拒否）', async () => {
    const { service } = makeService();
    const r = await service.createEndpoint(tenantAdminB, {
      tenantId: T_A,
      siteId: S_A1,
      raw: { id: 'x', ownerType: 'staff', ownerId: 's1', channel: 'pstn', e164: '+81312349999', providerKey: 'vonage', enabled: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('一覧: 他テナントの接続先は含めない、maskedAddress のみ露出', async () => {
    const { service } = makeService({
      endpoints: [storedEndpoint({ id: 'ep-1' }), storedEndpoint({ id: 'ep-b', tenantId: String(T_B) })],
    });
    const r = await service.listEndpoints(tenantAdminA, T_A);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((e) => e.id)).toEqual(['ep-1']);
    expect(r.value[0]).not.toHaveProperty('e164');
    expect(r.value[0]?.maskedAddress).toBe('****5678');
  });

  it('更新: アドレス未指定なら既存を保持、label/enabled のみ変更', async () => {
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const r = await service.updateEndpoint(tenantAdminA, T_A, 'ep-1', { label: '新ラベル', enabled: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.label).toBe('新ラベル');
    expect(r.value.enabled).toBe(false);
    expect(r.value.maskedAddress).toBe('****5678');
  });

  it('更新: 他テナント actor は forbidden', async () => {
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const r = await service.updateEndpoint(tenantAdminB, T_A, 'ep-1', { label: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('削除: 監査に残し、越境削除は not_found', async () => {
    const { service, audits } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const cross = await service.removeEndpoint(tenantAdminB, T_A, 'ep-1');
    expect(cross.ok).toBe(false);
    const ok = await service.removeEndpoint(tenantAdminA, T_A, 'ep-1');
    expect(ok.ok).toBe(true);
    expect(audits.some((a) => a.action === 'contact_endpoint.deleted')).toBe(true);
  });
});

describe('RoutingService policies', () => {
  it('作成: 有効なポリシーは PolicyView（description つき）を返し監査に残る', async () => {
    const { service, audits } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1', label: '担当者A' })] });
    const r = await service.createPolicy(tenantAdminA, {
      tenantId: T_A,
      body: { name: 'テストルート', siteId: 'site-a1', enabled: true, steps: [{ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} }] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('gen-1');
    expect(r.value.description[0]).toContain('テストルート');
    expect(r.value.description.some((l) => l.includes('担当者A'))).toBe(true);
    expect(audits.some((a) => a.action === 'routing_policy.created')).toBe(true);
  });

  it('作成: 未登録 endpoint を参照すると invalid_input（unknown_endpoint）', async () => {
    const { service } = makeService();
    const r = await service.createPolicy(tenantAdminA, {
      tenantId: T_A,
      body: { name: 'x', siteId: 'site-a1', enabled: true, steps: [{ id: 's1', endpointId: 'missing', action: 'notify', timeoutSeconds: 20, nextOn: {} }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_input');
      expect(r.error.issues?.some((i) => i.kind === 'unknown_endpoint')).toBe(true);
    }
  });

  /**
   * 🔴 **1 手あたりの上限を設定時に言う (#927)。**
   *
   * `buildCreateCallRequest` は Vonage の `ringing_timer` 上限（120 秒）へ**丸める**ので、
   * 180 秒と設定しても実際には 120 秒で次の手へ進む。ところが文章形式ルートビルダーは
   * 「180秒待つ」と表示する（`domain/routing/describe.ts`）。**表示と挙動が食い違い、
   * 運用者はそれを知る手がかりを持たない。**
   *
   * `exceeds_client_wait` は**合計**しか見ないので、1 手 180 秒（+30s 余裕 = 210s）は
   * 端末上限 300s に収まってしまい、この構成は素通りしていた。
   */
  it('🔴 作成: 1 手が provider 上限を超える構成は invalid_input（step_timeout_exceeds_provider_max）', async () => {
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const r = await service.createPolicy(tenantAdminA, {
      tenantId: T_A,
      body: {
        name: '1 手が長すぎるルート',
        siteId: 'site-a1',
        enabled: true,
        steps: [
          {
            id: 's0',
            endpointId: 'ep-1',
            action: 'notify' as const,
            timeoutSeconds: VONAGE_RINGING_TIMER_MAX_SECONDS + 1,
            nextOn: {},
          },
        ],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_input');
      const issue = r.error.issues?.find((i) => i.kind === 'step_timeout_exceeds_provider_max');
      expect(issue).toBeTruthy();
      // どの手が悪いかを言う（step 別に表示するため）。
      if (issue && issue.kind === 'step_timeout_exceeds_provider_max') {
        expect(issue.stepId).toBe('s0');
        expect(issue.maxSeconds).toBe(VONAGE_RINGING_TIMER_MAX_SECONDS);
      }
    }
  });

  /*
   * 🔴 **下界。** 上限そのものは通さないと、上限いっぱいの設定が保存できなくなる
   * （`buildCreateCallRequest` は 120 をそのまま送る＝丸めが起きない値である）。
   * これが無いと「上限を 1 でも下げる」変異が素通りする。
   */
  it('🔴 下界: 1 手が provider 上限ちょうどなら保存できる', async () => {
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const r = await service.createPolicy(tenantAdminA, {
      tenantId: T_A,
      body: {
        name: '上限ちょうど',
        siteId: 'site-a1',
        enabled: true,
        steps: [
          {
            id: 's0',
            endpointId: 'ep-1',
            action: 'notify' as const,
            timeoutSeconds: VONAGE_RINGING_TIMER_MAX_SECONDS,
            nextOn: {},
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
  });

  /*
   * 🔴 **既存の seed が引き続き通ること。** 上限を厳しくしすぎると、運用中の設定が
   * 保存し直せなくなる。既定値（20/20/30 秒）は上限の内側に居る。
   */
  it('🔴 下界: 既定の待ち時間（20〜30 秒）は引き続き保存できる', async () => {
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const r = await service.createPolicy(tenantAdminA, {
      tenantId: T_A,
      body: {
        name: '既定どおり',
        siteId: 'site-a1',
        enabled: true,
        steps: [20, 20, 30].map((timeoutSeconds, i) => ({
          id: `s${i}`,
          endpointId: 'ep-1',
          action: 'notify' as const,
          timeoutSeconds,
          nextOn: {},
        })),
      },
    });
    expect(r.ok).toBe(true);
  });

  it('作成: 空 step のポリシーは invalid_input（empty_policy）', async () => {
    const { service } = makeService();
    const r = await service.createPolicy(tenantAdminA, {
      tenantId: T_A,
      body: { name: 'x', siteId: 'site-a1', enabled: true, steps: [] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues?.some((i) => i.kind === 'empty_policy')).toBe(true);
  });

  /**
   * 🔴 **端末の待ち上限に収まらない構成を保存させない (#743)。**
   *
   * 収まらないと、来訪者が代替のご案内へ倒れたあとも社内の電話が鳴り続ける
   * （「無人の呼び出し」）。`/give-up` は事後の後始末で、設定の時点で分かるなら
   * ここで止めるほうが安い。
   */
  it('🔴 作成: 端末の待ち上限を超える構成は invalid_input（exceeds_client_wait）', async () => {
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    // 10 手 × (300s + 余裕 30s) = 3300s ≫ 端末上限 300s
    const steps = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      endpointId: 'ep-1',
      action: 'notify' as const,
      timeoutSeconds: 300,
      nextOn: {},
    }));
    const r = await service.createPolicy(tenantAdminA, {
      tenantId: T_A,
      body: { name: '長すぎるルート', siteId: 'site-a1', enabled: true, steps },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_input');
      expect(r.error.issues?.some((i) => i.kind === 'exceeds_client_wait')).toBe(true);
    }
  });

  it('作成: 既定の取次（20 / 20 / 30 秒）は待ち上限に収まるので通る', async () => {
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const steps = [20, 20, 30].map((timeoutSeconds, i) => ({
      id: `s${i}`,
      endpointId: 'ep-1',
      action: 'notify' as const,
      timeoutSeconds,
      nextOn: {},
    }));
    const r = await service.createPolicy(tenantAdminA, {
      tenantId: T_A,
      body: { name: '既定ルート', siteId: 'site-a1', enabled: true, steps },
    });
    expect(r.ok).toBe(true);
  });

  it('更新: 相互 fallback で循環を作ると invalid_input（fallback_cycle）で保存拒否', async () => {
    const p1 = storedPolicy({ id: 'p1', fallbackPolicyId: 'p2' });
    const p2 = storedPolicy({ id: 'p2' });
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })], policies: [p1, p2] });
    // p2 の fallback を p1 にすると p1<->p2 で循環。
    const r = await service.updatePolicy(tenantAdminA, T_A, 'p2', { fallbackPolicyId: 'p1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_input');
      expect(r.error.issues?.some((i) => i.kind === 'fallback_cycle')).toBe(true);
    }
    // 保存されていない（p2 の fallback は元のまま）。
    const got = await service.getPolicy(tenantAdminA, T_A, 'p2');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.fallbackPolicyId).toBeUndefined();
  });

  it('作成: viewer は forbidden、他テナントは forbidden', async () => {
    const { service } = makeService({ endpoints: [storedEndpoint({ id: 'ep-1' })] });
    const asViewer = await service.createPolicy(viewerA, {
      tenantId: T_A,
      body: { name: 'x', siteId: 'site-a1', enabled: true, steps: [{ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} }] },
    });
    expect(asViewer.ok).toBe(false);
    if (!asViewer.ok) expect(asViewer.error.code).toBe('forbidden');

    const asOther = await service.createPolicy(tenantAdminB, {
      tenantId: T_A,
      body: { name: 'x', siteId: 'site-a1', enabled: true, steps: [{ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} }] },
    });
    expect(asOther.ok).toBe(false);
    if (!asOther.ok) expect(asOther.error.code).toBe('forbidden');
  });

  it('一覧: 他テナントのポリシーを含めない', async () => {
    const { service } = makeService({
      endpoints: [storedEndpoint({ id: 'ep-1' })],
      policies: [storedPolicy({ id: 'p-a' }), storedPolicy({ id: 'p-b', tenantId: String(T_B) })],
    });
    const r = await service.listPolicies(tenantAdminA, T_A);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((p) => p.id)).toEqual(['p-a']);
  });

  it('description は policy のサイト scope で label 解決する（別サイトの接続先ラベルを使わない / 第5wave nit）', async () => {
    const epSame = storedEndpoint({ id: 'ep-1', siteId: String(S_A1), label: '同サイト担当' });
    const epOther = storedEndpoint({ id: 'ep-2', siteId: 'site-a2', label: '別サイト担当' });
    const epTenant = storedEndpoint({ id: 'ep-t', siteId: undefined, label: 'テナント共通' });
    const policy = storedPolicy({
      id: 'p1',
      siteId: String(S_A1),
      steps: [
        { id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} },
        { id: 's2', endpointId: 'ep-2', action: 'notify', timeoutSeconds: 20, nextOn: {} },
        { id: 's3', endpointId: 'ep-t', action: 'notify', timeoutSeconds: 20, nextOn: {} },
      ],
    });
    const { service } = makeService({ endpoints: [epSame, epOther, epTenant], policies: [policy] });
    const r = await service.getPolicy(tenantAdminA, T_A, 'p1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.value.description.join('\n');
    expect(text).toContain('同サイト担当'); // 同一サイトは解決する
    expect(text).toContain('テナント共通'); // テナント横断（siteId 未設定）も解決する
    expect(text).not.toContain('別サイト担当'); // 別サイトのラベルは解決しない
  });

  it('developer は横断で読める', async () => {
    const { service } = makeService({
      endpoints: [storedEndpoint({ id: 'ep-1', tenantId: String(T_B) })],
      policies: [storedPolicy({ id: 'p-b', tenantId: String(T_B) })],
    });
    const r = await service.listPolicies(developer, T_B);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((p) => p.id)).toEqual(['p-b']);
  });
});
