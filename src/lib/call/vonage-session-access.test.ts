/**
 * Vonage Video セッションの所有テナントの不変条件。
 *
 * **あるセッションに対する Vonage 操作（作成・端末トークン・担当者トークン）は、すべて
 * そのセッションを作ったテナントの設定で行う。** テナントは要求元の入力ではなく、
 * 受付レコードに作成時に記録した値から取る。
 *
 * 後半の通しテストは route を実物で通す（受付・台帳・テナント設定・secret は memory backend）。
 * 外へ出るのは Vonage REST だけなので、そこだけを「どの applicationId の資格情報で呼ばれたか」を
 * 記録する偽物に差し替える。既定テナントと非既定テナントで applicationId を変えてあるので、
 * どこか 1 か所でも既定テナントへ戻せば記録が食い違う。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vonage = vi.hoisted(() => ({
  created: [] as string[],
  issued: [] as Array<{ applicationId: string; sessionId: string; role: string }>,
}));

vi.mock('@/adapters/call/vonage-session', () => ({
  RestVonageSessionService: class {
    constructor(private readonly config: { applicationId: string }) {}
    async createSession(): Promise<{ sessionId: string }> {
      vonage.created.push(this.config.applicationId);
      return { sessionId: `TEST-sess-of-${this.config.applicationId}` };
    }
    async issueToken(session: { sessionId: string }, role: string) {
      vonage.issued.push({ applicationId: this.config.applicationId, sessionId: session.sessionId, role });
      return { token: `TEST-token-${this.config.applicationId}`, role, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    }
  },
}));

let cookieValue: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (cookieValue === undefined ? undefined : { value: cookieValue }) }),
}));

import { asDeviceId, asSiteId, asTenantId } from '@/domain/tenant/types';
import { SecretValue, secretRef } from '@/domain/provider-config/secret';
import { issueKioskSession } from '@/lib/auth/kiosk';
import { issueAnswerToken } from '@/lib/call/answer-token';
import { getTenantStore, __resetTenantStore } from '@/lib/tenant/store';
import { __resetKiosks } from '@/lib/kiosk/kiosk-store';
import { __resetProviderConfigStore, putTenantProviderConfig } from '@/lib/platform/provider-config-store';
import { getTenantSecretStore, __resetTenantSecretStore } from '@/lib/platform/tenant-secret-store';
import {
  __resetStore,
  createReception,
  getReception,
  getReceptionSessionRepository,
} from '@/lib/data-stores/reception-store';
import { DEFAULT_TENANT_ID } from '@/lib/tenant/default-scope';
import type { ReceptionSession } from '@/domain/reception/session';
import { POST as callRoute } from '@/app/api/kiosk/receptions/[id]/call/route';
import { GET as kioskTokenRoute } from '@/app/api/kiosk/receptions/[id]/token/route';
import { POST as staffAnswerRoute } from '@/app/api/staff/calls/[id]/answer/route';
import { resolveVonageSessionAccess, vonageSessionTenantOf } from './vonage-session-access';

const TENANT_B = 'TEST-tenant-vonage-b';
const SITE_B = 'TEST-site-vonage-b';
const APP_DEFAULT = 'TEST-app-default';
const APP_B = 'TEST-app-b';

async function putVonage(tenantId: string, applicationId: string) {
  await putTenantProviderConfig({
    tenantId,
    provider: 'vonage',
    enabled: true,
    applicationId,
    updatedAt: new Date().toISOString(),
    updatedBy: 'TEST',
  });
  await getTenantSecretStore().setSecret(
    secretRef(tenantId, 'vonage'),
    new SecretValue(JSON.stringify({ apiKey: 'TEST-key', apiSecret: 'TEST-secret', privateKey: 'TEST-pem' })),
  );
}

async function putKiosk(id: string, tenant: string, site: string) {
  const nowIso = new Date().toISOString();
  await getTenantStore().devices.putDevice({
    id: asDeviceId(id),
    tenantId: asTenantId(tenant),
    siteId: asSiteId(site),
    name: id,
    status: 'active',
    kind: 'kiosk',
    maintenance: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

async function receptionOf(kioskId: string): Promise<string> {
  const created = await createReception({
    kioskId,
    purpose: 'meeting',
    targetType: 'staff',
    targetId: 'TEST-staff',
    targetLabel: 'TEST',
    visitor: { name: 'TEST' },
  });
  if (!created.ok) throw new Error('fixture');
  return created.value.id;
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function dial(id: string) {
  return callRoute(new Request(`http://localhost/api/kiosk/receptions/${id}/call`, { method: 'POST' }), params(id));
}

async function kioskToken(id: string) {
  return kioskTokenRoute(new Request(`http://localhost/api/kiosk/receptions/${id}/token`), params(id));
}

async function staffAnswer(id: string, token: string) {
  return staffAnswerRoute(
    new Request(`http://localhost/api/staff/calls/${id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
    params(id),
  );
}

beforeEach(async () => {
  vi.stubEnv('CALL_ANSWER_SECRET', 'TEST-answer-secret');
  await __resetTenantStore();
  await __resetKiosks();
  await __resetStore();
  await __resetProviderConfigStore();
  __resetTenantSecretStore();
  vonage.created.length = 0;
  vonage.issued.length = 0;
  cookieValue = undefined;
  await putVonage(DEFAULT_TENANT_ID, APP_DEFAULT);
  await putVonage(TENANT_B, APP_B);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('vonageSessionTenantOf', () => {
  it('作成時に記録したテナントを返す', () => {
    expect(vonageSessionTenantOf({ vonageTenantId: TENANT_B })).toBe(TENANT_B);
  });

  it('記録の無い旧レコードは既定テナント（この項目が入る前は全セッションが既定テナントで作られていた）', () => {
    expect(vonageSessionTenantOf({})).toBe(DEFAULT_TENANT_ID);
  });

  it('記録が壊れている（空・非文字列）なら解決しない（既定テナントへ倒さない）', () => {
    expect(vonageSessionTenantOf({ vonageTenantId: '' })).toBeNull();
    expect(vonageSessionTenantOf({ vonageTenantId: 42 } as unknown as Pick<ReceptionSession, 'vonageTenantId'>)).toBeNull();
  });
});

describe('resolveVonageSessionAccess', () => {
  const reception = { vonageSessionId: 'TEST-sess', vonageTenantId: TENANT_B };

  it('セッションの所有テナントの設定で解決する（要求元のテナントではない）', async () => {
    const access = await resolveVonageSessionAccess(reception, TENANT_B);
    expect(access).toMatchObject({ kind: 'ok', applicationId: APP_B, sessionId: 'TEST-sess' });
  });

  it('要求元のテナントが所有テナントと違えば mismatch（設定を引かない）', async () => {
    expect(await resolveVonageSessionAccess(reception, DEFAULT_TENANT_ID)).toEqual({ kind: 'mismatch' });
    expect(await resolveVonageSessionAccess(reception, undefined)).toEqual({ kind: 'mismatch' });
  });

  it('所有テナントが解決できないレコードは、要求元が誰でも mismatch', async () => {
    const broken = { vonageSessionId: 'TEST-sess', vonageTenantId: '' };
    expect(await resolveVonageSessionAccess(broken, DEFAULT_TENANT_ID)).toEqual({ kind: 'mismatch' });
    expect(await resolveVonageSessionAccess(broken, '')).toEqual({ kind: 'mismatch' });
  });

  it('セッション未確立・所有テナントの Vonage 無効なら unavailable', async () => {
    expect(await resolveVonageSessionAccess({ vonageTenantId: TENANT_B }, TENANT_B)).toEqual({ kind: 'unavailable' });
    await __resetProviderConfigStore();
    expect(await resolveVonageSessionAccess(reception, TENANT_B)).toEqual({ kind: 'unavailable' });
  });
});

describe('通し: 1 つの Vonage セッションの操作はすべて所有テナントの設定で行う', () => {
  it('非既定テナントの端末: 作成・端末トークン・担当者トークンがすべてそのテナントの設定を使う', async () => {
    await putKiosk('TEST-kiosk-b', TENANT_B, SITE_B);
    const id = await receptionOf('TEST-kiosk-b');
    cookieValue = await issueKioskSession('TEST-kiosk-b');

    const called = await dial(id);
    expect(called.status).toBe(200);
    expect(vonage.created).toEqual([APP_B]);
    const stored = await getReception(id);
    expect(stored.ok && stored.value.vonageSessionId).toBe(`TEST-sess-of-${APP_B}`);
    expect(stored.ok && stored.value.vonageTenantId).toBe(TENANT_B);

    const kiosk = await kioskToken(id);
    expect(kiosk.status).toBe(200);
    expect((await kiosk.json()).applicationId).toBe(APP_B);

    const staff = await staffAnswer(id, await issueAnswerToken(id, TENANT_B));
    expect(staff.status).toBe(200);
    expect((await staff.json()).applicationId).toBe(APP_B);

    expect(vonage.issued).toEqual([
      { applicationId: APP_B, sessionId: `TEST-sess-of-${APP_B}`, role: 'publisher' },
      { applicationId: APP_B, sessionId: `TEST-sess-of-${APP_B}`, role: 'subscriber' },
    ]);
  });

  it('既定テナントの端末は従来どおり既定テナントの設定を使う', async () => {
    // 既定サイトには seed の取次ルートがあり、Video セッションを作らない経路へ進む。
    // ここで見たいのは単発 adapter（セッション作成）なので、ルートの無いサイトに置く。
    await putKiosk('TEST-kiosk-default', DEFAULT_TENANT_ID, 'TEST-site-default');
    const id = await receptionOf('TEST-kiosk-default');
    cookieValue = await issueKioskSession('TEST-kiosk-default');

    expect((await dial(id)).status).toBe(200);
    expect((await kioskToken(id)).status).toBe(200);
    expect((await staffAnswer(id, await issueAnswerToken(id, DEFAULT_TENANT_ID))).status).toBe(200);

    expect(vonage.created).toEqual([APP_DEFAULT]);
    expect(vonage.issued.map((i) => i.applicationId)).toEqual([APP_DEFAULT, APP_DEFAULT]);
  });

  it('記録の無い旧レコードは既定テナントの設定でトークンを発行する', async () => {
    await putKiosk('TEST-kiosk-default', DEFAULT_TENANT_ID, 'default-site');
    const id = await receptionOf('TEST-kiosk-default');
    const legacy = await getReception(id);
    if (!legacy.ok) throw new Error('fixture');
    await getReceptionSessionRepository().put({ ...legacy.value, state: 'calling', vonageSessionId: 'TEST-legacy-sess' });
    cookieValue = await issueKioskSession('TEST-kiosk-default');

    expect((await kioskToken(id)).status).toBe(200);
    expect((await staffAnswer(id, await issueAnswerToken(id, DEFAULT_TENANT_ID))).status).toBe(200);
    expect(vonage.issued.map((i) => i.applicationId)).toEqual([APP_DEFAULT, APP_DEFAULT]);
  });

  describe('不一致は fail-closed（トークンを発行しない）', () => {
    async function establishedOnB(): Promise<string> {
      await putKiosk('TEST-kiosk-b', TENANT_B, SITE_B);
      const id = await receptionOf('TEST-kiosk-b');
      cookieValue = await issueKioskSession('TEST-kiosk-b');
      expect((await dial(id)).status).toBe(200);
      return id;
    }

    it('担当者のテナントがセッションと違えば 404（存在しない受付と同じ応答）', async () => {
      const id = await establishedOnB();
      const cross = await staffAnswer(id, await issueAnswerToken(id, DEFAULT_TENANT_ID));
      const missing = await staffAnswer('TEST-missing', await issueAnswerToken('TEST-missing', TENANT_B));
      expect(cross.status).toBe(404);
      expect(await cross.json()).toEqual(await missing.json());
      expect(vonage.issued).toEqual([]);
      // 受付を connected に確定しない。
      const after = await getReception(id);
      expect(after.ok && after.value.state).toBe('calling');
    });

    it('端末が別テナントへ移った後は、作成端末からでも端末トークンを発行しない', async () => {
      const id = await establishedOnB();
      await putKiosk('TEST-kiosk-b', DEFAULT_TENANT_ID, 'default-site');
      const res = await kioskToken(id);
      expect(res.status).toBe(404);
      expect(vonage.issued).toEqual([]);
    });

    it('記録が壊れたセッションには、どちらの側からも発行しない（既定テナントへ倒さない）', async () => {
      const id = await establishedOnB();
      const stored = await getReception(id);
      if (!stored.ok) throw new Error('fixture');
      await getReceptionSessionRepository().put({ ...stored.value, vonageTenantId: '' });
      await putKiosk('TEST-kiosk-b', DEFAULT_TENANT_ID, 'default-site');

      expect((await kioskToken(id)).status).toBe(404);
      expect((await staffAnswer(id, await issueAnswerToken(id, DEFAULT_TENANT_ID))).status).toBe(404);
      expect(vonage.issued).toEqual([]);
    });
  });
});
