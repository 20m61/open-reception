import { NextResponse } from 'next/server';
import { asTenantId } from '@/domain/tenant/types';
import { getTenantStore } from '@/lib/tenant/store';
import {
  applyFeatureFlagChanges,
  effectiveTenantFeatureFlags,
  parseFeatureFlagChanges,
} from '@/domain/platform/feature-flags';
import { elevatedWriteAuditMetadata } from '@/domain/auth/elevation';
import { authorizePlatform, assertElevated } from '@/lib/platform/request';
import { recordDangerAction } from '@/lib/admin/audit';
import {
  getTenantFeatureFlagRecord,
  putTenantFeatureFlagRecord,
} from '@/lib/platform/feature-flag-store';
import { readJson } from '@/lib/data-stores/result-http';

/**
 * GET /api/platform/tenants/[tenantId]/feature-flags — テナント別機能フラグの実効値 (issue #83 inc5a)。
 *
 * developer 専用 read。上書きレコードが無いテナントは既定値（全機能有効）を返す。
 * 機微値・PII は含めない（フラグの真偽と更新日時のみ）。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。存在しないテナントは 404。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const { tenantId: raw } = await params;
  const tenant = await getTenantStore().tenants.getTenant(asTenantId(raw));
  if (!tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const record = await getTenantFeatureFlagRecord(raw);
  return NextResponse.json({
    tenantId: tenant.id,
    flags: effectiveTenantFeatureFlags(record),
    updatedAt: record?.updatedAt,
  });
}

/**
 * PATCH /api/platform/tenants/[tenantId]/feature-flags — 機能フラグの変更 (issue #83 inc5a)。
 *
 * 「機能制限の変更」は昇格必須の破壊的操作（#83 §1）。body は
 * `{ flags: { <flagKey>: boolean }, reason?: string }`。不変条件:
 *   1. JIT 昇格ゲート（assertElevated({tenantId})・対象テナントを覆う昇格が要る, #83 AC5/AC10）。
 *   2. 入力検証（未知キー・非 boolean・空は 400。typo フラグを作らない）。
 *   3. テナント実在チェック（存在しない tenantId への write を拒否, #268 の型）。
 *   4. no-op（実効値が変わらない）は保存も監査もしない（監査ノイズを避ける）。
 *   5. **audit-first**: 監査（feature_flag.updated, before/after つき, #83 AC13）を先に記録してから
 *      永続化。保存失敗時は store_failed を追記監査して 500（phantom 監査を明示・跡を残す）。
 *   6. break-glass 中は elevatedWriteAuditMetadata が高重要度マークを付ける（#83 §3）。
 *
 * フラグの enforcement（無効テナントで実際に機能を止める）は後続増分で各機能側に接続する。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  const { tenantId: raw } = await params;
  const gate = await assertElevated({ tenantId: raw });
  if (!gate.ok) return gate.response;

  const body = (await readJson(request)) as { flags?: unknown; reason?: unknown } | null;
  const parsed = parseFeatureFlagChanges(body?.flags);
  if (!parsed.ok) {
    return NextResponse.json({ error: 'invalid_input', message: parsed.error }, { status: 400 });
  }

  const tenantId = asTenantId(raw);
  const tenant = await getTenantStore().tenants.getTenant(tenantId);
  if (!tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const operator = gate.elevation.sub; // 昇格した操作者 identity（#264 帰属）。
  const actor = `platform:${operator}`;
  const current = await getTenantFeatureFlagRecord(raw);
  const applied = applyFeatureFlagChanges(current, parsed.changes, {
    tenantId: String(tenant.id),
    now: new Date(),
    operator,
  });

  // no-op は保存も監査もせず現状を返す（連打・再送で監査を汚さない）。
  if (applied.changedKeys.length === 0) {
    return NextResponse.json({
      tenantId: tenant.id,
      flags: effectiveTenantFeatureFlags(current),
      updatedAt: current?.updatedAt,
    });
  }

  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined;
  const target = { type: 'tenant', id: String(tenant.id) };
  // break-glass 中の write は高重要度マーク（#83 §3）。通常昇格は {}。
  const severityMeta = elevatedWriteAuditMetadata(gate.elevation);
  await recordDangerAction({
    action: 'feature_flag.updated',
    target,
    reason: reason || undefined,
    metadata: { keys: applied.changedKeys.join(','), ...severityMeta },
    before: applied.before,
    after: applied.after,
    actor,
    request,
  });

  try {
    await putTenantFeatureFlagRecord(applied.next);
  } catch {
    // 補償: 確定に失敗したことを監査に残す（先の変更監査と store の乖離を明示）。
    await recordDangerAction({
      action: 'feature_flag.updated',
      target,
      metadata: { result: 'store_failed', ...severityMeta },
      actor,
      request,
    });
    return NextResponse.json({ error: 'store_failed' }, { status: 500 });
  }

  return NextResponse.json({
    tenantId: tenant.id,
    flags: effectiveTenantFeatureFlags(applied.next),
    updatedAt: applied.next.updatedAt,
  });
}
