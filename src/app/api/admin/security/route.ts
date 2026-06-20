import { NextResponse } from 'next/server';
import { asTenantId } from '@/domain/tenant/types';
import { getSecuritySettings, updateSecuritySettings } from '@/lib/security/security-store';
import { readJson } from '@/lib/mock-backend/result-http';
import {
  assertCanRead,
  assertCanWrite,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { recordDangerAction } from '@/lib/admin/audit';
import { buildActorConfig } from '@/lib/auth/actor';

/**
 * GET /api/admin/security — セキュリティ設定の取得 (issue #23, #29)。
 * PIN 値そのものは返さず、設定済みかどうかのみ返す。
 * PUT /api/admin/security — 設定の更新（緊急停止を含むガバナンス系の危険操作）。
 *
 * 認可（#91 適用例）: middleware の入口ガードに加え、route 側で実 actor を解決し
 * `requireActor` / `assertCanWrite` で **最終認可** を行う（フロントで隠した操作でも 403）。
 * 監査（#91）: 更新は `recordDangerAction` で記録する。PIN 値などの機微値は残さない。
 */

/** セキュリティ設定はテナント既定スコープで扱う（単一テナント運用の既定）。 */
function securityTenantId() {
  return asTenantId(buildActorConfig().defaultTenantId);
}

export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, securityTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const s = await getSecuritySettings();
  return NextResponse.json({
    pinRequired: s.pinRequired,
    ipAllowlist: s.ipAllowlist,
    pinConfigured: s.pin !== '',
    emergencyStop: s.emergencyStop,
  });
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, securityTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const updated = await updateSecuritySettings(await readJson(request));
  // 既存 AuditAction（security.updated）を使用。機微値（PIN）は metadata に残さない。
  await recordDangerAction({
    action: 'security.updated',
    target: { type: 'security' },
    metadata: {
      pinRequired: updated.pinRequired,
      emergencyStop: updated.emergencyStop,
    },
  });
  return NextResponse.json({
    pinRequired: updated.pinRequired,
    ipAllowlist: updated.ipAllowlist,
    pinConfigured: updated.pin !== '',
    emergencyStop: updated.emergencyStop,
  });
}
