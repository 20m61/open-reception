/**
 * 受付端末（kiosk）セッション (issue #23)。
 * 初回許可後は長期間維持し、リロード/再起動後も受付画面に復帰できる。
 * kiosk セッションは role='kiosk' であり、管理 API（role='admin' 必須）には使えない。
 */
import { signSession, verifySession } from './session';
import { serverSecret } from './server-secret';

export const KIOSK_COOKIE = 'kiosk_session';
/** 長期保持（30 日）。失効は端末レジストリ（#18）で制御する。 */
export const KIOSK_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export function getKioskSecret(): string {
  return serverSecret('KIOSK_SESSION_SECRET', 'dev-insecure-kiosk-secret');
}

export async function issueKioskSession(kioskId: string): Promise<string> {
  return signSession({ role: 'kiosk', kioskId, exp: Date.now() + KIOSK_SESSION_TTL_MS }, getKioskSecret());
}

export async function readKioskSession(token: string | undefined): Promise<{ kioskId: string } | null> {
  const payload = await verifySession(token, getKioskSecret());
  if (!payload || payload.role !== 'kiosk') return null;
  const kioskId = payload.kioskId;
  return typeof kioskId === 'string' ? { kioskId } : null;
}
