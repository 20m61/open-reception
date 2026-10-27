import { NextResponse } from 'next/server';
import { getSecuritySettings } from '@/lib/security/security-store';
import { requireKioskSession } from '@/lib/kiosk/session-guard';

/**
 * GET /api/kiosk/session-status — 受付端末の許可状態 (issue #23)。
 * pinRequired と、長期 kiosk session を保持済みかどうかを返す。
 */
export async function GET(): Promise<NextResponse> {
  const settings = await getSecuritySettings();
  // 失効・未登録端末の cookie は「保持していない」と同じに扱う（共通ガード）。
  const session = await requireKioskSession();
  return NextResponse.json({ pinRequired: settings.pinRequired, authorized: session !== null });
}
