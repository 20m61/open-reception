import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import {
  asReservationId,
  asReservationToken,
  type IssuedReservation,
  type VisitReservation,
} from '@/domain/reservation/types';
import { hashReservationToken } from '@/domain/reservation/token';
import { serviceResponse, toReservationView } from './request';
import type { ServiceResult } from './service';

/**
 * 予約応答から tokenHash を落とす view 変換 (issue #375 I1)。
 *
 * `tokenHash` は受付照合専用の内部値であり、admin API の応答（list/get/edit/cancel/revoke/
 * create/reissueToken）に露出させない。`ReservationService` 自体（`service.test.ts`）は
 * 引き続き `tokenHash` を含む `VisitReservation` を返す（内部利用・照合ロジックのため）。
 * ここでは HTTP 応答境界（`request.ts`）で確実に落ちることを固定する。
 */
const TOKEN = asReservationToken('reservation-plain-token');
const TOKEN_HASH = hashReservationToken(TOKEN);

function reservation(over: Partial<VisitReservation> = {}): VisitReservation {
  return {
    id: asReservationId('rsv-1'),
    tenantId: asTenantId('tenant-a'),
    siteId: asSiteId('site-1'),
    visitorName: '山田太郎',
    visitAt: '2026-06-20T01:00:00.000Z',
    targetType: 'staff',
    targetId: 'staff-1',
    tokenHash: TOKEN_HASH,
    usagePolicy: 'single_use',
    expiresAt: '2026-06-27T00:00:00.000Z',
    status: 'active',
    retentionDays: 30,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    ...over,
  };
}

describe('toReservationView (#375 I1: 予約応答の tokenHash 除去)', () => {
  it('tokenHash を除いた他フィールドをすべて保持する', () => {
    const r = reservation();
    const view = toReservationView(r);
    expect((view as Record<string, unknown>).tokenHash).toBeUndefined();
    expect(view.id).toBe(r.id);
    expect(view.visitorName).toBe(r.visitorName);
    expect(view.status).toBe(r.status);
  });

  it('IssuedReservation（token 付き）でも tokenHash だけを落とし token は残す', () => {
    const issued: IssuedReservation = { ...reservation(), token: TOKEN };
    const view = toReservationView(issued);
    expect((view as Record<string, unknown>).tokenHash).toBeUndefined();
    expect(view.token).toBe(TOKEN);
  });
});

describe('serviceResponse transform (#375 I1)', () => {
  async function bodyOf(res: Response): Promise<Record<string, unknown>> {
    return (await res.json()) as Record<string, unknown>;
  }

  it('transform 未指定時は従来どおり value をそのまま返す（後方互換）', async () => {
    const r = reservation();
    const result: ServiceResult<VisitReservation> = { ok: true, value: r };
    const res = serviceResponse(result);
    const body = await bodyOf(res);
    expect(body.tokenHash).toBeDefined();
  });

  it('transform=toReservationView で単一予約応答から tokenHash が消える', async () => {
    const r = reservation();
    const result: ServiceResult<VisitReservation> = { ok: true, value: r };
    const res = serviceResponse(result, 200, toReservationView);
    const body = await bodyOf(res);
    expect(body.tokenHash).toBeUndefined();
    expect(body.id).toBe(r.id);
  });

  it('一覧応答（配列）から tokenHash が消える', async () => {
    const list = [reservation({ id: asReservationId('rsv-1') }), reservation({ id: asReservationId('rsv-2') })];
    const result: ServiceResult<VisitReservation[]> = { ok: true, value: list };
    const res = serviceResponse(result, 200, (v) => v.map(toReservationView));
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    for (const item of body) {
      expect(item.tokenHash).toBeUndefined();
    }
  });

  it('error 応答は transform の有無に関わらずそのまま（tokenHash が無い error body）', async () => {
    const result: ServiceResult<VisitReservation> = {
      ok: false,
      error: { code: 'not_found', message: 'reservation not found' },
    };
    const res = serviceResponse<VisitReservation, Omit<VisitReservation, 'tokenHash'>>(
      result,
      200,
      toReservationView,
    );
    expect(res.status).toBe(404);
    const body = await bodyOf(res);
    expect(body.tokenHash).toBeUndefined();
    expect(body.error).toBe('not_found');
  });
});
