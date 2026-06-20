import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { asDeviceId, type DeviceKind } from '@/domain/tenant/types';
import { getDeviceService } from '@/lib/tenant/store';
import { readTenantScope, resolveAdminActor, serviceResponse } from '@/lib/tenant/request';
import type { UpdateDevicePatch } from '@/lib/tenant/device-service';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET   /api/admin/devices/:id?tenantId= — 単一端末取得 (issue #87 inc2)。
 * PATCH /api/admin/devices/:id           — 名称・設置場所・種別・メンテ表示の更新、
 *                                          および有効/無効切り替え（enabled の真偽）。
 *
 * 認証/認可/監査は service 層で #80 認可と PII なし監査を適用する。
 * token 平文は返却しない。
 */
const KINDS: readonly DeviceKind[] = ['kiosk', 'tablet', 'desktop'];

export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readTenantScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getDeviceService().get(actor, scope.tenantId, asDeviceId(id));
  return serviceResponse(result);
}

export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await readJson(request)) as Record<string, unknown> | null;
  const scope = readTenantScope(body ?? {});
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const deviceId = asDeviceId(id);
  const service = getDeviceService();

  // enabled が明示された場合は有効/無効切り替え（危険操作・監査つき）として扱う。
  if (typeof body?.enabled === 'boolean') {
    const result = await service.setEnabled(actor, scope.tenantId, deviceId, body.enabled);
    return serviceResponse(result);
  }

  const result = await service.update(actor, scope.tenantId, deviceId, parseUpdateBody(body));
  return serviceResponse(result);
}

/** 更新ボディを UpdateDevicePatch へ（指定されたフィールドのみ）。 */
function parseUpdateBody(body: unknown): UpdateDevicePatch {
  if (typeof body !== 'object' || body === null) return {};
  const o = body as Record<string, unknown>;
  const patch: UpdateDevicePatch = {};
  if (typeof o.name === 'string') patch.name = o.name;
  if (typeof o.location === 'string') patch.location = o.location;
  if (typeof o.kind === 'string' && (KINDS as readonly string[]).includes(o.kind))
    patch.kind = o.kind as DeviceKind;
  if (typeof o.maintenance === 'boolean') patch.maintenance = o.maintenance;
  return patch;
}
