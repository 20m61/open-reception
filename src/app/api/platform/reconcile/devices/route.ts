import { NextResponse } from 'next/server';
import { elevatedWriteAuditMetadata } from '@/domain/auth/elevation';
import { assertElevated } from '@/lib/platform/request';
import { planDeviceReconciliation } from '@/lib/platform/device-reconciliation';
import { recordPlatformReadAudit } from '@/lib/platform/read-audit';

/**
 * POST /api/platform/reconcile/devices — 端末レジストリ整合の dry-run (issue #290 item2)。
 *
 * flat な kiosk レジストリ（#18）と Device レジストリ（#87・source-of-truth）の drift を検出し、
 * 「実行したら何が起きるか」（adopt / status 同期 / Device-only）をプランとして返す。**mutation は
 * 一切しない**（dry-run）。実際の修復は既存の adoptKiosk / syncKioskState（heartbeat / 管理操作起点）
 * が担い、本 API は昇格した総合開発者が事前に差分を確認するための preview。
 *
 * ガード（#290: 昇格必須 + 高重要度監査 + dry-run）:
 *   - JIT 昇格ゲート（assertElevated・platform 全体スコープ）。未昇格は 403 をそのまま返す。
 *   - 高重要度監査 platform.data_reconcile.previewed に **drift 件数のみ**記録（PII・端末名を残さない）。
 *     break-glass 昇格中は severity マークを付ける（elevatedWriteAuditMetadata）。
 *   - 監査失敗は伝播させる（未監査の preview を返さない・fail-closed。read-audit と同方針）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const gate = await assertElevated();
  if (!gate.ok) return gate.response;

  const plan = await planDeviceReconciliation();

  await recordPlatformReadAudit({
    action: 'platform.data_reconcile.previewed',
    identity: gate.elevation.sub,
    target: { type: 'device_registry' },
    metadata: {
      driftCount: plan.driftCount,
      adopt: plan.adopt.length,
      syncStatus: plan.syncStatus.length,
      deviceOnly: plan.deviceOnly.length,
      ...elevatedWriteAuditMetadata(gate.elevation),
    },
    request,
  });

  return NextResponse.json({ plan, dryRun: true });
}
