import { NextResponse } from 'next/server';
import { getSecuritySettings, updateSecuritySettings } from '@/lib/security/security-store';
import { readJson } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * GET /api/admin/security — セキュリティ設定の取得 (issue #23, #29)。
 * PIN 値そのものは返さず、設定済みかどうかのみ返す。
 * PUT /api/admin/security — 設定の更新。
 *
 * NOTE: 認証・認可は middleware（#24）で付与済み。
 */
export async function GET(): Promise<NextResponse> {
  const s = await getSecuritySettings();
  return NextResponse.json({
    pinRequired: s.pinRequired,
    ipAllowlist: s.ipAllowlist,
    pinConfigured: s.pin !== '',
    emergencyStop: s.emergencyStop,
  });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const updated = await updateSecuritySettings(await readJson(request));
  await appendAdminAudit('security.updated', { type: 'security' }, {
    pinRequired: String(updated.pinRequired),
    emergencyStop: String(updated.emergencyStop),
  });
  return NextResponse.json({
    pinRequired: updated.pinRequired,
    ipAllowlist: updated.ipAllowlist,
    pinConfigured: updated.pin !== '',
    emergencyStop: updated.emergencyStop,
  });
}
