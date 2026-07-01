/**
 * platform 破壊的「登録」write の共通ハンドラ (issue #83 inc4c)。
 *
 * incident / maintenance など複数の登録 write が同じ不変条件を持つため、ここに集約する:
 *   1. JIT 昇格ゲート（assertElevated・platform 全体スコープ）。
 *   2. JSON parse（失敗は空扱い）→ build で検証（不正は 400 invalid_input）。
 *   3. reason は 500 字上限（sanitize 対象外の operator 記述の貼付＝PII/secret・肥大を抑制）。
 *   4. **audit-first**: 監査を先に記録してから確定（audit 失敗時に未監査の変更を残さない）。
 *   5. **補償**: 確定（create）失敗時は store_failed を追記監査して 500（phantom 監査を明示・跡を残す）。
 *   6. 201 で whitelist 射影のみ返す（updatedBy/createdBy 等の操作者識別子は載せない）。
 *
 * 分岐する箇所（build/create/action/射影）だけを opts で受け取り、不変条件は一箇所に閉じる。
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { AuditAction } from '@/domain/reception/log';
import { recordDangerAction } from '@/lib/admin/audit';
import { assertElevated } from '@/lib/platform/request';
import { getTenantStore } from '@/lib/tenant/store';
import { asTenantId, asSiteId, asDeviceId } from '@/domain/tenant/types';

type BuildResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** スコープ対象の型（登録レコードが共通で持つ）。 */
type Scoped = { scope: string; tenantId?: string; siteId?: string; deviceId?: string };

/**
 * スコープ id が示す tenant/site/device が**実在**するか検証する (issue #268)。存在しなければエラー文字列。
 * presence 検証（buildX）だけでは typo の tenantId が通り、対象に届かない不可視レコードを作り得るため。
 */
async function assertScopeExists(v: Scoped): Promise<string | null> {
  if (v.scope === 'platform') return null;
  // build の presence 検証に依存せず防御的に確認（undefined id で store を叩かない）。
  if (!v.tenantId) return 'tenantId required for this scope';
  const store = getTenantStore();
  const tenantId = asTenantId(v.tenantId);
  if (!(await store.tenants.getTenant(tenantId))) return 'tenant not found';
  if (v.scope === 'site' || v.scope === 'device') {
    if (!v.siteId) return 'siteId required for this scope';
    if (!(await store.sites.getSite(tenantId, asSiteId(v.siteId)))) return 'site not found';
  }
  if (v.scope === 'device') {
    if (!v.deviceId) return 'deviceId required for this scope';
    const device = await store.devices.getDevice(tenantId, asDeviceId(v.deviceId));
    if (!device) return 'device not found';
    // getDevice は tenant 境界のみ。device が指定 site 配下かも確認（不整合な site/device を弾く）。
    if (String(device.siteId) !== v.siteId) return 'device does not belong to the site';
  }
  return null;
}

export async function handlePlatformDangerCreate<In, T extends { id: string } & Scoped>(
  request: Request,
  opts: {
    // ctx.operator = 昇格した操作者 identity（記録の updatedBy/createdBy に使う, #264）。
    build: (input: In, ctx: { id: string; now: Date; operator: string }) => BuildResult<T>;
    create: (value: T) => Promise<void>;
    action: AuditAction;
    targetType: string;
    metadataOf: (value: T) => Record<string, unknown>;
    project: (value: T) => Record<string, unknown>;
    responseKey: string;
  },
): Promise<NextResponse> {
  const gate = await assertElevated();
  if (!gate.ok) return gate.response;
  const operator = gate.elevation.sub; // 昇格した操作者 identity。
  const actor = `platform:${operator}`; // 監査 actor（#264）。

  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const built = opts.build(body as In, { id: randomUUID(), now: new Date(), operator });
  if (!built.ok) {
    return NextResponse.json({ error: 'invalid_input', message: built.error }, { status: 400 });
  }

  // スコープ対象の実在検証（typo の tenant/site/device による不可視レコードを防ぐ, #268）。
  // tenant-store の一時障害は unhandled にせず 500 で返す（監査/変更はまだ無いので補償不要）。
  let scopeErr: string | null;
  try {
    scopeErr = await assertScopeExists(built.value);
  } catch {
    return NextResponse.json({ error: 'scope_check_failed' }, { status: 500 });
  }
  if (scopeErr) {
    return NextResponse.json({ error: 'invalid_input', message: scopeErr }, { status: 400 });
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined;
  const target = { type: opts.targetType, id: built.value.id };
  await recordDangerAction({
    action: opts.action,
    target,
    reason: reason || undefined,
    metadata: opts.metadataOf(built.value),
    actor,
    request,
  });

  try {
    await opts.create(built.value);
  } catch {
    // 補償: 確定に失敗したことを監査に残す（先の「登録」監査と store の乖離を明示）。
    await recordDangerAction({
      action: opts.action,
      target,
      metadata: { result: 'store_failed' },
      actor,
      request,
    });
    return NextResponse.json({ error: 'store_failed' }, { status: 500 });
  }

  return NextResponse.json({ [opts.responseKey]: opts.project(built.value) }, { status: 201 });
}
