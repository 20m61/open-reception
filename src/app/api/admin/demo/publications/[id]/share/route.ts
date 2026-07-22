import { NextResponse } from 'next/server';
import {
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { getDemoPublication, saveDemoPublication } from '@/domain/demo-studio/publication-store';
import { issueShareToken, revokeShareToken } from '@/domain/demo-studio/share-token';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST   /api/admin/demo/publications/:id/share — 公開（認証なし閲覧）共有トークンを発行する。
 * DELETE /api/admin/demo/publications/:id/share — 共有トークンを失効させる。
 * (issue #363 Increment 3・公開モデル)
 *
 * 認可（#91）: requireActor + assertCanWrite（viewer 不可）。
 *   - 発行は **published** な publication のみ許可（draft/test は公開リンクを作らせない, 422）。
 *     TTL は任意（ms・上限 DEMO_SHARE_MAX_TTL_MS にクランプ。無期限は作れない）。
 *   - トークンは高エントロピー・PII なし（`share-token.ts`）。発行/失効の**事実**を監査に残す
 *     （トークン値そのものは監査に残さない — SENSITIVE_KEY 'token' で redact される前提だが、
 *      そもそも metadata へ渡さない）。
 *
 * レスポンスはトークン値と有効期限を返す（管理者が共有 URL を組み立てるため）。公開 URL は
 * `/demo/<token>`（本 PR の公開ページ）。
 */
export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const { id } = await params;
  const pub = await getDemoPublication(id);
  if (!pub) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (pub.status !== 'published') {
    // 公開リンクは本番公開済みにのみ発行する（下書き/テストの誤共有防止）。
    return NextResponse.json({ error: 'not_published' }, { status: 422 });
  }

  let ttlMs: number | undefined;
  try {
    const body: unknown = await request.json();
    const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).ttlMs : undefined;
    if (typeof raw === 'number' && Number.isFinite(raw)) ttlMs = raw;
  } catch {
    // body 省略可（既定 TTL）。
  }

  const share = issueShareToken(Date.now(), ttlMs);
  await saveDemoPublication({ ...pub, share, updatedAt: new Date().toISOString() });
  await appendAdminAudit(
    'reception.demo_scenario_saved',
    { type: 'demo_publication', id: pub.id },
    { event: 'share_issued', scenarioId: pub.scenarioId, expiresAt: share.expiresAt },
  );
  return NextResponse.json({ token: share.token, issuedAt: share.issuedAt, expiresAt: share.expiresAt }, { status: 201 });
}

export async function DELETE(_request: Request, { params }: Ctx): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const { id } = await params;
  const pub = await getDemoPublication(id);
  if (!pub) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!pub.share) return NextResponse.json({ error: 'no_share' }, { status: 404 });

  const revoked = revokeShareToken(pub.share, Date.now());
  await saveDemoPublication({ ...pub, share: revoked, updatedAt: new Date().toISOString() });
  await appendAdminAudit(
    'reception.demo_scenario_saved',
    { type: 'demo_publication', id: pub.id },
    { event: 'share_revoked', scenarioId: pub.scenarioId },
  );
  return NextResponse.json({ ok: true });
}
