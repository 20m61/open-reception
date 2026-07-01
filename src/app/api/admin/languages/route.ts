import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { getLanguageSettings, updateLanguageSettings } from '@/lib/i18n/language-settings';
import { requireActor, toGuardResponse } from '@/lib/admin/guard';

/**
 * GET/PUT /api/admin/languages — 有効言語・既定言語の設定 (issue #103, increment 1)。
 *
 * 認証: 管理セッション必須（requireActor → 未認証は 401）。本設定はテナント横断の単一
 *   設定（voice 設定と同じ singleton）であり、actor 解決により認可境界を通す。
 * 監査: 既存 'voice.updated'（i18n/voice 隣接）を再利用して PII なしで記録する
 *   （新規 AuditAction の追加は #103 increment 1 のスコープ外: log.ts は編集禁止）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    await requireActor();
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json(await getLanguageSettings());
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    await requireActor();
  } catch (err) {
    return toGuardResponse(err);
  }
  const updated = await updateLanguageSettings(await readJson(request));
  await appendAdminAudit('voice.updated', { type: 'language-settings' }, {
    enabledLocales: updated.enabledLocales.join(','),
    defaultLocale: updated.defaultLocale,
  });
  return NextResponse.json(updated);
}
