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
//
// 🔴 **落ちたことより、隣が空虚に通っていたことのほうが重い。** 期限切れの予約は
// **テナントに関係なく** `resolve` が失敗するので、下の「他テナントからは引けない」は
// **境界が壊れていても緑**だった。境界を外す変異（索引 key を発行側テナントで固定し
// `inBounds` を削る）を当てると、期限切れ fixture では **SURVIVED**、相対時刻では
// **KILLED** になることを実測した。だから下のテストには**下界**を足してある。
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

    // 🔴 **下界を先に縛る (#833)。** 「引けない」だけを主張する assertion は、期限切れのように
    // **全部が失敗する**世界でも通ってしまう。正しいテナントからは引けることを先に確かめ、
    // 下の失敗が**境界に由来する**ことを保証する（`resolve` は閲覧のみで使用済み化しない）。
    const sameTenant = await getCheckinService().resolve(TENANT, SITE, issued.value.token);
    expect(sameTenant.ok, '正しいテナントからも引けない ── 境界以外の理由で失敗している').toBe(true);

    const resolved = await getCheckinService().resolve(
      asTenantId('other-tenant'),
      SITE,
      issued.value.token,
    );

    expect(resolved.ok).toBe(false);
  });
});

/**
 * 保存期間 (#1022) が**本番の配線**（`getReservationService()` / `getCheckinService()` の
 * singleton）に効いていること。repository 単体のテストだけでは、配線がこの repository を
 * 通らなくなっても気づけない。
 *
 * 判定の下界も併せて縛る: 期限内（有効期限は切れているが保存期間内）の予約は管理画面から
 * 読め、受付端末では「期限切れ」として扱われる（＝見つかってはいる）。保存期間を過ぎると、
 * どちらからも**存在しない**扱いになる。
 */
describe('予約の保存期間が本番の配線に効く (#1022)', () => {
  const DAY_MS = 24 * HOUR_MS;

  /** 発行した予約の来訪日時を過去へずらす（来訪の終わり = now - endAgoMs）。 */
  async function issueEndedAgo(endAgoMs: number) {
    const issued = await getReservationService().create(ACTOR, INPUT);
    if (!issued.ok) throw new Error('発行に失敗');
    const col = getBackend().collection<{ id: string; scopedTokenHash: string }>(
      RESERVATION_COLLECTION,
      { indexedField: 'scopedTokenHash' },
    );
    const stored = (await col.get(issued.value.id))!;
    const end = new Date(Date.now() - endAgoMs).toISOString();
    await col.put({ ...stored, visitAt: end, expiresAt: end } as typeof stored);
    return issued.value;
  }

  it('保存期間内（有効期限切れ）は管理画面から読め、受付端末では期限切れとして見つかる', async () => {
    const r = await issueEndedAgo(INPUT.retentionDays * DAY_MS - HOUR_MS);
    const got = await getReservationService().get(ACTOR, TENANT, SITE, r.id);
    expect(got.ok).toBe(true);
    const listed = await getReservationService().list(ACTOR, TENANT, SITE);
    expect(listed.ok && listed.value.some((x) => x.id === r.id)).toBe(true);
    const resolved = await getCheckinService().resolve(TENANT, SITE, r.token);
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.reason).not.toBe('not_found');
  });

  it('🔴 保存期間を過ぎた予約は管理画面からも受付端末からも存在しない扱いになる', async () => {
    const r = await issueEndedAgo(INPUT.retentionDays * DAY_MS + HOUR_MS);
    const got = await getReservationService().get(ACTOR, TENANT, SITE, r.id);
    expect(got.ok).toBe(false);
    const listed = await getReservationService().list(ACTOR, TENANT, SITE);
    expect(listed.ok && listed.value.some((x) => x.id === r.id)).toBe(false);
    const resolved = await getCheckinService().resolve(TENANT, SITE, r.token);
    expect(!resolved.ok && resolved.reason).toBe('not_found');
  });
});
