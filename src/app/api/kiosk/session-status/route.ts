import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSecuritySettings } from '@/lib/security/security-store';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';

/**
 * GET /api/kiosk/session-status — 受付端末の許可状態 (issue #23)。
 * pinRequired と、長期 kiosk session を保持済みかどうかを返す。
 */
export async function GET(): Promise<NextResponse> {
  const settings = getSecuritySettings();
  const token = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = await readKioskSession(token);
  return NextResponse.json({ pinRequired: settings.pinRequired, authorized: session !== null });
}
