import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { getLanguageSettings, updateLanguageSettings } from '@/lib/i18n/language-settings';
import { assertCanRead, assertCanWrite, requireActor, toGuardResponse } from '@/lib/admin/guard';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';
import { asTenantId } from '@/domain/tenant/types';

/**
 * GET/PUT /api/admin/languages — 有効言語・既定言語の設定 (issue #103, increment 1)。
 *
 * **テナント別設定になった** (#419 残増分)。以前は「テナント横断の単一設定」で、
 * 認証（`requireActor`）だけを通し **`assertCanRead`/`assertCanWrite` を通していなかった**
 * — つまり viewer でも書き込めた。テナント別にするのに合わせて認可も他の admin ルートへ
 * 揃える（`rules/admin-api-authz.md`: 書込は viewer 不可）。
 *
 * 監査: 既存 'voice.updated'（i18n/voice 隣接）を再利用して PII なしで記録する
 *   （新規 AuditAction の追加は #103 increment 1 のスコープ外: log.ts は編集禁止）。
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
  return NextResponse.json(await getLanguageSettings(tenantId));
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
  const updated = await updateLanguageSettings(tenantId, await readJson(request));
  await appendAdminAudit('voice.updated', { type: 'language-settings' }, {
    enabledLocales: updated.enabledLocales.join(','),
    defaultLocale: updated.defaultLocale,
  });
  return NextResponse.json(updated);
}
