import { NextResponse } from 'next/server';
import {
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { resolveDemoScenario } from '@/domain/demo-studio/store';

/**
 * POST /api/admin/demo/run — 受付体験スタジオでデモ実行を記録する (issue #363 Increment 1)。
 *
 * デモ自体（Mock Adapter 注入・本番 Kiosk のプレビュー）はブラウザの iframe 内で完結し、本番 API・
 * Vonage 発信・本番集計へは一切到達しない（`src/domain/demo-studio/sandbox.ts`）。本ルートは
 * その**実行事実だけ**を監査ログに残す（issue #363 AC「管理者のデモ実行は監査ログに残る」）。
 *
 * 認可（#91 / rules/admin-api-authz.md）: requireActor + assertCanWrite。受付体験スタジオは
 * テナント管理者向けの体験設定ツール（ADMIN_NAV の experience グループ）なので書込権を要求する。
 * viewer は 403。監査 metadata は scenarioId・initialMode（列挙）のみで PII を残さない。
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }

  const scenarioId =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).scenarioId
      : undefined;
  if (typeof scenarioId !== 'string') {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }
  // 解決順は 保存済み→組込 (issue #363 Inc2)。カスタムシナリオのデモ実行も記録できる。
  const scenario = await resolveDemoScenario(scenarioId);
  if (!scenario) {
    // 未知のシナリオ id は記録しない（任意文字列を監査へ流し込ませない）。
    return NextResponse.json({ error: 'unknown_scenario' }, { status: 400 });
  }

  await appendAdminAudit(
    'reception.demo_executed',
    { type: 'demo', id: scenario.id },
    { scenarioId: scenario.id, initialMode: scenario.initialMode },
  );

  return NextResponse.json({ ok: true });
}
