import { NextResponse } from 'next/server';
import { cancelReception, getReception } from '@/lib/data-stores/reception-store';
import { toResponse } from '@/lib/data-stores/http';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';
import { hangUpIfRinging } from '@/lib/routing/hang-up';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';

/**
 * POST /api/kiosk/receptions/:id/cancel — 来訪者によるキャンセル (issue #16 / #743)。
 *
 * ## 呼び出し中のキャンセルは取次も止める (#743)
 *
 * 受付が `cancelled` で終端すれば、以降の hop は `decideRoutingStop` に弾かれる。
 * ただし**既に鳴り始めた通話はそのまま鳴り続ける**（呼出予算が経過するまで）ので、
 * 切断要求も出す ── 担当者が出た先に来訪者は居ない「無人の呼び出し」を作らない。
 *
 * 🔴 **受付を止めてから切る。** 逆順にすると、切断の `completed` webhook が受付の
 * `'calling'` 中に届き、取次が「次の手へ進む」と判断しうる（`/give-up` と同じ順序）。
 *
 * 🔴 **切断は best-effort。応答を変えない。** ここが失敗しても来訪者にできることは無く、
 * 通話は呼出予算で自然に終わる。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await denyWithoutKioskSession();
  if (denied) return denied;
  const { id } = await params;

  // 切る相手は**キャンセルする前**に読む（終端後は付け替えを追えない）。
  const before = await getReception(id);
  const providerCallId = before.ok ? before.value.providerCallId : undefined;

  const result = await cancelReception(id);

  // 実際に自分がキャンセルできたときだけ切る。既に終端していた受付
  // （担当者が応答した直後など）の通話を切らない。
  if (result.ok) {
    await hangUpIfRinging(String(resolveDefaultScope().tenantId), providerCallId).catch(
      () => undefined,
    );
  }
  return toResponse(result);
}
