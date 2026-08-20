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
const reserve = vi.fn();
const repoint = vi.fn();
const initiate = vi.fn();
const isReceptionCalling = vi.fn();
const order: string[] = [];

function deps(over: Partial<Parameters<typeof dialNextHop>[0]> = {}) {
  return {
    correlation: correlation(),
    next: nextProgress(),
    step: STEP,
    endpoints: [ENDPOINT],
    initiator: { key: 'vonage', initiate },
    saveCorrelation: save,
    reserve,
    repointReception: repoint,
    isReceptionCalling,
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
  reserve.mockImplementation(async (id: string) => {
    order.push(`reserve:${id}`);
    return true;
  });
  isReceptionCalling.mockResolvedValue(true);
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

  /**
   * 🔴 PSTN 以外は番号を引けないので発信が例外になる。予約の**後**でそれが起きると
   * 1 手目は確定済みなので、以降の手を全部捨てて取次がそこで終わる。
   */
  it('🔴 PSTN でない接続先は予約の前に弾く', async () => {
    const result = await dialNextHop(
      deps({ endpoints: [{ ...ENDPOINT, channel: 'sip', uri: 'sip:x@example.test' }] }),
    );
    expect(result.kind).toBe('endpoint_unavailable');
    expect(reserve).not.toHaveBeenCalled();
    expect(initiate).not.toHaveBeenCalled();
  });

  /**
   * 🔴 来訪者がキャンセルした後や既に確定した受付のために社内の電話を鳴らさない。
   * 相関は受付の終端と連動していないので、ここで見ないと最大 10 段まで鳴る。
   */
  it('🔴 受付がもう呼び出し中でなければ撃たない', async () => {
    isReceptionCalling.mockResolvedValue(false);
    const result = await dialNextHop(deps());
    expect(result.kind).toBe('reception_closed');
    expect(reserve).not.toHaveBeenCalled();
    expect(initiate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('dialNextHop — 冪等（予約）', () => {
  /**
   * 🔴 発信してから台帳を書くと、同一 `jti` の再配信が発信の**最中**に届いたときに
   * 二重発信になる（担当者の電話が 2 本鳴る）。先に予約を確定させれば再配信は弾かれる。
   */
  it('🔴 撃つ権利を取ってから発信する', async () => {
    await dialNextHop(deps());
    expect(order).toEqual([
      'reserve:TEST-call-1',
      'initiate',
      'save:TEST-call-2:in_flight',
      'repoint',
    ]);
  });

  /**
   * 🔴 **ここが本体。** Vonage は不応答の 1 通話に `unanswered` と `completed` を
   * **別 jti・ほぼ同時**に送る。台帳の duplicate 判定では掛からないので、予約そのものを
   * compare-and-set にしないと両方が撃つ。
   */
  it('🔴 予約に負けたら撃たず、保存もしない', async () => {
    reserve.mockResolvedValue(false);
    const result = await dialNextHop(deps());
    expect(result.kind).toBe('reserve_lost');
    expect(initiate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(repoint).not.toHaveBeenCalled();
  });

  it('🔴 予約は「読んだ時点から動いていないこと」を条件にする（楽観ロック）', async () => {
    await dialNextHop(deps());
    const [, , expectedUpdatedAt] = reserve.mock.calls[0] as [string, unknown, string];
    expect(expectedUpdatedAt).toBe(correlation().updatedAt);
  });

  it('🔴 予約を書けなければ撃たない', async () => {
    reserve.mockRejectedValueOnce(new Error('TEST-write-failed'));
    const result = await dialNextHop(deps());
    expect(result.kind).toBe('reserve_failed');
    expect(initiate).not.toHaveBeenCalled();
  });

  it('予約には今回の台帳とイベント数が載り、1 手目は確定する', async () => {
    await dialNextHop(deps());
    const [, changes] = reserve.mock.calls[0] as [string, Partial<StoredCallCorrelation>, string];
    expect(changes.position?.ledger).toEqual(['k0', 'k1']);
    expect(changes.position?.eventCount).toBe(4);
    // 位置そのものは進めない ── この相関は 1 手目のものであり続ける。
    expect(changes.position?.stepId).toBe('s1');
    expect(changes.status).toBe('settled');
  });

  /**
   * 🔴 **予約で terminal な通話状態を書かない。** 受付の相関キーはまだ 1 手目を指しており、
   * `resolveCallResolution` は呼出予算より先に `voiceState` を見る。3 秒ポーリングが
   * この窓に当たると、2 手目が鳴っている最中に来訪者へ「応答が得られませんでした」と出る。
   */
  it('🔴 予約で通話状態を進めない', async () => {
    await dialNextHop(deps());
    const [, changes] = reserve.mock.calls[0] as [string, Partial<StoredCallCorrelation>, string];
    expect(changes.voiceState).toBeUndefined();
  });

  /**
   * 🔴 通話状態を据え置くだけでは足りない ── 1 手目の呼出予算が経過していれば
   * `budgetElapsed` が同じ窓で timeout を返す。次の手のぶんへ引き直す。
   */
  it('🔴 呼出予算を次の手のぶんへ引き直す', async () => {
    await dialNextHop(deps());
    const [, changes] = reserve.mock.calls[0] as [string, Partial<StoredCallCorrelation>, string];
    // now(00:01:00) + timeoutSeconds(20) + margin(30)
    expect(changes.dialExpiresAt).toBe('2026-08-20T00:01:50.000Z');
  });
});

describe('dialNextHop — 2 手目の相関', () => {
  it('新しい通話 ID で相関を作り、位置・台帳・イベント数を引き継ぐ', async () => {
    const result = await dialNextHop(deps());
    expect(result).toEqual({ kind: 'dialed', providerCallId: 'TEST-call-2' });
    const second = save.mock.calls[0]?.[0] as StoredCallCorrelation;
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
    const second = save.mock.calls[0]?.[0] as StoredCallCorrelation;
    expect(second.position.eventCount).toBe(4);
    expect(second.eventCount).toBe(4);
  });

  it('🔴 通話状態は queued から始める ── 1 手目の未応答を引き継ぐと即 timeout になる', async () => {
    await dialNextHop(deps());
    const second = save.mock.calls[0]?.[0] as StoredCallCorrelation;
    expect(second.voiceState).toBe('queued');
  });

  it('🔴 呼出予算をこの手のために引き直す ── 1 手目の期限を持ち込むと即座に打ち切られる', async () => {
    await dialNextHop(deps());
    const second = save.mock.calls[0]?.[0] as StoredCallCorrelation;
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
    expect(repoint).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **撃てなかったと分かったら通話状態を terminal にする。** 予約で保留にしたままだと、
   * 引き直した呼出予算（次の手ぶん）が経過するまで来訪者が待たされる ── 鳴っていないのに。
   */
  it('🔴 発信が失敗したら 1 手目を未応答として確定させる（代替導線へ倒す）', async () => {
    initiate.mockRejectedValueOnce(new Error('TEST-dial-failed'));
    await dialNextHop(deps());
    const settled = save.mock.calls[0]?.[0] as StoredCallCorrelation;
    expect(settled.providerCallId).toBe('TEST-call-1');
    expect(settled.voiceState).toBe('no_answer');
    expect(settled.status).toBe('settled');
    // 予約で引き直した期限を残さない（鳴っていない手のぶん待たせない）。
    expect(settled.dialExpiresAt).toBe(correlation().dialExpiresAt);
  });

  it('🔴 新相関を書けなければ付け替えない ── 引けない相関を指すと永久に pending', async () => {
    save.mockRejectedValueOnce(new Error('TEST-write-failed'));
    const result = await dialNextHop(deps());
    expect(result.kind).toBe('handoff_incomplete');
    expect(repoint).not.toHaveBeenCalled();
  });
});
