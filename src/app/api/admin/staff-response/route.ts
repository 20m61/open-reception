import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { isStaffResponseAction } from '@/domain/reception/staff-response';
import { getStaffResponseConfigService } from '@/lib/reception/staff-response-config/store';
import {
  configResponse,
  readConfigScope,
  resolveAdminActor,
} from '@/lib/reception/staff-response-config/request';
import type { StaffResponseOverridePatch } from '@/lib/reception/staff-response-config/types';

/**
 * GET   /api/admin/staff-response?tenantId=&siteId= — 応答アクション設定一覧 (issue #99 inc2)。
 * PATCH /api/admin/staff-response                   — 1 応答種別の有効無効・文言上書きを更新。
 *
 * 認証: 管理セッション必須（無効なら 401）。
 * 認可: #80 の canAccessSite 純関数で tenantId/siteId 境界・read/write 権限を判定する
 *       （viewer 書込不可・他テナント越境拒否）。service 層で適用。
 * 監査: 本増分では設定変更を監査しない（新規 AuditAction を追加しない方針）。PII は扱わない。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readConfigScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const result = await getStaffResponseConfigService().getView(actor, scope.tenantId, scope.siteId);
  return configResponse(result);
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readConfigScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });

  const o = (body ?? {}) as Record<string, unknown>;
  if (!isStaffResponseAction(o.action))
    return NextResponse.json({ error: 'invalid_input', message: 'unknown response action' }, { status: 400 });

  const patch: StaffResponseOverridePatch = { action: o.action };
  if (typeof o.enabled === 'boolean') patch.enabled = o.enabled;
  // messageOverride: 文字列で上書き、null で解除、未指定で据え置き。
  if ('messageOverride' in o) {
    const m = o.messageOverride;
    if (m === null || typeof m === 'string') patch.messageOverride = m;
    else
      return NextResponse.json(
        { error: 'invalid_input', message: 'messageOverride must be a string or null' },
        { status: 400 },
      );
  }

  const result = await getStaffResponseConfigService().updateAction(
    actor,
    scope.tenantId,
    scope.siteId,
    patch,
  );
  return configResponse(result);
}
