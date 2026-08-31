/**
 * 発行した予約が受付端末から引けること (#736 Gate A)。
 *
 * ## 事実（修正前）
 *
 * 予約の発行（`getReservationService()`）と QR の照合（`getCheckinService()`）は、
 * **それぞれ別の `MemoryReservationRepository` を私有していた**。同一プロセスでも別 Map、
 * Lambda では別インスタンス。どちらの理由でも、**発行した QR は必ず「不明な QR」になる**。
 *
 * ここが固定するのは「**同じバックエンドを見ている**」ことだけ。発行 API の認可も、
 * 期限切れ・使用済みの判定も、それぞれの層が別に固定している。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { getBackend } from '@/lib/data';
import { RESERVATION_COLLECTION } from '@/lib/reservation/data-backed-repository';
import { getReservationService, __resetReservationService } from '@/lib/reservation/store';
import { getCheckinService, __resetCheckinService } from './store';

const TENANT = asTenantId('internal');
const SITE = asSiteId('default-site');

const ACTOR = {
  status: 'active' as const,
  assignments: [{ role: 'tenant_admin' as const, tenantId: TENANT, siteId: null, deviceId: null }],
};

// 🔴 **絶対日付を書かない。** 以前ここは `visitAt: '2026-08-28…'` /
// `expiresAt: '2026-08-29…'` というリテラルで、**2026-08-29 を過ぎた時点で予約が
// 期限切れ**（`lifecycle.ts` の `Date.parse(expiresAt) <= now`）になり、
// 照合が `not_found` に倒れて落ちるようになっていた。#736 が縛りたいのは
// 「発行と照合が同じバックエンドを見ているか」だけで、期限は本質ではない。
// 現在時刻からの相対にして、いつ実行しても同じことを主張させる。
const HOUR_MS = 60 * 60 * 1000;
const INPUT = {
  tenantId: TENANT,
  siteId: SITE,
  visitorName: 'TEST-来客',
  visitAt: new Date(Date.now() + HOUR_MS).toISOString(),
  targetType: 'staff' as const,
  targetId: 'staff-seed',
  usagePolicy: 'single_use' as const,
  expiresAt: new Date(Date.now() + 24 * HOUR_MS).toISOString(),
  retentionDays: 30,
};

beforeEach(async () => {
  __resetReservationService();
  __resetCheckinService();
  await getBackend()
    .collection<{ id: string; scopedTokenHash: string }>(RESERVATION_COLLECTION, {
      indexedField: 'scopedTokenHash',
    })
    .reset();
});

describe('発行と照合が同じバックエンドを見る (#736)', () => {
  /**
   * 🔴 **これが本番のバグそのもの。** 別 repo だとここで `not_found` になる。
   */
  it('🔴 発行した予約を受付端末側の service が引ける', async () => {
    const issued = await getReservationService().create(ACTOR, INPUT);
    expect(issued.ok, '発行に失敗した').toBe(true);
    if (!issued.ok) return;

    const resolved = await getCheckinService().resolve(TENANT, SITE, issued.value.token);

    expect(resolved.ok, '発行した予約を受付端末から引けない（別バックエンド）').toBe(true);
  });

  /**
   * 🔴 境界は保たれていること。同じバックエンドを共有しても、他テナントからは引けない。
   */
  it('🔴 他テナントの受付端末からは引けない', async () => {
    const issued = await getReservationService().create(ACTOR, INPUT);
    if (!issued.ok) throw new Error('発行に失敗');

    const resolved = await getCheckinService().resolve(
      asTenantId('other-tenant'),
      SITE,
      issued.value.token,
    );

    expect(resolved.ok).toBe(false);
  });
});
