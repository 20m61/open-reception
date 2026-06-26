import { NextResponse } from 'next/server';
import { getBrandingSettings, updateBrandingSettings } from '@/lib/branding/branding-store';
import { readJson } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';
import {
  assertCanRead,
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * GET/PUT /api/admin/branding — ブランディング設定の取得・更新 (issue #88)。
 *
 * 認可（#91）: route 側で実 actor を解決し `requireActor` + `assertCanRead/Write` で最終認可する。
 * 監査（#105）: ロゴ data URI 本体は記録しない（設定有無のみ）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json(await getBrandingSettings());
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const updated = await updateBrandingSettings(await readJson(request));
  await appendAdminAudit('branding.updated', { type: 'branding' }, {
    hasLogo: String(Boolean(updated.logoUrl)),
    hasAccent: String(Boolean(updated.accentColor)),
  });
  return NextResponse.json(updated);
}
