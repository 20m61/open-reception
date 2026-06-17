import { describe, expect, it } from 'vitest';
import { issueKioskSession, readKioskSession } from './kiosk';
import { signSession } from './session';
import { getAdminSecret } from './admin';

describe('kiosk session (#23)', () => {
  it('発行した kiosk セッションから kioskId を取り出せる', async () => {
    const token = await issueKioskSession('kiosk-dev');
    const session = await readKioskSession(token);
    expect(session?.kioskId).toBe('kiosk-dev');
  });

  it('未定義トークンは null', async () => {
    expect(await readKioskSession(undefined)).toBeNull();
  });

  it('admin secret で署名されたトークン（role=admin）は kiosk として無効', async () => {
    const adminToken = await signSession({ role: 'admin', exp: Date.now() + 60_000 }, getAdminSecret());
    expect(await readKioskSession(adminToken)).toBeNull();
  });
});
