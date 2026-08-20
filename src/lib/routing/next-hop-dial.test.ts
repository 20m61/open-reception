/**
 * 2 手目以降の実発信 (#646 スライス 2)。
 *
 * ここが固定するのは**順序と後始末**。「撃てたか」だけを見るテストでは、
 * 二重発信・迷子の受付・引き継がれない上限を一つも捕まえられない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutingStep } from '@/domain/routing/policy';
import type { CallProgress } from '@/domain/routing/webhook-advance';
import type { StoredCallCorrelation } from './call-correlation';
import { dialNextHop } from './next-hop-dial';
import type { StoredContactEndpoint } from './types';

const STEP: RoutingStep = {
  id: 's2',
  endpointId: 'e2',
  action: 'notify',
  timeoutSeconds: 20,
  nextOn: {},
};

const ENDPOINT: StoredContactEndpoint = {
  id: 'e2',
  tenantId: 'internal',
  ownerType: 'organization',
  ownerId: 'g1',
  providerKey: 'vonage',
  label: 'TEST-daihyo',
  channel: 'pstn',
  // テストに実在しうる番号を置かない（gitleaks 誤検知・実番号混入の防止）。
  e164: '+815000000002',
  enabled: true,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
};

function correlation(over: Partial<StoredCallCorrelation> = {}): StoredCallCorrelation {
  return {
    providerCallId: 'TEST-call-1',
    receptionId: 'rec-1',
    tenantId: 'internal',
    siteId: 'default-site',
    position: { callUuid: 'rec-1', policyId: 'p1', stepId: 's1', hops: 0, ledger: ['k0'], eventCount: 3 },
    voiceState: 'ringing',
    eventCount: 3,
    status: 'in_flight',
    dialExpiresAt: '2026-08-20T00:00:50.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

/** dial 判断の `next`。位置は既に 2 手目へ進んでいる。 */
function nextProgress(): CallProgress {
  return {
    position: { callUuid: 'rec-1', policyId: 'p1', stepId: 's2', hops: 1, ledger: ['k0', 'k1'] },
    voiceState: 'no_answer',
    settled: false,
    eventCount: 4,
  };
}

const save = vi.fn();
const repoint = vi.fn();
const initiate = vi.fn();
const order: string[] = [];

function deps(over: Partial<Parameters<typeof dialNextHop>[0]> = {}) {
  return {
    correlation: correlation(),
    next: nextProgress(),
    step: STEP,
    endpoints: [ENDPOINT],
    initiator: { key: 'vonage', initiate },
    saveCorrelation: save,
    repointReception: repoint,
    now: () => new Date('2026-08-20T00:01:00.000Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  save.mockImplementation(async (c: StoredCallCorrelation) => {
    order.push(`save:${c.providerCallId}:${c.status}`);
  });
  repoint.mockImplementation(async () => void order.push('repoint'));
  initiate.mockImplementation(async () => {
    order.push('initiate');
    return { providerCallId: 'TEST-call-2' };
  });
});

describe('dialNextHop — 撃たない条件', () => {
  it('発信者が居ない（停止スイッチ / 未設定）なら撃たず、保存もしない', async () => {
    const result = await dialNextHop(deps({ initiator: null }));
    expect(result.kind).toBe('not_wired');
    expect(initiate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(repoint).not.toHaveBeenCalled();
  });

  it('🔴 接続先が無効なら撃たない ── 握り潰して撃つと誤った宛先へ繋がる', async () => {
    const result = await dialNextHop(deps({ endpoints: [{ ...ENDPOINT, enabled: false }] }));
    expect(result.kind).toBe('endpoint_unavailable');
    expect(initiate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('接続先が引けなければ撃たない', async () => {
    const result = await dialNextHop(deps({ endpoints: [] }));
    expect(result.kind).toBe('endpoint_unavailable');
    expect(initiate).not.toHaveBeenCalled();
  });
});

describe('dialNextHop — 冪等（順序）', () => {
  /**
   * 🔴 **ここが本体。** 発信してから台帳を書くと、同一 `jti` の再配信が発信の**最中**に
   * 届いたときに二重発信になる（担当者の電話が 2 本鳴る）。先に台帳を確定させれば、
   * 再配信は `duplicate` として弾かれる。撃ち損ねは呼出予算が timeout へ倒す。
   */
  it('🔴 1 手目の相関（台帳込み）を確定させてから発信する', async () => {
    await dialNextHop(deps());
    expect(order).toEqual([
      'save:TEST-call-1:settled',
      'initiate',
      'save:TEST-call-2:in_flight',
      'repoint',
    ]);
  });

  it('🔴 台帳を確定できなければ撃たない（予約できていない）', async () => {
    save.mockRejectedValueOnce(new Error('TEST-write-failed'));
    const result = await dialNextHop(deps());
    expect(result.kind).toBe('reserve_failed');
    expect(initiate).not.toHaveBeenCalled();
  });

  it('1 手目の相関には今回の台帳とイベント数が載る', async () => {
    await dialNextHop(deps());
    const first = save.mock.calls[0]?.[0] as StoredCallCorrelation;
    expect(first.position.ledger).toEqual(['k0', 'k1']);
    expect(first.position.eventCount).toBe(4);
    // 位置そのものは進めない ── この相関は 1 手目のものであり続ける。
    expect(first.position.stepId).toBe('s1');
    expect(first.status).toBe('settled');
  });
});

describe('dialNextHop — 2 手目の相関', () => {
  it('新しい通話 ID で相関を作り、位置・台帳・イベント数を引き継ぐ', async () => {
    const result = await dialNextHop(deps());
    expect(result).toEqual({ kind: 'dialed', providerCallId: 'TEST-call-2' });
    const second = save.mock.calls[1]?.[0] as StoredCallCorrelation;
    expect(second.providerCallId).toBe('TEST-call-2');
    expect(second.receptionId).toBe('rec-1');
    expect(second.tenantId).toBe('internal');
    expect(second.siteId).toBe('default-site');
    expect(second.position.stepId).toBe('s2');
    expect(second.position.hops).toBe(1);
    expect(second.position.ledger).toEqual(['k0', 'k1']);
    expect(second.status).toBe('in_flight');
  });

  /**
   * 🔴 **上限は取次全体で効く (#646 スライス 1)。** 新レコードでイベント数を 0 に戻すと、
   * webhook（無認証の公開エンドポイント）で ledger を hop 数だけ余分に伸ばせる。
   */
  it('🔴 イベント数を 0 に戻さない', async () => {
    await dialNextHop(deps());
    const second = save.mock.calls[1]?.[0] as StoredCallCorrelation;
    expect(second.position.eventCount).toBe(4);
    expect(second.eventCount).toBe(4);
  });

  it('🔴 通話状態は queued から始める ── 1 手目の未応答を引き継ぐと即 timeout になる', async () => {
    await dialNextHop(deps());
    const second = save.mock.calls[1]?.[0] as StoredCallCorrelation;
    expect(second.voiceState).toBe('queued');
  });

  it('🔴 呼出予算をこの手のために引き直す ── 1 手目の期限を持ち込むと即座に打ち切られる', async () => {
    await dialNextHop(deps());
    const second = save.mock.calls[1]?.[0] as StoredCallCorrelation;
    // now(00:01:00) + timeoutSeconds(20) + margin(30)
    expect(second.dialExpiresAt).toBe('2026-08-20T00:01:50.000Z');
  });
});

describe('dialNextHop — 受付の付け替え', () => {
  /**
   * 🔴 **付け替えないと `/status` は 1 手目の相関を読み続ける。** 1 手目は
   * `no_answer` で確定済みなので、2 手目が鳴っている最中に来訪者へ
   * 「応答が得られませんでした」と表示して代替導線へ倒してしまう。
   */
  it('🔴 受付の相関キーを 2 手目へ付け替える', async () => {
    await dialNextHop(deps());
    expect(repoint).toHaveBeenCalledWith('rec-1', 'TEST-call-2');
  });

  it('付け替えに失敗しても撃った事実は返す（次のポーリングへ委ねる）', async () => {
    repoint.mockRejectedValueOnce(new Error('TEST-write-failed'));
    const result = await dialNextHop(deps());
    expect(result).toEqual({ kind: 'handoff_incomplete', providerCallId: 'TEST-call-2' });
  });
});

describe('dialNextHop — 発信の失敗', () => {
  it('発信が失敗したら新相関を書かず、付け替えもしない', async () => {
    initiate.mockRejectedValueOnce(new Error('TEST-dial-failed'));
    const result = await dialNextHop(deps());
    expect(result.kind).toBe('dial_failed');
    expect(save).toHaveBeenCalledTimes(1);
    expect(repoint).not.toHaveBeenCalled();
  });

  it('🔴 新相関を書けなければ付け替えない ── 引けない相関を指すと永久に pending', async () => {
    save.mockImplementationOnce(async (c: StoredCallCorrelation) => {
      order.push(`save:${c.providerCallId}:${c.status}`);
    });
    save.mockRejectedValueOnce(new Error('TEST-write-failed'));
    const result = await dialNextHop(deps());
    expect(result.kind).toBe('handoff_incomplete');
    expect(repoint).not.toHaveBeenCalled();
  });
});
