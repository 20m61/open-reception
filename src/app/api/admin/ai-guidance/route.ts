import { NextResponse } from 'next/server';
import { getAiGuidanceConfig, updateAiGuidanceConfig } from '@/lib/ai-guidance/config-store';
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
 * GET/PUT /api/admin/ai-guidance — AI 案内の運用設定（有効/無効・許可トピック）(issue #104)。
 *
 * 認可（#91）: route 側で実 actor を解決し `requireActor` + `assertCanRead/Write` で最終認可する。
 * 監査: 設定更新を ai_guidance.config_updated で記録（PII なし・件数/有効状態のみ）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json(await getAiGuidanceConfig());
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const updated = await updateAiGuidanceConfig(await readJson(request));
  await appendAdminAudit('ai_guidance.config_updated', { type: 'ai_guidance' }, {
    enabled: String(updated.enabled),
    topicCount: String(updated.allowedTopics.length),
  });
  return NextResponse.json(updated);
}
