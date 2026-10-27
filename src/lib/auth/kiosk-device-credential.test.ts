/**
 * 端末証明（登録の証跡）の署名と検証 (#1237)。
 * セッション（30 日）とは別に持ち、セッションが切れたあとも「この端末は登録済み」を示す。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KIOSK_DEVICE_COOKIE,
  KIOSK_DEVICE_COOKIE_PATH,
  KIOSK_DEVICE_CREDENTIAL_TTL_MS,
  issueDeviceCredential,
  readDeviceCredential,
} from './kiosk-device-credential';
import { issueKioskSession, readKioskSession } from './kiosk';
import { issueEnrollmentToken } from './kiosk-enrollment';
import { signSession } from './session';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('端末証明 (#1237)', () => {
  it('発行した証明から端末 id と世代を読める', async () => {
    const token = await issueDeviceCredential('kiosk-1', 3);
    expect(await readDeviceCredential(token)).toEqual({ kioskId: 'kiosk-1', generation: 3 });
  });

  it('cookie 名・保持期間（1 年）・path を固定する', () => {
    expect(KIOSK_DEVICE_COOKIE).toBe('kiosk_device');
    expect(KIOSK_DEVICE_CREDENTIAL_TTL_MS).toBe(365 * 24 * 60 * 60 * 1000);
    expect(KIOSK_DEVICE_COOKIE_PATH).toBe('/api/kiosk/authorize');
  });

  it('🔴 期限切れは null（1 年を過ぎた証明では再認可できない）', async () => {
    const issuedAt = Date.now() - KIOSK_DEVICE_CREDENTIAL_TTL_MS - 1;
    const token = await issueDeviceCredential('kiosk-1', 1, issuedAt);
    expect(await readDeviceCredential(token)).toBeNull();
  });

  it('期限の内側（下界）は読める', async () => {
    const issuedAt = Date.now() - KIOSK_DEVICE_CREDENTIAL_TTL_MS + 60_000;
    const token = await issueDeviceCredential('kiosk-1', 1, issuedAt);
    expect(await readDeviceCredential(token)).toEqual({ kioskId: 'kiosk-1', generation: 1 });
  });

  it('🔴 改ざん・無署名・空は null', async () => {
    const token = await issueDeviceCredential('kiosk-1', 1);
    const [body, sig] = token.split('.');
    expect(await readDeviceCredential(`${body}.${sig?.slice(0, -2)}xx`)).toBeNull();
    expect(await readDeviceCredential(body)).toBeNull();
    expect(await readDeviceCredential('')).toBeNull();
    expect(await readDeviceCredential(undefined)).toBeNull();
  });

  it('🔴 kiosk セッション・エンロールトークンは証明として読まない（役割の取り違え）', async () => {
    const session = await issueKioskSession('kiosk-1');
    expect(await readDeviceCredential(session)).toBeNull();
    const { token: enroll } = await issueEnrollmentToken({
      tenantId: 't',
      siteId: 's',
      deviceId: 'kiosk-1',
      jti: 'j',
    });
    expect(await readDeviceCredential(enroll)).toBeNull();
  });

  it('🔴 同じ鍵・同じ形でも role の違う署名は読まない', async () => {
    const { getEnrollmentSecret } = await import('./kiosk-enrollment');
    const exp = Date.now() + 60_000;
    for (const role of ['kiosk-enroll', 'kiosk', 'admin']) {
      const other = await signSession({ role, exp, kioskId: 'kiosk-1', generation: 1 }, getEnrollmentSecret());
      expect(await readDeviceCredential(other)).toBeNull();
    }
  });

  it('🔴 証明は kiosk セッションとして読まれない（逆向きの取り違え）', async () => {
    const credential = await issueDeviceCredential('kiosk-1', 1);
    expect(await readKioskSession(credential)).toBeNull();
  });

  it('🔴 世代が非負整数でない・端末 id が空の証明は null', async () => {
    const { getEnrollmentSecret } = await import('./kiosk-enrollment');
    const exp = Date.now() + 60_000;
    for (const generation of [-1, 1.5, '1', null, undefined]) {
      const forged = await signSession(
        { role: 'kiosk-device', exp, kioskId: 'kiosk-1', generation },
        getEnrollmentSecret(),
      );
      expect(await readDeviceCredential(forged)).toBeNull();
    }
    const blank = await signSession(
      { role: 'kiosk-device', exp, kioskId: '  ', generation: 1 },
      getEnrollmentSecret(),
    );
    expect(await readDeviceCredential(blank)).toBeNull();
  });

  it('🔴 鍵が解決できない実デプロイでは発行も検証も throw する（公開既定値に落ちない）', async () => {
    const token = await issueDeviceCredential('kiosk-1', 1);
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'fn');
    vi.stubEnv('KIOSK_ENROLLMENT_SECRET', '');
    await expect(issueDeviceCredential('kiosk-1', 1)).rejects.toThrow(/KIOSK_ENROLLMENT_SECRET/);
    await expect(readDeviceCredential(token)).rejects.toThrow(/KIOSK_ENROLLMENT_SECRET/);
  });
});
