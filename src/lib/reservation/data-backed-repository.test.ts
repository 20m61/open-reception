/**
 * 予約の永続化 (#97 increment 3 / #736 Gate A)。
 *
 * ## 事実
 *
 * 予約は `MemoryReservationRepository`（モジュールスコープの singleton）に載っていた。
 * routing 側は `getBackend()` に載っているのに、予約だけがプロセス内のまま。
 *
 * 🔴 **その結果、本番形態では QR がまったく機能しない。** 管理画面で発行した予約は、
 * 受付端末のリクエストを処理する別の Lambda インスタンスからは見えない。
 * **発行した QR は必ず「不明な QR」になる。**
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { asReservationId, asReservationToken, type VisitReservation } from '@/domain/reservation/types';
import { hashReservationToken } from '@/domain/reservation/token';
import { getBackend } from '@/lib/data';
import { DataBackedReservationRepository, RESERVATION_COLLECTION } from './data-backed-repository';

const TOKEN = asReservationToken('TEST-reservation-token');
const TOKEN_HASH = hashReservationToken(TOKEN);
const OTHER_HASH = hashReservationToken(asReservationToken('TEST-other-token'));

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_1 = asSiteId('site-1');
const S_2 = asSiteId('site-2');

function res(over: Partial<VisitReservation> = {}): VisitReservation {
  return {
    id: asReservationId('rsv-1'),
    tenantId: T_A,
    siteId: S_1,
    visitorName: 'TEST-来客',
    visitAt: '2026-08-21T01:00:00.000Z',
    targetType: 'staff',
    targetId: 'staff-1',
    tokenHash: TOKEN_HASH,
    usagePolicy: 'single_use',
    expiresAt: '2026-08-28T00:00:00.000Z',
    status: 'active',
    retentionDays: 30,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

beforeEach(async () => {
  await getBackend()
    .collection<{ id: string; scopedTokenHash: string }>(RESERVATION_COLLECTION, {
      indexedField: 'scopedTokenHash',
    })
    .reset();
});

describe('DataBackedReservationRepository (#736)', () => {
  it('create / get / list', async () => {
    const repo = new DataBackedReservationRepository();
    expect((await repo.create(res())).ok).toBe(true);
    expect(await repo.get(T_A, S_1, asReservationId('rsv-1'))).toMatchObject({ id: 'rsv-1' });
    expect(await repo.list(T_A, S_1)).toHaveLength(1);
  });

  it('id 重複は conflict', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    const again = await repo.create(res());
    expect(again.ok).toBe(false);
  });

  /**
   * 🔴 **これが本体。** 発行したインスタンスと照合するインスタンスが別でも引けること。
   * in-memory singleton だとここで落ちる（別インスタンスは空の Map を持つ）。
   */
  it('🔴 別インスタンスから token hash で引ける（発行と照合が別 Lambda でも成立する）', async () => {
    await new DataBackedReservationRepository().create(res());

    // 受付端末側の Lambda インスタンス相当。
    const reader = new DataBackedReservationRepository();
    const found = await reader.findByTokenHash(T_A, S_1, TOKEN_HASH);

    expect(found, '別インスタンスから予約を引けない').toBeDefined();
    expect(found?.id).toBe('rsv-1');
  });

  it('一致しない hash では引けない', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    expect(await repo.findByTokenHash(T_A, S_1, OTHER_HASH)).toBeUndefined();
  });

  /**
   * 🔴 **越境させない。** 索引キーへ境界を畳み込んであるので、他テナント・他サイトは
   * 索引の時点で引けない。「在るが読めない」と「無い」を同じ結果（undefined）にする。
   */
  it('🔴 他テナント・他サイトからは同じ token hash でも引けない', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    expect(await repo.findByTokenHash(T_B, S_1, TOKEN_HASH)).toBeUndefined();
    expect(await repo.findByTokenHash(T_A, S_2, TOKEN_HASH)).toBeUndefined();
  });

  it('🔴 get / list も越境しない', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    expect(await repo.get(T_B, S_1, asReservationId('rsv-1'))).toBeUndefined();
    expect(await repo.list(T_B, S_1)).toHaveLength(0);
  });

  it('put で上書きでき、更新後の状態が読める（使用済み化）', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    await repo.put(res({ status: 'used', usedAt: '2026-08-21T02:00:00.000Z' }));
    expect((await repo.get(T_A, S_1, asReservationId('rsv-1')))?.status).toBe('used');
  });

  /**
   * 🔴 索引用の派生値をドメイン型へ混ぜない。API 応答や監査へそのまま流れると、
   * token hash が意図せず外へ出る経路になりうる。
   */
  it('🔴 読み出した予約に索引用の派生値を混ぜない', async () => {
    const repo = new DataBackedReservationRepository();
    await repo.create(res());
    const found = await repo.findByTokenHash(T_A, S_1, TOKEN_HASH);
    expect(found).toBeDefined();
    expect(Object.keys(found!)).not.toContain('scopedTokenHash');
  });
});
