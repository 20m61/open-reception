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

type BuildResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function handlePlatformDangerCreate<In, T extends { id: string }>(
  request: Request,
  opts: {
    build: (input: In, ctx: { id: string; now: Date }) => BuildResult<T>;
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
  const actor = `platform:${gate.elevation.sub}`; // 昇格した操作者を監査 actor に（#264）。

  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const built = opts.build(body as In, { id: randomUUID(), now: new Date() });
  if (!built.ok) {
    return NextResponse.json({ error: 'invalid_input', message: built.error }, { status: 400 });
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
