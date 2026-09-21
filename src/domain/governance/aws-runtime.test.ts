/**
 * AWS 実行系の解決と、誤接続 guard の単体テスト（ADR 0010 / #1103）。
 *
 * ここが縛るのは**優先度 1〜2**（本番 AWS への安全性・誤操作の防止）である。
 * エミュレータを増やすと誤接続の面が増えるので、設定解決と同じ場所で fail-fast させる。
 */
import { describe, expect, it } from 'vitest';
import {
  AwsRuntimeSafetyError,
  checkAwsRuntimeSafety,
  resolveAwsRuntime,
  resolveAwsRuntimeConfig,
} from './aws-runtime';

/** 実資格情報に見える sentinel。**本物ではない**（形だけ似せてある）。 */
const REAL_KEY = 'AKIAREALSENTINEL00000';
const REAL_STS_KEY = 'ASIAREALSENTINEL00000';

const codes = (env: Record<string, string | undefined>) =>
  checkAwsRuntimeSafety(env).map((v) => v.code);

describe('resolveAwsRuntime', () => {
  it('🔴 未設定なら aws（fail-safe の向き）', () => {
    // 🔴 既定をエミュレータにしてはいけない。デプロイされた Lambda は
    // `AWS_RUNTIME` を持たないので、既定が emulator だと**本番が黙って
    // エミュレータを向く**。分からないときは実 AWS の意味論に倒し、
    // 危険な組み合わせは下の guard で止める。
    expect(resolveAwsRuntime({})).toBe('aws');
  });

  it('明示された実行系を解決する', () => {
    expect(resolveAwsRuntime({ AWS_RUNTIME: 'ministack' })).toBe('ministack');
    expect(resolveAwsRuntime({ AWS_RUNTIME: 'moto' })).toBe('moto');
    expect(resolveAwsRuntime({ AWS_RUNTIME: 'localstack' })).toBe('localstack');
    expect(resolveAwsRuntime({ AWS_RUNTIME: 'aws' })).toBe('aws');
  });

  it('知らない実行系は黙って既定へ落とさず throw する', () => {
    // 黙って `aws` へ落とすと、綴り間違いが**実 AWS 行き**になる。
    expect(() => resolveAwsRuntime({ AWS_RUNTIME: 'ministak' })).toThrow(/ministak/);
  });
});

describe('checkAwsRuntimeSafety: エミュレータ実行時に実資格情報を持ち込まない', () => {
  const emulated = { AWS_RUNTIME: 'ministack' as const };

  it('dummy 資格情報なら違反なし（下界）', () => {
    // これが無いと「常に違反」を返す実装でも下のテストは全部通る。
    expect(
      codes({ ...emulated, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' }),
    ).toEqual([]);
  });

  it('🔴 AKIA / ASIA 形の access key を検出する', () => {
    expect(codes({ ...emulated, AWS_ACCESS_KEY_ID: REAL_KEY })).toContain('real_credentials');
    expect(codes({ ...emulated, AWS_ACCESS_KEY_ID: REAL_STS_KEY })).toContain('real_credentials');
  });

  it('🔴 session token を検出する（短命 STS の 3 点目）', () => {
    expect(
      codes({ ...emulated, AWS_ACCESS_KEY_ID: 'test', AWS_SESSION_TOKEN: 'realtoken' }),
    ).toContain('real_credentials');
  });

  it('🔴 AWS_PROFILE を検出する（~/.aws 経由で実資格情報が解決される）', () => {
    expect(codes({ ...emulated, AWS_PROFILE: 'admin' })).toContain('real_credentials');
  });

  it.each([
    ['AWS_ROLE_ARN', 'arn:aws:iam::123456789012:role/codebuild'],
    ['AWS_WEB_IDENTITY_TOKEN_FILE', '/tmp/token'],
    ['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/example'],
    ['AWS_CONTAINER_CREDENTIALS_FULL_URI', 'http://127.0.0.1/credentials'],
    ['AWS_CONTAINER_AUTHORIZATION_TOKEN', 'token'],
    ['AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', '/tmp/auth-token'],
  ])('🔴 %s を検出する（ambient provider を残さない）', (name, value) => {
    expect(codes({ ...emulated, [name]: value })).toContain('real_credentials');
  });

  it('🔴 AWS_CREDENTIAL_EXPIRATION を検出する', () => {
    // デプロイ窓の残骸。存在するだけで CLI/SDK が「期限付き静的資格情報」と解釈し、
    // dummy まで失効扱いにする（2026-09-14 に実際に踏んだ）。
    expect(
      codes({ ...emulated, AWS_CREDENTIAL_EXPIRATION: '2026-09-14T14:55:40+00:00' }),
    ).toContain('real_credentials');
  });

  it('🔴 endpoint が実 AWS を向いていたら検出する', () => {
    expect(
      codes({ ...emulated, AWS_ENDPOINT_URL: 'https://dynamodb.ap-northeast-1.amazonaws.com' }),
    ).toContain('endpoint_is_real_aws');
  });

  it('ローカル endpoint は違反にしない（下界）', () => {
    expect(codes({ ...emulated, AWS_ENDPOINT_URL: 'http://127.0.0.1:4566' })).toEqual([]);
  });
});

describe('checkAwsRuntimeSafety: 実 AWS を選んだとき', () => {
  it('🔴 デプロイ外で実資格情報を使うには明示の opt-in が要る', () => {
    expect(codes({ AWS_RUNTIME: 'aws', AWS_ACCESS_KEY_ID: REAL_KEY })).toContain(
      'real_aws_without_opt_in',
    );
  });

  it('opt-in があれば通す', () => {
    expect(
      codes({ AWS_RUNTIME: 'aws', AWS_ACCESS_KEY_ID: REAL_KEY, AWS_ALLOW_REAL: '1' }),
    ).toEqual([]);
  });

  it('🔴 デプロイ実行（Lambda）は止めない（下界）', () => {
    // ここを止めると**本番が動かなくなる**。guard の目的はローカル/CI からの
    // 誤接続であって、デプロイされた実行ではない。
    // `resolveBackendKind` と同じく Lambda マーカーで判定する。
    expect(
      codes({
        AWS_RUNTIME: 'aws',
        AWS_ACCESS_KEY_ID: REAL_KEY,
        AWS_LAMBDA_FUNCTION_NAME: 'open-reception-server',
      }),
    ).toEqual([]);
  });

  it('資格情報が無ければ opt-in を要求しない（synth / typecheck を壊さない）', () => {
    expect(codes({ AWS_RUNTIME: 'aws' })).toEqual([]);
  });
});

describe('resolveAwsRuntimeConfig', () => {
  it('エミュレータは既定 endpoint と dummy 資格情報を持つ', () => {
    const cfg = resolveAwsRuntimeConfig({ AWS_RUNTIME: 'ministack' });
    expect(cfg.emulated).toBe(true);
    expect(cfg.endpoint).toBe('http://127.0.0.1:4566');
    // 🔴 dummy を**明示的に載せる**。載せないと SDK が ambient の実資格情報を
    // 解決してしまい、「endpoint はローカルなのに実資格情報で署名する」形になる。
    expect(cfg.credentials).toEqual({ accessKeyId: 'test', secretAccessKey: 'test' });
  });

  it('moto は既定 port が異なる', () => {
    expect(resolveAwsRuntimeConfig({ AWS_RUNTIME: 'moto' }).endpoint).toBe('http://127.0.0.1:5000');
  });

  it('AWS_ENDPOINT_URL が既定を上書きする', () => {
    expect(
      resolveAwsRuntimeConfig({ AWS_RUNTIME: 'ministack', AWS_ENDPOINT_URL: 'http://127.0.0.1:4567' })
        .endpoint,
    ).toBe('http://127.0.0.1:4567');
  });

  it('🔴 実 AWS では endpoint も credentials も載せない（SDK の既定解決に任せる）', () => {
    const cfg = resolveAwsRuntimeConfig({ AWS_RUNTIME: 'aws' });
    expect(cfg.emulated).toBe(false);
    expect(cfg.endpoint).toBeUndefined();
    expect(cfg.credentials).toBeUndefined();
  });

  it('region は env を尊重し、既定を持つ', () => {
    expect(resolveAwsRuntimeConfig({ AWS_RUNTIME: 'moto', AWS_REGION: 'us-east-1' }).region).toBe(
      'us-east-1',
    );
    expect(resolveAwsRuntimeConfig({ AWS_RUNTIME: 'moto' }).region).toBe('ap-northeast-1');
  });

  it('🔴 違反があれば config を返さず throw する', () => {
    // 「違反を報告するが config は返す」だと、呼び出し側が無視できてしまう。
    expect(() =>
      resolveAwsRuntimeConfig({ AWS_RUNTIME: 'ministack', AWS_ACCESS_KEY_ID: REAL_KEY }),
    ).toThrow(AwsRuntimeSafetyError);
  });

  it('throw するとき、何が悪いかと直し方が読めること', () => {
    try {
      resolveAwsRuntimeConfig({ AWS_RUNTIME: 'ministack', AWS_SESSION_TOKEN: 'x' });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('AWS_RUNTIME=ministack');
      expect(msg).toContain('AWS_SESSION_TOKEN');
    }
  });
});
