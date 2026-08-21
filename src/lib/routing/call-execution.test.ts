import { beforeEach, describe, expect, it } from 'vitest';
import { createScriptedProvider } from '@/domain/routing/mock-provider';
import type { RoutingOutcome } from '@/domain/routing/orchestrator';
import type { ConnectCommand } from '@/domain/routing/provider';
import type { VoiceCallInitiator } from '@/domain/routing/voice-initiator';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import {
  buildCallStages,
  createKioskMockProvider,
  executeRoutedCall,
  outcomeToCallStatus,
  REAL_DIALING_UNAVAILABLE,
  runRoutedCall,
  runVoiceRoutedCall,
  selectEntryPolicy,
} from './call-execution';
import {
  __resetCallCorrelationRepository,
  getCallCorrelationRepository,
  type StoredCallCorrelation,
} from './call-correlation';
import type { StoredContactEndpoint, StoredRoutingPolicy } from './types';

function endpoint(over: Partial<StoredContactEndpoint> & Pick<StoredContactEndpoint, 'id'>): StoredContactEndpoint {
  return {
    ownerType: 'staff',
    ownerId: 'staff-1',
    channel: 'pstn',
    e164: '+81900000001',
    providerKey: 'vonage',
    enabled: true,
    tenantId: 'internal',
    siteId: 'default-site',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as StoredContactEndpoint;
}

function policy(over: Partial<StoredRoutingPolicy> & Pick<StoredRoutingPolicy, 'id'>): StoredRoutingPolicy {
  return {
    tenantId: 'internal',
    siteId: 'default-site',
    name: '個人携帯→代理→部門代表',
    enabled: true,
    steps: [
      { id: 'personal', endpointId: 'ep-personal', action: 'notify', timeoutSeconds: 20, nextOn: {} },
      { id: 'acting', endpointId: 'ep-acting', action: 'notify', timeoutSeconds: 20, nextOn: {} },
      { id: 'department', endpointId: 'ep-department', action: 'announce_and_bridge', timeoutSeconds: 30, nextOn: {} },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as StoredRoutingPolicy;
}

const seedEndpoints = [
  endpoint({ id: 'ep-personal', label: '担当者 個人携帯' }),
  endpoint({ id: 'ep-acting', label: '代理担当' }),
  endpoint({ id: 'ep-department', ownerType: 'organization', label: '部門代表' }),
];

describe('selectEntryPolicy (#374 実行時配線)', () => {
  it('有効なポリシーが無ければ undefined（fail-open の起点）', () => {
    expect(selectEntryPolicy([])).toBeUndefined();
    expect(selectEntryPolicy([policy({ id: 'p1', enabled: false })])).toBeUndefined();
  });

  it('有効なポリシーの先頭を entry にする', () => {
    const p = selectEntryPolicy([policy({ id: 'p1' }), policy({ id: 'p2' })]);
    expect(p?.id).toBe('p1');
  });

  it('他ポリシーの fallback 先（葉）より、参照されない root を優先する', () => {
    // p2 は p1 の fallback。root は p1。
    const p1 = policy({ id: 'p1', fallbackPolicyId: 'p2' });
    const p2 = policy({ id: 'p2' });
    expect(selectEntryPolicy([p2, p1])?.id).toBe('p1');
  });
});

describe('createKioskMockProvider (#374 外部発信は mock のまま)', () => {
  it('notify は応答しない（no_answer）、bridge 系は担当者に繋がる（answered）', async () => {
    const provider = createKioskMockProvider('vonage');
    const notify = await provider.connect({
      callUuid: 'c1',
      endpoint: { id: 'e', ownerType: 'staff', channel: 'pstn', providerKey: 'vonage' },
      action: 'notify',
      timeoutSeconds: 10,
    });
    const bridge = await provider.connect({
      callUuid: 'c1',
      endpoint: { id: 'e', ownerType: 'staff', channel: 'pstn', providerKey: 'vonage' },
      action: 'announce_and_bridge',
      timeoutSeconds: 10,
    });
    expect(notify.result).toBe('no_answer');
    expect(bridge.result).toBe('answered');
    // providerEventId は 1 手ごとに一意。
    expect(notify.providerEventId).not.toBe(bridge.providerEventId);
  });
});

describe('outcomeToCallStatus (#374 応答契約 後方互換マッピング)', () => {
  const base: Omit<RoutingOutcome, 'status' | 'reason'> = { trace: [], hops: 0, ledger: new Set() };
  it('connected→connected / unreached→timeout / exhausted→failed', () => {
    expect(outcomeToCallStatus({ ...base, status: 'connected', reason: 'stopped' })).toBe('connected');
    expect(outcomeToCallStatus({ ...base, status: 'unreached', reason: 'stopped' })).toBe('timeout');
    expect(outcomeToCallStatus({ ...base, status: 'exhausted', reason: 'duplicate_event' })).toBe('failed');
  });
});

describe('buildCallStages (#374 段階を実行トレースから供給)', () => {
  it('実行済みの手順は done、未到達は pending（entry policy の手順順）', () => {
    const p = policy({ id: 'p1' });
    // personal, acting を試して department で応答したトレース。
    const trace: RoutingOutcome['trace'] = [
      { policyId: 'p1', stepId: 'personal', endpointId: 'ep-personal', ownerType: 'staff', action: 'notify', result: 'no_answer', providerEventId: 'x0' },
      { policyId: 'p1', stepId: 'acting', endpointId: 'ep-acting', ownerType: 'staff', action: 'notify', result: 'no_answer', providerEventId: 'x1' },
      { policyId: 'p1', stepId: 'department', endpointId: 'ep-department', ownerType: 'organization', action: 'announce_and_bridge', result: 'answered', providerEventId: 'x2' },
    ];
    expect(buildCallStages(p, trace)).toEqual([
      { key: 'personal', status: 'done' },
      { key: 'acting', status: 'done' },
      { key: 'department', status: 'done' },
    ]);
  });

  it('未到達の手順は pending のまま', () => {
    const p = policy({ id: 'p1' });
    const trace: RoutingOutcome['trace'] = [
      { policyId: 'p1', stepId: 'personal', endpointId: 'ep-personal', ownerType: 'staff', action: 'notify', result: 'answered', providerEventId: 'x0' },
    ];
    expect(buildCallStages(p, trace)).toEqual([
      { key: 'personal', status: 'done' },
      { key: 'acting', status: 'pending' },
      { key: 'department', status: 'pending' },
    ]);
  });

  it('key 規則（英数字/._- のみ）に反する stepId は段階から除外する（PII/表示防御）', () => {
    const p = policy({ id: 'p1', steps: [{ id: '山田 個人', endpointId: 'ep-personal', action: 'notify', timeoutSeconds: 20, nextOn: {} }] });
    expect(buildCallStages(p, [])).toEqual([]);
  });
});

describe('runRoutedCall (#374 保存済みルートに従った段階実行)', () => {
  it('保存ルートがあれば mock で段階実行し、bridge で connected・stages を返す', async () => {
    const routed = await runRoutedCall('call-1', { policies: [policy({ id: 'p1' })], endpoints: seedEndpoints });
    expect(routed).not.toBeNull();
    if (!routed) return;
    expect(routed.status).toBe('connected');
    expect(routed.stages).toEqual([
      { key: 'personal', status: 'done' },
      { key: 'acting', status: 'done' },
      { key: 'department', status: 'done' },
    ]);
    // トレースにアドレス（e164）を載せない（PII 最小化）。
    expect(JSON.stringify(routed).includes('+81900000001')).toBe(false);
  });

  it('有効ルートが無ければ null（fail-open で従来の単発 mock へ）', async () => {
    expect(await runRoutedCall('call-1', { policies: [], endpoints: seedEndpoints })).toBeNull();
    expect(
      await runRoutedCall('call-1', { policies: [policy({ id: 'p1', enabled: false })], endpoints: seedEndpoints }),
    ).toBeNull();
  });

  it('冪等台帳: Provider の重複イベント（retry 再配信）で二重発信せず打ち切る', async () => {
    // 常に同一 providerEventId を返す＝webhook 再配信相当。2 手目で重複検知 → 打ち切り。
    const dupProvider = createScriptedProvider({
      key: 'vonage',
      results: ['no_answer', 'answered'],
      eventIdFor: () => 'dup-evt',
    });
    const routed = await runRoutedCall('call-1', {
      policies: [policy({ id: 'p1' })],
      endpoints: seedEndpoints,
      providers: [dupProvider],
    });
    expect(routed).not.toBeNull();
    if (!routed) return;
    // 重複で打ち切り → connected にならない（answered を二重適用しない）。
    expect(routed.status).toBe('failed');
    expect(routed.outcome.reason).toBe('duplicate_event');
    // 1 手目（personal）だけ実行され done、以降は pending。
    expect(routed.stages).toEqual([
      { key: 'personal', status: 'done' },
      { key: 'acting', status: 'pending' },
      { key: 'department', status: 'pending' },
    ]);
  });
});

/**
 * 実 PSTN 発信の経路 (#4 Inc D-2 項目 2)。
 *
 * mock 経路と**形が違う**のが要点 — mock は 1 リクエストで取次を最後まで回して確定するが、
 * 実発信は 1 手目を撃って `'calling'` で返し、結果は webhook で後から届く。
 * ここで固定するのは「嘘をつかないこと」: 撃っていないのに繋がったことにしない、
 * 撃ったのに失敗を握り潰さない、相関を書けないまま鳴らしっぱなしにしない。
 */
describe('runVoiceRoutedCall (#4 Inc D-2 項目 2 実発信)', () => {
  function initiatorSpy(over: { initiate?: VoiceCallInitiator['initiate'] } = {}) {
    const calls: ConnectCommand[] = [];
    const initiator: VoiceCallInitiator = {
      key: 'vonage-voice',
      initiate:
        over.initiate ??
        (async (command) => {
          calls.push(command);
          return { providerCallId: 'TEST-provider-call-id' };
        }),
    };
    return { initiator, calls };
  }

  function deps(over: Partial<Parameters<typeof runVoiceRoutedCall>[1]> = {}) {
    const saved: StoredCallCorrelation[] = [];
    const order: string[] = [];
    const { initiator, calls } = initiatorSpy();
    const base = {
      scope: { tenantId: 'internal', siteId: 'default-site' },
      policies: [policy({ id: 'p1' })],
      endpoints: seedEndpoints,
      initiator: {
        key: initiator.key,
        initiate: async (command: ConnectCommand) => {
          order.push('initiate');
          return initiator.initiate(command);
        },
      },
      saveCorrelation: async (c: StoredCallCorrelation) => {
        order.push('save');
        saved.push(c);
      },
      now: () => new Date('2026-08-07T12:00:00.000Z'),
    };
    return { deps: { ...base, ...over }, saved, order, calls };
  }

  it('最初の 1 手だけを発信し、同期では確定しない（calling）', async () => {
    const d = deps();
    const routed = await runVoiceRoutedCall('rec-1', d.deps);
    expect(routed?.status).toBe('calling');
    // 🔴 mock 経路のように最後まで回さない。回すと「鳴らしていない相手に繋がった」ことになる。
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.endpoint.id).toBe('ep-personal');
    expect(d.calls[0]?.callUuid).toBe('rec-1');
  });

  it('発信リクエストに来訪者情報を載せない（PII 境界）', async () => {
    const d = deps();
    await runVoiceRoutedCall('rec-1', d.deps);
    const command = d.calls[0];
    expect(command?.announceText).toBe('受付からの取次です。');
    expect(JSON.stringify(command)).not.toContain('+8190');
  });

  it('相関を保存し、webhook が引ける鍵と現在位置を持つ', async () => {
    const d = deps();
    await runVoiceRoutedCall('rec-1', d.deps);
    expect(d.saved).toHaveLength(1);
    const c = d.saved[0]!;
    expect(c.providerCallId).toBe('TEST-provider-call-id');
    expect(c.receptionId).toBe('rec-1');
    expect(c.tenantId).toBe('internal');
    expect(c.siteId).toBe('default-site');
    expect(c.status).toBe('in_flight');
    expect(c.voiceState).toBe('queued');
    expect(c.eventCount).toBe(0);
    // 位置は 1 手目を撃った状態。ここが空だと webhook が「どこまで撃ったか」を復元できない。
    expect(c.position.stepId).toBe('personal');
    expect(c.position.callUuid).toBe('rec-1');
  });

  it('🔴 相関は発信の**後**に書く（provider 通話 ID は発信しないと分からない）', async () => {
    const d = deps();
    await runVoiceRoutedCall('rec-1', d.deps);
    expect(d.order).toEqual(['initiate', 'save']);
  });

  it('🔴 発信に失敗したら failed を返す（例外を投げて mock へ fail-open させない）', async () => {
    // 投げると呼び出し側（call route）が単発 mock へ倒し、**鳴っていないのに繋がった**と
    // 来訪者へ表示しうる。実発信経路の失敗は失敗として返す。
    const d = deps({
      initiator: {
        key: 'vonage-voice',
        initiate: async () => {
          throw new Error('vonage voice: create call failed (status 401)');
        },
      },
    });
    const routed = await runVoiceRoutedCall('rec-1', d.deps);
    expect(routed?.status).toBe('failed');
    expect(routed?.reason).toBeDefined();
    // 撃てていないので相関も書かない（書くと webhook が来ない相関が滞留する）。
    expect(d.saved).toHaveLength(0);
  });

  it('🔴 発信の理由（reason）に資格情報や電話番号を載せない', async () => {
    const d = deps({
      initiator: {
        key: 'vonage-voice',
        initiate: async () => {
          throw new Error('vonage voice: endpoint not resolvable (+81900000001)');
        },
      },
    });
    const routed = await runVoiceRoutedCall('rec-1', d.deps);
    expect(routed?.reason).not.toContain('+8190');
  });

  it('🔴 相関を保存できなければ failed（calling のまま放置しない）', async () => {
    // 相関が無いと 4 webhook とも 403 になり、取次は永久に進まない。
    // 'calling' で返すと来訪者は無限に待つ。失敗として返し、有人支援へ倒す。
    const d = deps({
      saveCorrelation: async () => {
        throw new Error('backend unavailable');
      },
    });
    const routed = await runVoiceRoutedCall('rec-1', d.deps);
    expect(routed?.status).toBe('failed');
  });

  it('1 手目は active、残りは pending（撃った手を done と偽らない）', async () => {
    const d = deps();
    const routed = await runVoiceRoutedCall('rec-1', d.deps);
    expect(routed?.stages).toEqual([
      { key: 'personal', status: 'active' },
      { key: 'acting', status: 'pending' },
      { key: 'department', status: 'pending' },
    ]);
  });

  it('接続先が無効／不在なら発信しない', async () => {
    const d = deps({ endpoints: [endpoint({ id: 'ep-personal', enabled: false })] });
    const routed = await runVoiceRoutedCall('rec-1', d.deps);
    expect(routed?.status).toBe('failed');
    expect(d.calls).toHaveLength(0);
    expect(d.saved).toHaveLength(0);
  });

  it('有効なポリシーが無ければ null（呼び出し側は従来どおり fail-open）', async () => {
    const d = deps({ policies: [] });
    expect(await runVoiceRoutedCall('rec-1', d.deps)).toBeNull();
  });
});

/**
 * 経路の選択 (#4 Inc D-2 項目 2)。
 *
 * ここが「配線されているか」の唯一の門。**mock と実発信のどちらを選んだか**は
 * 上位から見えないので、選択そのものをテストで固定する
 * （実装だけ足して呼ばれていない、という形をこのリポジトリは繰り返し踏んでいる）。
 */
describe('executeRoutedCall の mock/vonage 分岐', () => {
  const scope = { tenantId: asTenantId('internal'), siteId: asSiteId('default-site') };

  beforeEach(() => {
    __resetCallCorrelationRepository();
  });

  function stubInitiator() {
    const calls: ConnectCommand[] = [];
    const initiator: VoiceCallInitiator = {
      key: 'vonage-voice',
      initiate: async (command) => {
        calls.push(command);
        return { providerCallId: 'TEST-provider-call-id' };
      },
    };
    return { initiator, calls };
  }

  /**
   * 実発信の**意図が無い**テナント（設定 mock / 未設定 = dev・デモ・既定）。
   * 明示的に渡すのは、既定へ倒すと「設定を読みに行った結果 false」なのか
   * 「意図を見ていない」のか区別が付かないため。
   */
  const NO_REAL_DIALING_INTENT = { intendsRealDialing: async () => false };

  /** `REAL_DIALING_UNAVAILABLE` でないことを主張しつつ型を絞る。 */
  function asRouted(outcome: Awaited<ReturnType<typeof executeRoutedCall>>) {
    expect(outcome).not.toBe(REAL_DIALING_UNAVAILABLE);
    return outcome as Exclude<typeof outcome, typeof REAL_DIALING_UNAVAILABLE>;
  }

  it('🔴 webhookBaseUrl が無ければ実発信を試みない（解決すら呼ばない）', async () => {
    // 分からないまま撃つと Function URL 由来の URL を Vonage へ渡し、全 webhook が 403 になる。
    let asked = 0;
    const routed = asRouted(
      await executeRoutedCall(scope, 'rec-1', {
        ...NO_REAL_DIALING_INTENT,
        resolveInitiator: async () => {
          asked += 1;
          return stubInitiator().initiator;
        },
      }),
    );
    expect(asked).toBe(0);
    // mock 経路＝同期確定（outcome を持つ）。
    expect(routed?.status).not.toBe('calling');
    expect(routed?.outcome).toBeDefined();
  });

  it('テナントが実発信者を解決できなければ mock 経路のまま', async () => {
    const routed = asRouted(
      await executeRoutedCall(scope, 'rec-1', {
        ...NO_REAL_DIALING_INTENT,
        webhookBaseUrl: 'https://example.test',
        resolveInitiator: async () => null,
      }),
    );
    expect(routed?.status).not.toBe('calling');
    expect(routed?.outcome).toBeDefined();
  });

  /**
   * 🔴 **実発信のつもりのテナントで mock へ倒さない (#736)。**
   *
   * mock provider は bridge 系を**無条件で `'answered'`** にする。設定は vonage + enabled
   * なのに撃てなかったとき（資格情報の不備・webhook 基底 URL 不明）にそのまま mock へ倒すと、
   * 来訪者には「担当者が応答しました」と出て受付が `completed` に到達する ——
   * **誰も呼ばれていないのに全員が受付完了する**。運用者からは「全員入館できている」ように
   * 見えるので、設定不備に気づく手掛かりが一つも無い。
   */
  it('🔴 実発信の意図があるのに解決できなければ mock へ倒さない', async () => {
    const outcome = await executeRoutedCall(scope, 'rec-1', {
      intendsRealDialing: async () => true,
      webhookBaseUrl: 'https://example.test',
      resolveInitiator: async () => null,
    });
    expect(outcome).toBe(REAL_DIALING_UNAVAILABLE);
  });

  it('🔴 webhookBaseUrl が分からないときも同じ（撃てないことに変わりはない）', async () => {
    const outcome = await executeRoutedCall(scope, 'rec-1', {
      intendsRealDialing: async () => true,
      resolveInitiator: async () => stubInitiator().initiator,
    });
    expect(outcome).toBe(REAL_DIALING_UNAVAILABLE);
  });

  /** 意図が無いテナント（dev・デモ）は従来どおり mock で完走する。 */
  it('意図が無ければ従来どおり mock で完走する（dev / デモを壊さない）', async () => {
    const routed = asRouted(
      await executeRoutedCall(scope, 'rec-1', {
        ...NO_REAL_DIALING_INTENT,
        webhookBaseUrl: 'https://example.test',
        resolveInitiator: async () => null,
      }),
    );
    expect(routed).not.toBeNull();
    expect(routed?.outcome).toBeDefined();
  });

  /** 解決できたなら意図の有無に関わらず実発信経路（意図の判定が発信を止めない）。 */
  it('解決できたときは意図を見ずに実発信経路へ入る', async () => {
    const { initiator, calls } = stubInitiator();
    const routed = asRouted(
      await executeRoutedCall(scope, 'rec-1', {
        intendsRealDialing: async () => {
          throw new Error('TEST-意図を読んではいけない');
        },
        webhookBaseUrl: 'https://example.test',
        resolveInitiator: async () => initiator,
      }),
    );
    expect(routed?.status).toBe('calling');
    expect(calls.length).toBe(1);
  });

  it('実発信者が解決できたら実発信経路へ入る（mock orchestrator を走らせない）', async () => {
    const { initiator, calls } = stubInitiator();
    const routed = asRouted(
      await executeRoutedCall(scope, 'rec-1', {
        webhookBaseUrl: 'https://example.test',
        resolveInitiator: async () => initiator,
      }),
    );
    expect(routed?.status).toBe('calling');
    expect(routed?.providerCallId).toBe('TEST-provider-call-id');
    // mock 経路は最後まで回して outcome を作る。実発信経路では在ってはならない。
    expect(routed?.outcome).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('実発信経路は webhook が引ける相関を実際に永続化する', async () => {
    const { initiator } = stubInitiator();
    await executeRoutedCall(scope, 'rec-1', {
      webhookBaseUrl: 'https://example.test',
      resolveInitiator: async () => initiator,
    });
    const stored = await getCallCorrelationRepository().get('TEST-provider-call-id');
    expect(stored?.receptionId).toBe('rec-1');
    expect(stored?.tenantId).toBe('internal');
    expect(stored?.status).toBe('in_flight');
  });
});

/**
 * 呼出予算 (#647)。
 *
 * webhook が一度も来なくても `/status` の読み時に確定できるよう、発信時に期限を置く。
 * 置き忘れると「webhook が来ない通話が永久に calling」に戻る。
 */
describe('runVoiceRoutedCall — 呼出予算 dialExpiresAt (#647)', () => {
  const at = new Date('2026-08-08T12:00:00.000Z');

  function depsWithClock() {
    const saved: StoredCallCorrelation[] = [];
    return {
      saved,
      deps: {
        scope: { tenantId: 'internal', siteId: 'default-site' },
        policies: [policy({ id: 'p1' })],
        endpoints: seedEndpoints,
        initiator: {
          key: 'vonage-voice',
          initiate: async () => ({ providerCallId: 'TEST-provider-call-id' }),
        },
        saveCorrelation: async (c: StoredCallCorrelation) => {
          saved.push(c);
        },
        now: () => at,
      },
    };
  }

  it('🔴 発信時に呼出予算の期限を置く（無いと遅延確定ができない）', async () => {
    const d = depsWithClock();
    await runVoiceRoutedCall('rec-1', d.deps);
    expect(d.saved[0]?.dialExpiresAt).toBeDefined();
  });

  it('期限は 1 手目の timeoutSeconds より後（鳴っている最中に打ち切らない）', async () => {
    const d = depsWithClock();
    await runVoiceRoutedCall('rec-1', d.deps);
    const expiresAt = Date.parse(d.saved[0]!.dialExpiresAt!);
    // 1 手目 personal は timeoutSeconds=20。webhook の配送遅延ぶんの余裕も要る。
    expect(expiresAt).toBeGreaterThan(at.getTime() + 20_000);
  });

  it('期限は青天井にしない（確定しない通話を作らない）', async () => {
    const d = depsWithClock();
    await runVoiceRoutedCall('rec-1', d.deps);
    const expiresAt = Date.parse(d.saved[0]!.dialExpiresAt!);
    expect(expiresAt).toBeLessThan(at.getTime() + 10 * 60_000);
  });
});
