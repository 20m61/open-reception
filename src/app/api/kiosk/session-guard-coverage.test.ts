/**
 * kiosk セッションを読む全 route の網羅（共通ガード `@/lib/kiosk/session-guard`）。
 *
 * route は**ファイルシステムから機械的に棚卸しする**（手書きの一覧にしない — 足した route が
 * 黙って対象外になるため）。棚卸しした全 route の全 HTTP メソッドを実物（memory backend）で
 * 叩き、次を縛る:
 *
 *   I1. 失効端末の署名済み cookie を持つ要求は、cookie を持たない要求と**同じ応答**になる
 *       （= 失効セッションはどの route でもセッションとして扱われない）。
 *   I2. 下界: 共通ガードを import している route は、有効端末の cookie で**応答が変わる**
 *       （fixture が実際に認証を通していること。通っていなければ I1 は空虚に満たせる）。
 *   I3. cookie を直接読むのは発行側と heartbeat だけ（それ以外は共通ガード経由）。
 *
 * 時刻は `Date.now()` 起点（トークンは実署名、端末・受付は実ストアに作る）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asDeviceId, asSiteId, asTenantId, type Device } from '@/domain/tenant/types';
import { issueKioskSession } from '@/lib/auth/kiosk';
import { getTenantStore, __resetTenantStore } from '@/lib/tenant/store';
import { __resetKiosks } from '@/lib/kiosk/kiosk-store';
import { __resetStore, createReception } from '@/lib/data-stores/reception-store';

let cookieValue: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'kiosk_session' && cookieValue !== undefined ? { value: cookieValue } : undefined,
  }),
  headers: async () => new Headers(),
}));

const API_ROOT = path.resolve(__dirname, '..');
const KIOSK_ROOT = path.join(API_ROOT, 'kiosk');
/** kiosk セッションを読む route は /api/kiosk 配下に加えてこれだけ（構成配信）。 */
const EXTRA_ROUTES = [path.join(API_ROOT, 'configuration', 'effective', 'route.ts')];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name === 'route.ts' ? [full] : [];
  });
}

const ROUTE_FILES = [...walk(KIOSK_ROOT), ...EXTRA_ROUTES].sort();
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const rel = (file: string) => path.relative(API_ROOT, file);
const source = (file: string) => readFileSync(file, 'utf8');

/** 共通ガード（または委譲ラッパ）を import している route。 */
const GUARD_IMPORT =
  /from '@\/lib\/(kiosk\/session-guard|checkin\/request|visit\/request)'/;
const usesGuard = (file: string) => {
  const src = source(file);
  return (
    GUARD_IMPORT.test(src) &&
    /requireKioskSession|denyWithoutKioskSession|requireOwnedReception|resolveKioskSessionToken/.test(src)
  );
};

/**
 * cookie を直接読んでよい route（それぞれ理由付き）:
 *   - authorize / enroll: セッションを**発行する**側。
 *   - heartbeat: 旧レジストリのみの端末を Device へ取り込むため、署名だけで端末を識別する。
 *     応答の `authorized` は共通ガードで判定する（下の個別テストが縛る）。
 */
const DIRECT_COOKIE_ALLOWED = new Set(['kiosk/authorize/route.ts', 'kiosk/enroll/route.ts', 'kiosk/heartbeat/route.ts']);

/**
 * 有効なセッションでも応答が変わらない（= 下界 I2 を主張できない）route。
 * セッションが無くても既定テナントの公開アセットを返す route で、fixture の端末が
 * 何も持たないため有効/無しで同じ応答になる。挙動の変更は本増分の対象外。
 */
const SESSION_OPTIONAL = new Set(['kiosk/assets/route.ts', 'kiosk/motions/route.ts', 'kiosk/voice/route.ts']);

const TENANT = 'TEST-tenant-coverage';
const SITE = 'TEST-site-coverage';

async function putDevice(id: string, status: Device['status']) {
  const nowIso = new Date().toISOString();
  await getTenantStore().devices.putDevice({
    id: asDeviceId(id),
    tenantId: asTenantId(TENANT),
    siteId: asSiteId(SITE),
    name: id,
    status,
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

/** 時刻・乱数など、要求ごとに変わる値を落として比較する。 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !['serverTime', 'generatedAt', 'requestId', 'id'].includes(k))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

type Observed = { status: number; body: unknown };

async function invoke(file: string, method: string, kioskForReception: string): Promise<Observed> {
  const mod = (await import(file)) as Record<string, unknown>;
  const handler = mod[method] as (req: Request, ctx: unknown) => Promise<Response>;
  const id = await receptionOf(kioskForReception);
  const url = `http://localhost/api/${rel(file).replace(/\/route\.ts$/, '').replace('[id]', id)}`;
  const init: RequestInit =
    method === 'GET'
      ? { method }
      : { method, body: JSON.stringify({ receptionSessionId: id }), headers: { 'content-type': 'application/json' } };
  let res: Response;
  try {
    res = await handler(new Request(url, init), { params: Promise.resolve({ id }) });
  } catch (err) {
    return { status: -1, body: err instanceof Error ? err.name : 'throw' };
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 非 JSON はそのまま比較する。
  }
  return { status: res.status, body: normalize(body) };
}

const CASES = ROUTE_FILES.flatMap((file) => {
  const exported = METHODS.filter((m) => new RegExp(`export (async )?function ${m}\\b|export const ${m}\\b`).test(source(file)));
  return exported.map((method) => ({ file, method, name: `${method} ${rel(file)}` }));
});

beforeEach(async () => {
  await __resetTenantStore();
  await __resetKiosks();
  await __resetStore();
  cookieValue = undefined;
  await putDevice('TEST-active', 'active');
  await putDevice('TEST-revoked', 'revoked');
});

describe('route の棚卸し', () => {
  it('棚卸しが空でなく、受付の状態遷移 7 route を含む', () => {
    const names = ROUTE_FILES.map(rel);
    for (const r of ['call', 'cancel', 'complete', 'connected', 'fallback', 'give-up', 'timeout']) {
      expect(names).toContain(`kiosk/receptions/[id]/${r}/route.ts`);
    }
    // 例外リストが実在する route を指していること（改名で例外が空振りしないように）。
    for (const r of [...DIRECT_COOKIE_ALLOWED, ...SESSION_OPTIONAL]) expect(names).toContain(r);
  });

  it.each(ROUTE_FILES.map((f) => [rel(f), f]))('I3: %s は cookie を直接読まない（共通ガード経由）', (name, file) => {
    if (DIRECT_COOKIE_ALLOWED.has(name)) return;
    expect(source(file)).not.toMatch(/readKioskSession|KIOSK_COOKIE/);
  });
});

describe.each(CASES)('$name', ({ file, method }) => {
  const name = rel(file);

  it('I1: 失効端末の cookie は cookie 無しと同じ応答になる', async () => {
    if (name === 'kiosk/heartbeat/route.ts') return; // 下の個別テスト（応答に端末の有効性が出るため）
    cookieValue = undefined;
    const none = await invoke(file, method, 'TEST-active');
    await __resetStore();
    cookieValue = await issueKioskSession('TEST-revoked');
    const revoked = await invoke(file, method, 'TEST-revoked');
    expect(revoked).toEqual(none);
  });

  it('I2: 共通ガードを使う route は、有効端末の cookie で応答が変わる（下界）', async () => {
    if (!usesGuard(file) || SESSION_OPTIONAL.has(name)) return;
    cookieValue = undefined;
    const none = await invoke(file, method, 'TEST-active');
    await __resetStore();
    cookieValue = await issueKioskSession('TEST-active');
    const active = await invoke(file, method, 'TEST-active');
    expect(active).not.toEqual(none);
  });
});

describe('heartbeat', () => {
  it('失効端末の cookie では authorized=false・active=false を返す', async () => {
    const { GET } = await import('./heartbeat/route');
    cookieValue = await issueKioskSession('TEST-revoked');
    const body = (await (await GET(new Request('http://localhost/api/kiosk/heartbeat'))).json()) as {
      authorized: boolean;
      active: boolean;
    };
    expect(body.authorized).toBe(false);
    expect(body.active).toBe(false);
  });

  it('有効端末の cookie では authorized=true（下界）', async () => {
    const { GET } = await import('./heartbeat/route');
    cookieValue = await issueKioskSession('TEST-active');
    const body = (await (await GET(new Request('http://localhost/api/kiosk/heartbeat'))).json()) as {
      authorized: boolean;
    };
    expect(body.authorized).toBe(true);
  });
});
