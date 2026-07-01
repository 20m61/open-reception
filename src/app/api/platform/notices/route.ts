import { NextResponse } from 'next/server';
import { buildNotice, type Notice, type NoticeInput } from '@/domain/platform/notice';
import { createNotice } from '@/lib/platform/notice-store';
import { handlePlatformDangerCreate } from '@/lib/platform/danger-create';

/**
 * POST /api/platform/notices — お知らせの登録 (issue #83 お知らせ / inc4c)。
 *
 * developer の**破壊的操作**。共有ハンドラ handlePlatformDangerCreate が JIT 昇格（assertElevated）・
 * 理由つき監査（audit-first + 補償）・whitelist 射影の不変条件を担保する。登録 status は 'published' 固定。
 * title/body は PII/機密を書かない運用（横断 read 行に createdBy は載せない）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  return handlePlatformDangerCreate<NoticeInput, Notice>(request, {
    build: (input, ctx) => buildNotice(input, { id: ctx.id, now: ctx.now, createdBy: ctx.operator }),
    create: createNotice,
    action: 'platform.notice.published',
    targetType: 'notice',
    metadataOf: (v) => ({ scope: v.scope, level: v.level, status: v.status }),
    project: (v) => ({ id: v.id, scope: v.scope, level: v.level, status: v.status, title: v.title, publishedAt: v.publishedAt }),
    responseKey: 'notice',
  });
}
