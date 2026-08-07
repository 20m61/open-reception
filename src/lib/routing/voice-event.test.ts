/**
 * webhook 1 件の適用と**保存内容** (#4 Inc D-2 / #645)。
 *
 * `advanceFromWebhook` の判断そのものは `webhook-advance.test.ts` が固定している。
 * ここが固定するのは「**判断の結果として何を保存したか**」── 判断が正しくても保存を
 * 取りこぼすと、次の webhook で同じ判断が繰り返される。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutingPolicy } from '@/domain/routing/policy';
import type { StoredCallCorrelation } from './call-correlation';

const put = vi.fn();
const listPolicies = vi.fn();

vi.mock('./call-correlation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./call-correlation')>()),
  getCallCorrelationRepository: () => ({ put, get: vi.fn(), getForTenant: vi.fn() }),
}));
vi.mock('./store', () => ({
  getRoutingRepositories: () => ({
    policies: { list: (...a: unknown[]) => listPolicies(...a) },
    endpoints: { list: vi.fn() },
  }),
}));

import { applyVoiceEventToCorrelation } from './voice-event';

const POLICY: RoutingPolicy = {
  id: 'p1',
  tenantId: 'internal',
  name: 'TEST-policy',
  enabled: true,
  steps: [
    { id: 's1', endpointId: 'e1', action: 'notify', timeoutSeconds: 20, nextOn: {} },
    { id: 's2', endpointId: 'e2', action: 'notify', timeoutSeconds: 20, nextOn: {} },
  ],
};

function correlation(over: Partial<StoredCallCorrelation> = {}): StoredCallCorrelation {
  return {
    providerCallId: 'TEST-call',
    receptionId: 'rec-1',
    tenantId: 'internal',
    siteId: 'default-site',
    position: { callUuid: 'rec-1', policyId: 'p1', stepId: 's1', hops: 0, ledger: [] },
    voiceState: 'queued',
    eventCount: 0,
    status: 'in_flight',
    updatedAt: '2026-08-07T12:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listPolicies.mockResolvedValue([POLICY]);
});

describe('applyVoiceEventToCorrelation — dial 判断のときに保存するもの (#645)', () => {
  it('位置（step / hops）は進めない ── 撃っていない手を撃ったことにしない', async () => {
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'jti-1',
    );
    const saved = put.mock.calls[0]?.[0] as StoredCallCorrelation;
    expect(saved.position.stepId).toBe('s1');
    expect(saved.position.hops).toBe(0);
  });

  it('🔴 ledger は保存する ── 捨てると jti 冪等が効かない (#645)', async () => {
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'jti-1',
    );
    const saved = put.mock.calls[0]?.[0] as StoredCallCorrelation;
    expect(saved.position.ledger).toHaveLength(1);
    expect(saved.position.ledger[0]).toContain('jti-1');
  });

  it('🔴 保存した ledger により、同じ jti の再配信は何も保存しない（duplicate）', async () => {
    // Vonage は at-least-once。ここが効かないと、実発信を配線した瞬間に
    // **同じ担当者へ二重発信**になる。
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'jti-1',
    );
    const saved = put.mock.calls[0]?.[0] as StoredCallCorrelation;
    put.mockClear();

    await applyVoiceEventToCorrelation(saved, { kind: 'status', status: 'unanswered' }, 'jti-1');
    expect(put).not.toHaveBeenCalled();
  });

  it('通話状態とイベント数は進める（保存しないと巻き戻し保護が消える）', async () => {
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'jti-1',
    );
    const saved = put.mock.calls[0]?.[0] as StoredCallCorrelation;
    expect(saved.voiceState).toBe('no_answer');
    expect(saved.eventCount).toBe(1);
    expect(saved.status).toBe('in_flight');
  });

  it('確定済みの相関は何も保存しない', async () => {
    await applyVoiceEventToCorrelation(
      correlation({ voiceState: 'staff_coming', status: 'settled' }),
      { kind: 'status', status: 'completed' },
      'jti-late',
    );
    expect(put).not.toHaveBeenCalled();
  });
});
