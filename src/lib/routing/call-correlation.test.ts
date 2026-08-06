import { beforeEach, describe, expect, it } from 'vitest';
import type { RoutingPosition } from '@/domain/routing/resumable';
import {
  DataBackedCallCorrelationRepository,
  type StoredCallCorrelation,
} from './call-correlation';

const POSITION: RoutingPosition = {
  callUuid: 'TEST-call-1',
  policyId: 'p1',
  stepId: 's1',
  hops: 0,
  ledger: [],
};

function correlation(over: Partial<StoredCallCorrelation> = {}): StoredCallCorrelation {
  return {
    providerCallId: 'TEST-vonage-uuid-1',
    receptionId: 'TEST-reception-1',
    tenantId: 'internal',
    siteId: 'default-site',
    position: POSITION,
    status: 'in_flight',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('CallCorrelation — provider の通話 ID から受付を引く (#4)', () => {
  let repo: DataBackedCallCorrelationRepository;

  beforeEach(() => {
    repo = new DataBackedCallCorrelationRepository();
  });

  it('保存した相関を provider の通話 ID で引ける', async () => {
    await repo.put(correlation());
    const found = await repo.get('TEST-vonage-uuid-1');
    expect(found).toMatchObject({ receptionId: 'TEST-reception-1', tenantId: 'internal' });
  });

  it('未知の通話 ID は undefined（存在の有無を語らない）', async () => {
    expect(await repo.get('TEST-unknown')).toBeUndefined();
  });

  it('取次の位置を更新できる（webhook 1 件で 1 歩進める）', async () => {
    await repo.put(correlation());
    const advanced: RoutingPosition = { ...POSITION, stepId: 's2', hops: 1, ledger: ['k1'] };
    await repo.put(correlation({ position: advanced }));
    expect((await repo.get('TEST-vonage-uuid-1'))?.position).toMatchObject({ stepId: 's2', hops: 1 });
  });

  it('確定した相関は status で分かる（以降の webhook を進めない材料）', async () => {
    await repo.put(correlation({ status: 'settled' }));
    expect((await repo.get('TEST-vonage-uuid-1'))?.status).toBe('settled');
  });
});

describe('テナント越境を防ぐ (#4)', () => {
  let repo: DataBackedCallCorrelationRepository;

  beforeEach(async () => {
    repo = new DataBackedCallCorrelationRepository();
    await repo.put(correlation({ providerCallId: 'TEST-other', tenantId: 'other-tenant' }));
  });

  // 🔴 webhook は公開エンドポイント。呼び出し側が期待テナントを渡し、一致しなければ
  // 引けないようにする。ここが緩いと、他テナントの通話 ID を投げて受付 ID を掘り出せる。
  it('期待テナントと一致しない相関は取得できない', async () => {
    expect(await repo.getForTenant('TEST-other', 'internal')).toBeUndefined();
  });

  it('期待テナントと一致すれば取得できる', async () => {
    expect(await repo.getForTenant('TEST-other', 'other-tenant')).toMatchObject({
      tenantId: 'other-tenant',
    });
  });

  it('存在しない通話 ID と越境の結果が区別できない（存在を漏らさない）', async () => {
    const crossTenant = await repo.getForTenant('TEST-other', 'internal');
    const missing = await repo.getForTenant('TEST-nope', 'internal');
    expect(crossTenant).toBe(missing);
  });
});

describe('保存内容に PII と機密を含めない (#4)', () => {
  it('来訪者情報・電話番号・secret を持たない型である', async () => {
    const repo = new DataBackedCallCorrelationRepository();
    await repo.put(correlation());
    const stored = await repo.get('TEST-vonage-uuid-1');
    const serialized = JSON.stringify(stored);
    // 相関は「どの通話がどの受付か」だけを持つ。氏名・番号・secret は受付側/設定側にある。
    for (const forbidden of ['visitor', 'name', 'e164', 'phone', 'secret', 'token']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });
});
