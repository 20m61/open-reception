import { NextResponse } from 'next/server';
import { createKiosk, listKiosks } from '@/lib/kiosk/kiosk-store';
import { syncKioskToDevice } from '@/lib/kiosk/device-sync';
import { readJson, resultResponse } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import {
  assertCanRead,
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * GET /api/admin/kiosks — 受付端末一覧 (issue #18)。
 * POST /api/admin/kiosks — 受付端末を登録。
 *
 * 認可（#91 inc2）: route 側で実 actor を解決し `requireActor` + `assertCanRead/Write`
 * で最終認可を行う（フロントで隠した操作でも 403）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json({ items: await listKiosks() });
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const result = await createKiosk(await readJson(request));
  if (result.ok) {
    await appendAdminAudit('kiosk.created', { type: 'kiosk', id: result.value.id });
    // Device レジストリへ即時写像（#284 inc1 逆方向同期・best-effort）。
    await syncKioskToDevice(result.value);
  }
  return resultResponse(result, 201);
}
