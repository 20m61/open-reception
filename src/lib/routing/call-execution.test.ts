import { describe, expect, it } from 'vitest';
import { createScriptedProvider } from '@/domain/routing/mock-provider';
import type { RoutingOutcome } from '@/domain/routing/orchestrator';
import {
  buildCallStages,
  createKioskMockProvider,
  outcomeToCallStatus,
  runRoutedCall,
  selectEntryPolicy,
} from './call-execution';
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
