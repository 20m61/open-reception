import { NextResponse } from 'next/server';
import { getBrandingSettings, updateBrandingSettings } from '@/lib/branding/branding-store';
import { readJson } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import {
  assertCanRead,
  assertCanWrite,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';
import { asTenantId } from '@/domain/tenant/types';

/**
 * GET/PUT /api/admin/branding — ブランディング設定の取得・更新 (issue #88)。
 *
 * 認可（#91）: route 側で実 actor を解決し `requireActor` + `assertCanRead/Write` で最終認可する。
 * 監査（#105）: ロゴ data URI 本体は記録しない（設定有無のみ）。
 *
 * **対象テナントは選択中テナント** (#419 残増分)。以前は `defaultAdminTenantId()` 固定で、
 * ストアもテナント次元を持たなかったため、テナントを切り替えても同じブランディングを
 * 編集していた。**対象はサーバ側の認可済みコンテキストから導出**し、リクエスト body /
 * query の値は使わない（越境参照名を組ませない。`rules/pii-secret-minimization.md`）。
 */
export async function GET(): Promise<NextResponse> {
  let tenantId: string;
  try {
    const actor = await requireActor();
    tenantId = await resolveAdminTenantId();
    assertCanRead(actor, asTenantId(tenantId));
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json(await getBrandingSettings(tenantId));
}

export async function PUT(request: Request): Promise<NextResponse> {
  let tenantId: string;
  try {
    const actor = await requireActor();
    tenantId = await resolveAdminTenantId();
    assertCanWrite(actor, asTenantId(tenantId));
  } catch (err) {
    return toGuardResponse(err);
  }
  const updated = await updateBrandingSettings(tenantId, await readJson(request));
  await appendAdminAudit('branding.updated', { type: 'branding' }, {
    hasLogo: String(Boolean(updated.logoUrl)),
    hasAccent: String(Boolean(updated.accentColor)),
  });
  return NextResponse.json(updated);
}
