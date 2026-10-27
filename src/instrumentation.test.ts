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

  // Node の JSON.parse は失敗時のメッセージに入力の先頭 10 文字を含める。cause を連結すると
  // console.error(err) がチェーンごと出力し、CloudWatch にシークレットの先頭が残る (#612)。
  // **cause チェーン全体**を走査する（top-level message だけ見ると素通りする）。
  it('シークレットが JSON でないとき、値が cause チェーンのどこにも漏れない', async () => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    sendMock.mockResolvedValue({ SecretString: 'TEST-raw-not-json-secret-value' });

    const error = await register().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    const chain: string[] = [];
    for (let e: unknown = error, depth = 0; e instanceof Error && depth < 10; depth++) {
      chain.push(e.message, e.stack ?? '');
      e = e.cause;
    }
    expect(chain.join('\n')).not.toContain('TEST-raw');
  });

  // 🔴 空文字は Secrets Manager の実在する設定ミス（作成時に値を入れ忘れる等）。
  // `!secretString` を `=== undefined` に狭められても気づけるよう、両方を固定する。
  it.each([
    ['undefined', undefined],
    ['空文字', ''],
  ])('throws when the secret string is %s', async (_label, value) => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    sendMock.mockResolvedValue({ SecretString: value });

    await expect(register()).rejects.toThrow(/no SecretString/);
  });

  // 🔴 明示注入された空文字を Secrets Manager の値で上書きしない。
  // `=== undefined` を `!process.env[key]` に緩めると、意図的に空にした env が黙って埋まる。
  it('明示注入された空文字の env を上書きしない', async () => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    process.env.ADMIN_SESSION_SECRET = '';
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({ ADMIN_SESSION_SECRET: 'from-sm-admin' }),
    });

    await register();

    expect(process.env.ADMIN_SESSION_SECRET).toBe('');
  });
});

/**
 * 🔴 **起動時の自己検査 (#1124)。** 管理 / 受付端末のセッション鍵が deploy で未設定、または
 * 公開既定値のままなら、`register()` が throw して**サーバを動かさない**。
 * 以前は warn-only で、公開既定値で署名した cookie が有効なセッションとして通った。
 *
 * 検査は Secrets Manager からの注入の**後**に行う（注入で埋まる鍵を「未設定」と誤判定しない）。
 * また `APP_SECRETS_ARN` を使わない方式 A（Lambda env へ直接注入）でも検査する。
 */
describe('instrumentation register() — セッション鍵の起動時検査 (#1124)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    sendMock.mockReset();
    delete process.env.APP_SECRETS_ARN;
    delete process.env.NEXT_RUNTIME;
    delete process.env.ADMIN_SESSION_SECRET;
    delete process.env.KIOSK_SESSION_SECRET;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'open-reception-server';
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('🔴 方式 A（APP_SECRETS_ARN なし）で鍵が未設定なら起動を止める', async () => {
    await expect(register()).rejects.toThrow(/ADMIN_SESSION_SECRET|KIOSK_SESSION_SECRET/);
  });

  it('🔴 方式 A で公開既定値のままなら起動を止める', async () => {
    process.env.ADMIN_SESSION_SECRET = 'dev-insecure-admin-secret';
    process.env.KIOSK_SESSION_SECRET = 'TEST-kiosk-session-secret';
    await expect(register()).rejects.toThrow(/ADMIN_SESSION_SECRET/);
  });

  it('方式 A で両方設定済みなら起動する', async () => {
    process.env.ADMIN_SESSION_SECRET = 'TEST-admin-session-secret';
    process.env.KIOSK_SESSION_SECRET = 'TEST-kiosk-session-secret';
    await expect(register()).resolves.toBeUndefined();
  });

  it('🔴 方式 B で Secrets Manager にも鍵が無ければ起動を止める', async () => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({ ADMIN_SESSION_SECRET: 'TEST-admin-session-secret' }),
    });
    await expect(register()).rejects.toThrow(/KIOSK_SESSION_SECRET/);
  });

  it('🔴 方式 B で Secrets Manager の値が公開既定値なら起動を止める', async () => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({
        ADMIN_SESSION_SECRET: 'TEST-admin-session-secret',
        KIOSK_SESSION_SECRET: 'dev-insecure-kiosk-secret',
      }),
    });
    await expect(register()).rejects.toThrow(/KIOSK_SESSION_SECRET/);
  });

  /** 下界。注入の後に検査する（順序を逆にすると、ここが赤くなる）。 */
  it('方式 B で Secrets Manager が両方を与えれば起動する', async () => {
    process.env.APP_SECRETS_ARN = 'arn:secret';
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({
        ADMIN_SESSION_SECRET: 'TEST-admin-session-secret',
        KIOSK_SESSION_SECRET: 'TEST-kiosk-session-secret',
      }),
    });
    await expect(register()).resolves.toBeUndefined();
  });

  /** 下界。ローカル `next start` / e2e（Lambda マーカー無し）は鍵が無くても起動する。 */
  it('非 Lambda では鍵が無くても起動する', async () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    await expect(register()).resolves.toBeUndefined();
  });

  /** edge ランタイムでは検査しない（Node でだけ解決・検査する既存の分岐を保つ）。 */
  it('edge ランタイムでは検査しない', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    await expect(register()).resolves.toBeUndefined();
  });
});
