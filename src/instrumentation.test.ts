import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Secrets Manager クライアントをモックする。send() の戻りはテストごとに差し替える。
const sendMock = vi.fn();
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = sendMock;
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { register } from './instrumentation';

describe('instrumentation register() — Secrets Manager preload (#194)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    sendMock.mockReset();
    // テスト対象のキーを掃除する。
    delete process.env.APP_SECRETS_ARN;
    delete process.env.ORIGIN_VERIFY_SECRET_ARN;
    delete process.env.ORIGIN_VERIFY_SECRET;
    delete process.env.NEXT_RUNTIME;
    delete process.env.ADMIN_SESSION_SECRET;
    delete process.env.KIOSK_SESSION_SECRET;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('is a no-op when APP_SECRETS_ARN is unset (backward compatible)', async () => {
    await register();
    expect(sendMock).not.toHaveBeenCalled();
    expect(process.env.ADMIN_SESSION_SECRET).toBeUndefined();
  });

  it('populates missing env keys from the secret JSON', async () => {
    process.env.APP_SECRETS_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123:secret:app';
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({
        ADMIN_SESSION_SECRET: 'from-sm-admin',
        KIOSK_SESSION_SECRET: 'from-sm-kiosk',
      }),
    });

    await register();

    expect(process.env.ADMIN_SESSION_SECRET).toBe('from-sm-admin');
    expect(process.env.KIOSK_SESSION_SECRET).toBe('from-sm-kiosk');
  });

  it('does not override env keys already present (explicit injection wins)', async () => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    process.env.ADMIN_SESSION_SECRET = 'explicit-admin';
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({
        ADMIN_SESSION_SECRET: 'from-sm-admin',
        KIOSK_SESSION_SECRET: 'from-sm-kiosk',
      }),
    });

    await register();

    expect(process.env.ADMIN_SESSION_SECRET).toBe('explicit-admin');
    expect(process.env.KIOSK_SESSION_SECRET).toBe('from-sm-kiosk');
  });

  it('skips non-string secret values', async () => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({ ADMIN_SESSION_SECRET: 'ok', NESTED: { a: 1 }, NUM: 5 }),
    });

    await register();

    expect(process.env.ADMIN_SESSION_SECRET).toBe('ok');
    expect(process.env.NESTED).toBeUndefined();
    expect(process.env.NUM).toBeUndefined();
  });

  it('does nothing in non-nodejs runtimes (edge)', async () => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    process.env.NEXT_RUNTIME = 'edge';

    await register();

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('throws (fail-fast) when the secret fetch fails', async () => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    sendMock.mockRejectedValue(new Error('AccessDenied'));

    await expect(register()).rejects.toThrow(/Failed to load application secrets/);
  });

  it('throws when the secret is not a JSON object', async () => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    sendMock.mockResolvedValue({ SecretString: '"just-a-string"' });

    await expect(register()).rejects.toThrow(/must be a JSON object/);
  });

  it('throws when the secret string is absent', async () => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    sendMock.mockResolvedValue({ SecretString: undefined });

    await expect(register()).rejects.toThrow(/no SecretString/);
  });
});

// origin-verify シークレットを Lambda 環境変数の平文ではなく runtime 解決にする (#612)。
describe('instrumentation register() — origin-verify secret (#612)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    sendMock.mockReset();
    delete process.env.APP_SECRETS_ARN;
    delete process.env.ORIGIN_VERIFY_SECRET_ARN;
    delete process.env.ORIGIN_VERIFY_SECRET;
    delete process.env.NEXT_RUNTIME;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('ORIGIN_VERIFY_SECRET_ARN 未設定なら no-op（OAC / dev 平文方式のまま）', async () => {
    await register();
    expect(sendMock).not.toHaveBeenCalled();
    expect(process.env.ORIGIN_VERIFY_SECRET).toBeUndefined();
  });

  it('シークレット JSON の ORIGIN_VERIFY_SECRET を process.env へ解決する', async () => {
    process.env.ORIGIN_VERIFY_SECRET_ARN = 'arn:aws:secretsmanager:...:secret:origin';
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({ ORIGIN_VERIFY_SECRET: 'TEST-from-sm' }),
    });

    await register();

    expect(process.env.ORIGIN_VERIFY_SECRET).toBe('TEST-from-sm');
  });

  it('APP_SECRETS_ARN と同じシークレットを指しても二重取得しない', async () => {
    process.env.APP_SECRETS_ARN = 'arn:same';
    process.env.ORIGIN_VERIFY_SECRET_ARN = 'arn:same';
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({ ORIGIN_VERIFY_SECRET: 'TEST-from-sm' }),
    });

    await register();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(process.env.ORIGIN_VERIFY_SECRET).toBe('TEST-from-sm');
  });

  it('JSON にキーが無ければ throw（fail-fast。黙って fail-open させない）', async () => {
    process.env.ORIGIN_VERIFY_SECRET_ARN = 'arn:origin';
    sendMock.mockResolvedValue({ SecretString: JSON.stringify({ SOMETHING_ELSE: 'x' }) });

    await expect(register()).rejects.toThrow(/ORIGIN_VERIFY_SECRET/);
  });

  it('取得に失敗したら throw（起動を止め、検証無しで公開しない）', async () => {
    process.env.ORIGIN_VERIFY_SECRET_ARN = 'arn:origin';
    sendMock.mockRejectedValue(new Error('AccessDenied'));

    await expect(register()).rejects.toThrow(/Failed to load application secrets/);
  });

  it('エラーメッセージにシークレット値を含めない', async () => {
    process.env.ORIGIN_VERIFY_SECRET_ARN = 'arn:origin';
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({ OTHER: 'TEST-must-not-leak' }),
    });

    await expect(register()).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('TEST-must-not-leak') }),
    );
  });
});
