import { NextResponse } from 'next/server';
import { elevatedWriteAuditMetadata } from '@/domain/auth/elevation';
import type { AuditAction } from '@/domain/reception/log';
import {
  planUpdateExecution,
  resultingUpdateStatus,
  type UpdateAction,
} from '@/domain/platform/update-execution';
import { toUpdateStatusRow } from '@/domain/platform/update-status';
import { recordDangerAction } from '@/lib/admin/audit';
import { assertElevated } from '@/lib/platform/request';
import { getUpdateDeployer } from '@/lib/platform/update-deployer';
import { listUpdateStatuses, putUpdateStatus } from '@/lib/platform/update-status-store';

/**
 * POST /api/platform/updates/[id]/execute — テナント単位アップデートの実行/ロールバック (issue #290 item1)。
 *
 * body: `{ action: 'apply'|'rollback', toVersion?: string, reason?: string, dryRun?: boolean }`。
 *   - apply    … latestVersion へ更新（rollback は toVersion を明示）。
 *   - dryRun   … 変更せず実行プランのみ返す（監査は残す）。
 *   - reason   … 操作理由（500 字上限・監査へ）。
 *
 * ガード（#290: 昇格必須 + 高重要度監査 + dry-run 前提）:
 *   - JIT 昇格ゲート（assertElevated）。未昇格は 403。
 *   - 高重要度監査（platform.update.executed / .rolled_back）。metadata は component/from/to/dryRun/result
 *     のみで PII・秘匿値を残さない。break-glass 昇格中は severity マーク付与。audit-first + compensate。
 *
 * 実デプロイ本体は外部リソース待ち（#195/#65）。interface+mock 先行のため、実 deployer が未配線
 * （getUpdateDeployer=null）の間は **dry-run のみ利用可**で、実行要求は 503 deploy_unavailable を返す
 * （mock を本番実行に流用して fake 成功で状態を誤更新しない）。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const gate = await assertElevated();
  if (!gate.ok) return gate.response;
  const { id } = await params;

  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const action = body.action;
  if (action !== 'apply' && action !== 'rollback') {
    return NextResponse.json(
      { error: 'invalid_input', message: 'action must be apply or rollback' },
      { status: 400 },
    );
  }
  const toVersion = typeof body.toVersion === 'string' ? body.toVersion : undefined;
  const dryRun = body.dryRun === true;
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) || undefined : undefined;

  const status = (await listUpdateStatuses()).find((s) => s.id === id);
  if (!status) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const planned = planUpdateExecution(status, action as UpdateAction, { toVersion });
  if (!planned.ok) {
    return NextResponse.json({ error: 'invalid_input', message: planned.error }, { status: 400 });
  }

  const operator = gate.elevation.sub;
  const actor = `platform:${operator}`;
  const auditAction: AuditAction =
    action === 'apply' ? 'platform.update.executed' : 'platform.update.rolled_back';
  const target = { type: 'update_status', id: status.id };
  const baseMeta = {
    action,
    component: planned.plan.component,
    fromVersion: planned.plan.fromVersion,
    toVersion: planned.plan.toVersion,
    dryRun,
    ...elevatedWriteAuditMetadata(gate.elevation),
  };

  // dry-run: 変更せずプランを返す（監査は残す）。
  if (dryRun) {
    await recordDangerAction({ action: auditAction, target, reason, metadata: { ...baseMeta, result: 'dry_run' }, actor, request });
    return NextResponse.json({ plan: planned.plan, dryRun: true });
  }

  // 実 deployer 未配線（外部待ち #195/#65）は 503。mock を本番実行に流用しない。
  const deployer = getUpdateDeployer();
  if (!deployer) {
    await recordDangerAction({ action: auditAction, target, reason, metadata: { ...baseMeta, result: 'deploy_unavailable' }, actor, request });
    return NextResponse.json(
      { error: 'deploy_unavailable', message: 'real deploy is pending external resources (#195/#65); dry-run only' },
      { status: 503 },
    );
  }

  // audit-first: 実デプロイ（外部副作用）の前に開始を記録する（未監査のデプロイ/状態変更を残さない）。
  await recordDangerAction({ action: auditAction, target, reason, metadata: { ...baseMeta, result: 'initiated' }, actor, request });

  const outcome = await deployer.deploy({
    id: status.id,
    component: planned.plan.component,
    action: action as UpdateAction,
    toVersion: planned.plan.toVersion,
  });
  const next = resultingUpdateStatus(status, planned.plan, outcome, { now: new Date(), operator });

  try {
    await putUpdateStatus(next);
  } catch {
    await recordDangerAction({ action: auditAction, target, metadata: { ...baseMeta, result: 'store_failed' }, actor, request });
    return NextResponse.json({ error: 'store_failed' }, { status: 500 });
  }
  // 実行結果（成功/失敗）を記録する。
  await recordDangerAction({
    action: auditAction,
    target,
    metadata: { ...baseMeta, result: outcome.ok ? 'succeeded' : 'failed' },
    actor,
    request,
  });
  return NextResponse.json({ status: toUpdateStatusRow(next), result: { ok: outcome.ok } });
}
