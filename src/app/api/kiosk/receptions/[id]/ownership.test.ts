/**
 * 受付 `[id]` の状態遷移 route は、その受付を作成した端末のセッションでしか動かない。
 *
 * route は `receptions/[id]` 配下をファイルシステムから棚卸しし、各 route を
 * 「状態遷移（本ファイルが縛る）」か「その他（既存テストが縛る）」のどちらかへ**必ず**分類させる
 * （足した route が黙って対象外になるのを防ぐ）。
 *
 * 不変条件（状態遷移 route 全部 × 他端末セッション全部）:
 *   - 他端末（別テナント / 同テナント別拠点 / 同拠点別端末）のセッションは 404 で、本文は
 *     存在しない受付への要求と同一（存在を区別させない）。受付は 1 バイトも変わらず、
 *     取次の判定・通話の切断にも到達しない。
 *   - 下界: 作成端末のセッションなら遷移が成功し（2xx・状態が変わる）、取次判定・切断には
 *     **セッションのテナント/拠点**が渡る（既定スコープではない）。
 *
 * 端末・受付は実ストア（memory backend）、トークンは実署名（有効期限は `Date.now()` 起点）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asDeviceId, asSiteId, asTenantId } from '@/domain/tenant/types';
import type { ReceptionState } from '@/domain/reception/state';
import { issueKioskSession } from '@/lib/auth/kiosk';
import { getTenantStore, __resetTenantStore } from '@/lib/tenant/store';
import { __resetKiosks } from '@/lib/kiosk/kiosk-store';
import {
  __resetStore,
  createReception,
  getReception,
  getReceptionSessionRepository,
} from '@/lib/data-stores/reception-store';
import { DEFAULT_SITE_ID, DEFAULT_TENANT_ID } from '@/lib/tenant/default-scope';

let cookieValue: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'kiosk_session' && cookieValue !== undefined ? { value: cookieValue } : undefined,
  }),
  headers: async () => new Headers(),
}));

const evaluateCallGuard = vi.fn();
vi.mock('@/lib/operating-policy/call-guard', () => ({
  evaluateCallGuard: (...a: unknown[]) => evaluateCallGuard(...a),
}));
const hangUpIfRinging = vi.fn();
vi.mock('@/lib/routing/hang-up', () => ({
  hangUpIfRinging: (...a: unknown[]) => hangUpIfRinging(...a),
}));
// 以下は実装を通したまま引数だけ記録する（取次・発信の実挙動は memory backend の既定 = mock）。
const executeRoutedCall = vi.hoisted(() => vi.fn());
vi.mock('@/lib/routing/call-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/routing/call-execution')>();
  executeRoutedCall.mockImplementation(actual.executeRoutedCall);
  return { ...actual, executeRoutedCall: (...a: unknown[]) => executeRoutedCall(...a) };
});
const intendsRealDialing = vi.hoisted(() => vi.fn());
vi.mock('@/lib/platform/provider-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/provider-resolution')>();
  intendsRealDialing.mockImplementation(actual.intendsRealDialing);
  return { ...actual, intendsRealDialing: (...a: unknown[]) => intendsRealDialing(...a) };
});
const startCall = vi.hoisted(() => vi.fn());
vi.mock('@/lib/data-stores/reception-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data-stores/reception-store')>();
  startCall.mockImplementation(actual.startCall);
  return { ...actual, startCall: (...a: unknown[]) => startCall(...a) };
});

type Scope = { tenantId?: unknown; siteId?: unknown };
/**
 * セッションのスコープを受け取る関数と、その呼び出し引数からスコープを取り出す方法。
 * どの関数がここに要るかは下の「呼び出しグラフ」テストが route のソースから機械的に決める
 * （ここへ載っていない関数にセッションのスコープを渡す route があれば落ちる）。
 */
const SCOPE_CONSUMERS: Record<string, { spy: ReturnType<typeof vi.fn>; scope: (a: unknown[]) => Scope }> = {
  evaluateCallGuard: { spy: evaluateCallGuard, scope: (a) => ({ tenantId: a[0], siteId: a[1] }) },
  intendsRealDialing: { spy: intendsRealDialing, scope: (a) => ({ tenantId: a[0] }) },
  executeRoutedCall: {
    spy: executeRoutedCall,
    scope: (a) => {
      const s = a[0] as Scope;
      return { tenantId: s.tenantId, siteId: s.siteId };
    },
  },
  startCall: { spy: startCall, scope: (a) => ({ tenantId: a[2] }) },
  hangUpIfRinging: { spy: hangUpIfRinging, scope: (a) => ({ tenantId: a[0] }) },
};
/** 値の変換・ログだけでスコープを外へ渡さない呼び出し。 */
const PURE_CALLEES = new Set(['String', 'JSON.stringify', 'console.error', 'console.warn', 'console.info']);

/**
 * route のソースから、**セッション由来の値（`.session` / `scope`）を引数に含む呼び出し**の
 * callee を全部取り出す。入れ子は外側も内側も数える（`f(String(scope.tenantId))` は f と String）。
 */
function scopeConsumersOf(route: string): Set<string> {
  const file = path.join(ID_ROOT, route, 'route.ts');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const derived = new Set<string>(['scope']);
  const found = new Set<string>();
  // throughCalls=false: 呼び出しの戻り値はセッションのスコープそのものではないので追わない
  // （`const guard = await evaluateCallGuard(scope...)` の guard はスコープではない）。
  const mentionsSession = (node: ts.Node, throughCalls = true): boolean => {
    let hit = false;
    const visit = (n: ts.Node) => {
      if (!throughCalls && ts.isCallExpression(n)) return;
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'session') hit = true;
      if (ts.isIdentifier(n) && derived.has(n.text) && !ts.isPropertyAccessExpression(n.parent)) hit = true;
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && derived.has(n.expression.text)) {
        hit = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return hit;
  };
  const walk = (n: ts.Node) => {
    // セッション由来の値を束縛した変数も追う（`const scope = {...owned.session...}` 等）。
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && mentionsSession(n.initializer, false)) {
      derived.add(n.name.text);
    }
    if (ts.isCallExpression(n) && n.arguments.some((a) => mentionsSession(a))) {
      found.add(n.expression.getText(sf));
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  for (const p of PURE_CALLEES) found.delete(p);
  return found;
}

/** 状態遷移 route と、作成端末が遷移に成功できる開始状態。 */
const TRANSITIONS: Record<string, ReceptionState> = {
  call: 'confirming',
  cancel: 'calling',
  complete: 'connected',
  connected: 'calling',
  fallback: 'timeout',
  'give-up': 'calling',
  timeout: 'calling',
};
/** 状態遷移ではない route（所有権は各 route の既存テストが縛る）。 */
const NON_TRANSITIONS = new Set(['feedback', 'status', 'token']);

const ID_ROOT = __dirname;
const ROUTES = readdirSync(ID_ROOT)
  .filter((name) => statSync(path.join(ID_ROOT, name)).isDirectory())
  .filter((name) => {
    try {
      return statSync(path.join(ID_ROOT, name, 'route.ts')).isFile();
    } catch {
      return false;
    }
  })
  .sort();

const OWNER = { kioskId: 'TEST-owner', tenantId: 'TEST-tenant-a', siteId: 'TEST-site-a1' };
const FOREIGN = [
  { label: '別テナント', kioskId: 'TEST-tenant-b-kiosk', tenantId: 'TEST-tenant-b', siteId: 'TEST-site-b1' },
  { label: '同テナント別拠点', kioskId: 'TEST-site-a2-kiosk', tenantId: 'TEST-tenant-a', siteId: 'TEST-site-a2' },
  { label: '同拠点別端末', kioskId: 'TEST-site-a1-other', tenantId: 'TEST-tenant-a', siteId: 'TEST-site-a1' },
];

async function putDevice(d: { kioskId: string; tenantId: string; siteId: string }) {
  const nowIso = new Date().toISOString();
  await getTenantStore().devices.putDevice({
    id: asDeviceId(d.kioskId),
    tenantId: asTenantId(d.tenantId),
    siteId: asSiteId(d.siteId),
    name: d.kioskId,
    status: 'active',
    kind: 'kiosk',
    maintenance: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

async function ownedReception(state: ReceptionState): Promise<string> {
  const created = await createReception({
    kioskId: OWNER.kioskId,
    purpose: 'meeting',
    targetType: 'staff',
    targetId: 'TEST-staff',
    targetLabel: 'TEST',
    visitor: { name: 'TEST' },
  });
  if (!created.ok) throw new Error('fixture');
  await getReceptionSessionRepository().put({ ...created.value, state, providerCallId: 'TEST-call' });
  return created.value.id;
}

async function post(route: string, id: string): Promise<Response> {
  const mod = (await import(`./${route}/route`)) as {
    POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  return mod.POST(new Request(`http://localhost/api/kiosk/receptions/${id}/${route}`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(async () => {
  for (const c of [evaluateCallGuard, hangUpIfRinging, executeRoutedCall, intendsRealDialing, startCall]) {
    c.mockClear();
  }
  evaluateCallGuard.mockResolvedValue({ allowed: true });
  hangUpIfRinging.mockResolvedValue({ kind: 'terminated' });
  await __resetTenantStore();
  await __resetKiosks();
  await __resetStore();
  cookieValue = undefined;
  for (const d of [OWNER, ...FOREIGN]) await putDevice(d);
});

describe('receptions/[id] の棚卸し', () => {
  it('全 route がどちらかへ分類されている', () => {
    for (const r of ROUTES) {
      expect(r in TRANSITIONS || NON_TRANSITIONS.has(r), `未分類の route: ${r}`).toBe(true);
    }
    for (const r of Object.keys(TRANSITIONS)) expect(ROUTES).toContain(r);
  });

  it('fixture のスコープは既定スコープと異なる（既定へ倒す実装と区別するため）', () => {
    expect(OWNER.tenantId).not.toBe(DEFAULT_TENANT_ID);
    expect(OWNER.siteId).not.toBe(DEFAULT_SITE_ID);
  });
});

describe.each(Object.entries(TRANSITIONS))('POST receptions/[id]/%s', (route, startState) => {
  it.each(FOREIGN)('$label のセッションでは 404・受付不変・副作用なし', async (foreign) => {
    const id = await ownedReception(startState);
    const before = await getReception(id);
    cookieValue = await issueKioskSession(foreign.kioskId);

    const res = await post(route, id);
    const missing = await post(route, 'TEST-missing-reception');

    expect(res.status).toBe(404);
    expect(missing.status).toBe(404);
    expect([...res.headers]).toEqual([...missing.headers]);
    expect(await res.json()).toEqual(await missing.json());
    expect(await getReception(id)).toEqual(before);
    for (const [name, c] of Object.entries(SCOPE_CONSUMERS)) {
      expect(c.spy, `${name} に到達した`).not.toHaveBeenCalled();
    }
  });

  it('作成端末のセッションなら遷移し、セッションのスコープで判定・切断する', async () => {
    const id = await ownedReception(startState);
    cookieValue = await issueKioskSession(OWNER.kioskId);

    const res = await post(route, id);

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const after = await getReception(id);
    expect(after.ok && after.value.state).not.toBe(startState);
    // 呼び出しグラフから導いた「セッションのスコープを受け取る関数」は全部呼ばれ、
    // 全部がセッションのテナント/拠点を受け取る（既定スコープではない）。
    for (const name of scopeConsumersOf(route)) {
      const c = SCOPE_CONSUMERS[name]!;
      expect(c.spy, `${name} が呼ばれていない`).toHaveBeenCalled();
      for (const args of c.spy.mock.calls) {
        const got = c.scope(args);
        expect(String(got.tenantId), `${name} の tenant`).toBe(OWNER.tenantId);
        if ('siteId' in got) expect(String(got.siteId), `${name} の site`).toBe(OWNER.siteId);
      }
    }
    // 切断対象は所有を確かめた受付の通話（取り違えると他人の通話を切る）。
    for (const args of hangUpIfRinging.mock.calls) expect(args[1]).toBe('TEST-call');
  });
});

describe('遷移 route の呼び出しグラフ', () => {
  it.each(Object.keys(TRANSITIONS))('%s: セッションのスコープを渡す先は全部が縛られている', (route) => {
    for (const name of scopeConsumersOf(route)) {
      expect(SCOPE_CONSUMERS, `${route} が ${name} へセッションのスコープを渡すのに縛られていない`).toHaveProperty(
        [name],
      );
    }
  });

  it('下界: 抽出は call / cancel / give-up のスコープ消費を拾う（抽出が空振りしていない）', () => {
    expect([...scopeConsumersOf('call')].sort()).toEqual(
      ['evaluateCallGuard', 'executeRoutedCall', 'intendsRealDialing', 'startCall'].sort(),
    );
    expect([...scopeConsumersOf('cancel')]).toEqual(['hangUpIfRinging']);
    expect([...scopeConsumersOf('give-up')]).toEqual(['hangUpIfRinging']);
  });

  it('遷移 route は既定スコープを参照しない', () => {
    for (const route of Object.keys(TRANSITIONS)) {
      const src = readFileSync(path.join(ID_ROOT, route, 'route.ts'), 'utf8');
      expect(src, route).not.toMatch(/resolveDefaultScope|DEFAULT_TENANT_ID|DEFAULT_SITE_ID|default-scope/);
    }
  });
});
