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

/**
 * イベント上限を取次全体で効かせる配線 (#646 スライス 1)。
 *
 * 🔴 **危ないのは配線。** 判定は `hop-event-budget.test.ts` が固定しているが、
 * `applyVoiceEventToCorrelation` が読まなくなっても・書き戻さなくなっても、
 * そちらのテストは全部 green のままになる。
 */
describe('イベント数を取次全体で数える (#646)', () => {
  it('🔴 position へ書き戻す（2 手目の相関が引き継げる）', async () => {
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'ev-1',
    );
    const saved = put.mock.calls[0]?.[0] as StoredCallCorrelation;
    expect(saved.position.eventCount, 'position に載っていない').toBe(1);
  });

  /**
   * 🔴 **ここが本体。** 2 手目は新しい providerCallId＝新レコードなので
   * `correlation.eventCount` は 0 から始まる。position を引き継いでいれば続きから数える。
   * 引き継がずに相関側だけ読むと、上限が hop 数だけ緩む。
   */
  it('🔴 相関側が 0 でも、position の値から続きを数える', async () => {
    await applyVoiceEventToCorrelation(
      correlation({
        eventCount: 0,
        position: { callUuid: 'rec-1', policyId: 'p1', stepId: 's1', hops: 1, ledger: [], eventCount: 40 },
      }),
      { kind: 'status', status: 'unanswered' },
      'ev-2',
    );
    const saved = put.mock.calls[0]?.[0] as StoredCallCorrelation;
    expect(saved.position.eventCount, '通話ごとに数え直している').toBe(41);
  });

  it('🔴 position を持たない旧レコードは相関側の値へ倒す（互換）', async () => {
    await applyVoiceEventToCorrelation(
      correlation({ eventCount: 5 }),
      { kind: 'status', status: 'unanswered' },
      'ev-3',
    );
    const saved = put.mock.calls[0]?.[0] as StoredCallCorrelation;
    expect(saved.position.eventCount).toBe(6);
  });
});

/**
 * 2 手目の実発信の配線 (#646 スライス 2)。
 *
 * `dialNextHop` の中身は `next-hop-dial.test.ts` が固定している。ここが固定するのは
 * **呼ばれるか / 呼ばれた後にどう保存するか**の分岐 ── 発信経路が保存まで済ませたのに
 * 呼び出し側が上書きすると、2 手目の相関が 1 手目の内容で潰れる。
 */
describe('2 手目の発信を配線する (#646)', () => {
  const dialNextHop = vi.fn();
  const listEndpoints = vi.fn();
  const repointReception = vi.fn();

  function deps(over: Record<string, unknown> = {}) {
    return {
      webhookBaseUrl: 'https://example.test',
      resolveInitiator: async () => ({ key: 'vonage', initiate: vi.fn() }),
      listEndpoints,
      repointReception,
      dialNextHop,
      ...over,
    };
  }

  beforeEach(() => {
    dialNextHop.mockResolvedValue({ kind: 'dialed', providerCallId: 'TEST-call-2' });
    listEndpoints.mockResolvedValue([]);
  });

  it('dial 判断のとき、次の手と進んだ位置を渡して発信を試みる', async () => {
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'jti-d1',
      deps(),
    );
    expect(dialNextHop).toHaveBeenCalledTimes(1);
    const arg = dialNextHop.mock.calls[0]?.[0] as { step: { id: string }; next: { position: { stepId: string } } };
    expect(arg.step.id).toBe('s2');
    expect(arg.next.position.stepId).toBe('s2');
  });

  /**
   * 🔴 **撃てたら保存は発信側のもの。** ここで従来どおり保存すると、`dialNextHop` が
   * 書いた「1 手目＝確定済み」を `in_flight` で上書きし、遅れて届く webhook が
   * また 2 手目を撃つ。
   */
  it('🔴 撃てたら呼び出し側は保存しない', async () => {
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'jti-d2',
      deps(),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('🔴 撃てたが引き継ぎが途切れた場合も、呼び出し側は保存しない（撃った事実を消さない）', async () => {
    dialNextHop.mockResolvedValue({ kind: 'handoff_incomplete', providerCallId: 'TEST-call-2' });
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'jti-d3',
      deps(),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('🔴 撃てなかった場合は従来どおり保存する（位置は進めず、台帳は残す）', async () => {
    dialNextHop.mockResolvedValue({ kind: 'not_wired' });
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'jti-d4',
      deps(),
    );
    const saved = put.mock.calls[0]?.[0] as StoredCallCorrelation;
    expect(saved.position.stepId).toBe('s1');
    expect(saved.position.ledger[0]).toContain('jti-d4');
    expect(saved.status).toBe('in_flight');
  });

  it('🔴 発信が失敗しても呼び出し側は上書きしない ── 1 手目は確定済みで、呼出予算が倒す', async () => {
    dialNextHop.mockResolvedValue({ kind: 'dial_failed' });
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'jti-d5',
      deps(),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('🔴 予約に失敗した（＝撃っていない）場合は従来どおり保存する', async () => {
    dialNextHop.mockResolvedValue({ kind: 'reserve_failed' });
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'jti-d6',
      deps(),
    );
    expect(put).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **未指定なら撃たない。** 1 手目と同じ規則（`ExecuteRoutedCallOptions.webhookBaseUrl`）。
   * Function URL を渡すと `x-origin-verify` が付かず全 webhook が 403 になり、
   * 鳴らしたのに一切進まない通話が残る。分からないなら撃たない。
   */
  it('🔴 webhookBaseUrl が未指定なら発信を試みない', async () => {
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'unanswered' },
      'jti-d7',
      deps({ webhookBaseUrl: undefined }),
    );
    expect(dialNextHop).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('dial 以外の判断では発信を試みない', async () => {
    await applyVoiceEventToCorrelation(
      correlation(),
      { kind: 'status', status: 'answered' },
      'jti-d8',
      deps(),
    );
    expect(dialNextHop).not.toHaveBeenCalled();
  });
});
