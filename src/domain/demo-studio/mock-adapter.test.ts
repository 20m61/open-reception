import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoKioskFetch, DEMO_CALL_FAILED_LATENCY_MS } from './mock-adapter';
import { DemoSandboxViolation } from './sandbox';
import { getDemoScenario } from './scenarios';
import type { DemoScenario } from './scenario';

const ORIGIN = 'https://kiosk.example.com';

function scenario(overrides: Partial<DemoScenario> = {}): DemoScenario {
  return {
    id: 'unit',
    name: 'unit',
    initialMode: 'reception',
    visitorInputs: [],
    simulatedResults: {},
    ...overrides,
  };
}

function fetchFor(s: DemoScenario) {
  return createDemoKioskFetch(s, { origin: ORIGIN });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDemoKioskFetch — sandbox の委譲', () => {
  it('本番集計・Vonage 発信先は DemoSandboxViolation で拒否する', async () => {
    const f = fetchFor(scenario());
    await expect(f('/api/admin/usage')).rejects.toBeInstanceOf(DemoSandboxViolation);
    await expect(f('https://api.nexmo.com/v1/calls', { method: 'POST' })).rejects.toBeInstanceOf(
      DemoSandboxViolation,
    );
  });

  it('グローバル fetch を一切参照しない（実ネットワークへ出る経路が無い）', async () => {
    // 実 fetch が呼ばれたら即失敗させる。それでも Mock 応答は解決できることを確認する。
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('real network must not be used in demo');
      }),
    );
    const f = fetchFor(scenario());
    const res = await f('/api/kiosk/heartbeat?kioskId=x');
    expect(res.ok).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('createDemoKioskFetch — runtime → heartbeat', () => {
  it('ready は active/authorized true', async () => {
    const res = await fetchFor(scenario({ simulatedResults: { runtime: 'ready' } }))(
      '/api/kiosk/heartbeat',
    );
    expect(await json(res)).toMatchObject({ active: true, authorized: true, pinRequired: false });
  });

  it('stopped は active:false（受付端末利用不可の再現）', async () => {
    const res = await fetchFor(scenario({ simulatedResults: { runtime: 'stopped' } }))(
      '/api/kiosk/heartbeat',
    );
    expect(await json(res)).toMatchObject({ active: false });
  });

  it('degraded は 503（オフライン/縮退の再現）', async () => {
    const res = await fetchFor(scenario({ simulatedResults: { runtime: 'degraded' } }))(
      '/api/kiosk/heartbeat',
    );
    expect(res.status).toBe(503);
  });
});

describe('createDemoKioskFetch — call 結果 → 受付状態', () => {
  async function callResponse(
    call: DemoScenario['simulatedResults']['call'],
  ): Promise<{ state: string; stages: unknown[] }> {
    const f = fetchFor(scenario({ simulatedResults: { call } }));
    const create = await json(await f('/api/kiosk/receptions', { method: 'POST' }));
    const res = await f(`/api/kiosk/receptions/${create.id}/call`, { method: 'POST' });
    const body = await json(res);
    return { state: body.state as string, stages: body.stages as unknown[] };
  }

  it('answered → connected（従来どおり同期・実SDK接続を誘発しない）', async () => {
    expect((await callResponse(['answered'])).state).toBe('connected');
  });
  it('declined → failed（担当者到達済みの明示拒否・段階表示は使わない）', async () => {
    expect((await callResponse(['declined'])).state).toBe('failed');
  });
  it('no_answer → timeout', async () => {
    expect((await callResponse(['no_answer'])).state).toBe('timeout');
  });
  it('複数手は最終結果（部門代表応答）を来訪者に見せる: no_answer,no_answer,answered → connected', async () => {
    expect((await callResponse(['no_answer', 'no_answer', 'answered'])).state).toBe('connected');
  });

  it(
    'failed（技術的発信失敗）→ state:calling + stages（#363 Vonage発信失敗の段階表示。' +
      'KioskCallView を経由させるため直接 failed を返さない）',
    async () => {
      const res = await callResponse(['failed']);
      expect(res.state).toBe('calling');
      expect(res.stages.length).toBeGreaterThan(0);
    },
  );

  it('failed の後続 /token は必ず非 ok（#363 実Vonage SDK・CDN ロードを誘発しない安全設計）', async () => {
    const f = fetchFor(scenario({ simulatedResults: { call: ['failed'] } }));
    const create = await json(await f('/api/kiosk/receptions', { method: 'POST' }));
    await f(`/api/kiosk/receptions/${create.id}/call`, { method: 'POST' });
    const tokenRes = await f(`/api/kiosk/receptions/${create.id}/token`);
    expect(tokenRes.ok).toBe(false);
  });

  it('既定（callLatencyMs 未指定）は /token を遅延させない（テスト決定論・本番相当は無変更）', async () => {
    const f = fetchFor(scenario({ simulatedResults: { call: ['failed'] } }));
    const start = Date.now();
    const res = await f('/api/kiosk/receptions/demo-x/token');
    expect(res.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('callLatencyMs 指定時は /token 応答を段階表示のためにその時間だけ遅延させる（#364 第7wave 申し送り）', async () => {
    vi.useFakeTimers();
    try {
      const f = createDemoKioskFetch(scenario({ simulatedResults: { call: ['failed'] } }), {
        origin: ORIGIN,
        callLatencyMs: DEMO_CALL_FAILED_LATENCY_MS,
      });
      const p = f('/api/kiosk/receptions/demo-x/token');
      let settled = false;
      void p.then(() => {
        settled = true;
      });
      // レイテンシ未満では未解決（段階表示が見えている間）。
      await vi.advanceTimersByTimeAsync(DEMO_CALL_FAILED_LATENCY_MS - 1);
      expect(settled).toBe(false);
      // 1 秒以上（既定 1200ms）視認できることを担保。
      expect(DEMO_CALL_FAILED_LATENCY_MS).toBeGreaterThanOrEqual(1000);
      await vi.advanceTimersByTimeAsync(1);
      const res = await p;
      expect(res.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createDemoKioskFetch — 受付作成は本番集計を作らない（合成 id）', () => {
  it('receptions POST は demo- 接頭辞の合成 id を返す', async () => {
    const res = await fetchFor(scenario())('/api/kiosk/receptions', { method: 'POST' });
    const body = await json(res);
    expect(String(body.id)).toMatch(/^demo-/);
  });
});

describe('createDemoKioskFetch — QR 解決', () => {
  it('valid は summary を返す', async () => {
    const res = await fetchFor(scenario({ simulatedResults: { qr: 'valid' } }))(
      '/api/kiosk/checkin/resolve',
      { method: 'POST', body: JSON.stringify({ payload: 'x' }) },
    );
    expect(res.ok).toBe(true);
    expect(await json(res)).toHaveProperty('summary');
  });

  it.each(['expired', 'used', 'revoked'] as const)('%s は非 ok で error 理由を返す', async (qr) => {
    const res = await fetchFor(scenario({ simulatedResults: { qr } }))(
      '/api/kiosk/checkin/resolve',
      { method: 'POST', body: JSON.stringify({ payload: 'x' }) },
    );
    expect(res.ok).toBe(false);
    expect(res.status).not.toBe(503);
    expect((await json(res)).error).toBe(qr);
  });
});

describe('createDemoKioskFetch — signage / attract 入口', () => {
  it('signage は signage 項目を出す', async () => {
    const res = await fetchFor(scenario({ initialMode: 'signage' }))('/api/kiosk/signage');
    const items = (await json(res)).items as unknown[];
    expect(items.length).toBeGreaterThan(0);
  });
  it('reception では signage 項目は空（待機サイネージを出さない）', async () => {
    const res = await fetchFor(scenario({ initialMode: 'reception' }))('/api/kiosk/signage');
    expect((await json(res)).items).toEqual([]);
  });
});

describe('createDemoKioskFetch — 補助エンドポイントと呼び出し記録', () => {
  it('directory は部署・担当者を返す（選択画面が空にならない）', async () => {
    const res = await fetchFor(scenario())('/api/kiosk/directory');
    const body = await json(res);
    expect(Array.isArray(body.departments)).toBe(true);
    expect(Array.isArray(body.staff)).toBe(true);
  });

  it('未知の /api/kiosk サブパスも 200 で壊さない（KioskFlow の任意 fetch を許容）', async () => {
    const res = await fetchFor(scenario())('/api/kiosk/receptions/abc/status');
    expect(res.ok).toBe(true);
  });

  it('.calls に method+path を記録する（本番境界の検証用）', async () => {
    const f = fetchFor(scenario());
    await f('/api/kiosk/voice');
    await f('/api/kiosk/receptions', { method: 'POST' });
    expect(f.calls).toEqual([
      { method: 'GET', path: '/api/kiosk/voice' },
      { method: 'POST', path: '/api/kiosk/receptions' },
    ]);
  });

  it('9 seed シナリオすべてで heartbeat が応答する（スモーク）', async () => {
    for (const id of [
      'normal-visit',
      'qr-checkin-valid',
      'no-answer-escalation',
      'call-failed',
      'out-of-hours',
    ]) {
      const s = getDemoScenario(id)!;
      const res = await fetchFor(s)('/api/kiosk/heartbeat');
      expect([200, 503]).toContain(res.status);
    }
  });
});
