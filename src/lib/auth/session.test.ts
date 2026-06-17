import { describe, expect, it } from 'vitest';
import { signSession, verifySession, type AdminSession } from './session';

const secret = 'test-secret';
const future = (): AdminSession => ({ role: 'admin', exp: Date.now() + 60_000 });

describe('admin session token (#24)', () => {
  it('署名したトークンを検証できる', async () => {
    const token = await signSession(future(), secret);
    const session = await verifySession(token, secret);
    expect(session?.role).toBe('admin');
  });

  it('別の secret では検証に失敗する', async () => {
    const token = await signSession(future(), secret);
    expect(await verifySession(token, 'other-secret')).toBeNull();
  });

  it('改ざんされたトークンを拒否する', async () => {
    const token = await signSession(future(), secret);
    const tampered = `${token.split('.')[0]}.AAAA`;
    expect(await verifySession(tampered, secret)).toBeNull();
  });

  it('期限切れトークンを拒否する', async () => {
    const token = await signSession({ role: 'admin', exp: Date.now() - 1 }, secret);
    expect(await verifySession(token, secret)).toBeNull();
  });

  it('未定義トークンを拒否する', async () => {
    expect(await verifySession(undefined, secret)).toBeNull();
  });
});
