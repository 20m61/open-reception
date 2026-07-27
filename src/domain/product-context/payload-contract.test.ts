import { describe, expect, it } from 'vitest';
import {
  assertNoForbiddenConfigurationValues,
  findForbiddenConfigurationValues,
} from './payload-contract';

/** 実際に端末へ配る想定の、正当な構成（誤検出の回帰を防ぐ土台）。 */
const BENIGN_CONFIG = {
  branding: { companyName: 'AVITA', accentColor: '#123456', logoUrl: '/brand/logo.svg' },
  directory: {
    departments: [{ id: 'dep-1', name: '営業部' }],
    staff: [
      { id: 'stf-1', displayName: '山田 太郎', kana: 'やまだ たろう', aliases: ['やまちゃん'] },
    ],
  },
  voice: { ttsEnabled: true, rate: 1, tokenEndpoint: '/api/kiosk/voice-transport/token' },
  signage: { enabled: true, items: [{ id: 's1', url: '/signage/1.png', durationSec: 8 }] },
  integrations: { vonage: { applicationId: 'app-1', presence: 'set' } },
  featureFlags: { avatarReception: true, voiceSynthesis: false },
};

describe('findForbiddenConfigurationValues', () => {
  it('正当な構成では指摘ゼロ（tokenEndpoint や logoUrl を誤検出しない）', () => {
    expect(findForbiddenConfigurationValues(BENIGN_CONFIG)).toEqual([]);
  });

  it('secret 風のキーを検出する', () => {
    const findings = findForbiddenConfigurationValues({
      integrations: { vonage: { privateKey: 'TEST-x', apiSecret: 'TEST-y' } },
    });

    expect(findings.map((f) => f.path).sort()).toEqual([
      'integrations.vonage.apiSecret',
      'integrations.vonage.privateKey',
    ]);
    expect(findings.every((f) => f.kind === 'secret')).toBe(true);
  });

  it('配列の中も走査してパスを添える', () => {
    const findings = findForbiddenConfigurationValues({
      signage: { items: [{ id: 's1' }, { id: 's2', accessKeyId: 'TEST-z' }] },
    });

    expect(findings).toEqual([
      { path: 'signage.items[1].accessKeyId', key: 'accessKeyId', kind: 'secret' },
    ]);
  });

  it('来訪者 PII を検出する', () => {
    const findings = findForbiddenConfigurationValues({
      receptionFlow: { lastVisitor: { visitorName: '来訪 太郎', email: 'x@example.com' } },
    });

    expect(findings.map((f) => f.kind)).toEqual(['visitor_pii', 'visitor_pii']);
  });

  it('予約 token とその hash を検出する（#375 の漏洩ガードと同じ方針）', () => {
    const findings = findForbiddenConfigurationValues({
      receptionFlow: { reservation: { reservationToken: 'TEST-t', tokenHash: 'deadbeef' } },
    });

    expect(findings.map((f) => f.key).sort()).toEqual(['reservationToken', 'tokenHash']);
  });

  it('サーバ専用の識別子（ARN・接続文字列）を検出する', () => {
    const findings = findForbiddenConfigurationValues({
      integrations: { secretArn: 'arn:aws:secretsmanager:...', connectionString: 'postgres://' },
    });

    // secretArn は「値」ではなく参照名だが、端末構成に載せる理由が無いので server_only として弾く。
    expect(findings.map((f) => f.path).sort()).toEqual([
      'integrations.connectionString',
      'integrations.secretArn',
    ]);
    expect(findings.every((f) => f.kind === 'server_only')).toBe(true);
  });

  it('SecretValue ラッパが混入していれば、キー名に関わらず検出する', () => {
    const wrapped = {
      toJSON: () => '[redacted]',
      get [Symbol.toStringTag]() {
        return 'SecretValue';
      },
    };
    const findings = findForbiddenConfigurationValues({ integrations: { credential: wrapped } });

    expect(findings.some((f) => f.path === 'integrations.credential')).toBe(true);
  });

  it('語境界で判定する（語中の一致では誤検出しない）', () => {
    // 'warn' は 'arn' を、'tokenEndpoint' は 'token' を含むが、いずれも末尾の語ではない。
    expect(
      findForbiddenConfigurationValues({
        voice: { warn: true, tokenEndpoint: '/api/x', keyboardLayout: 'ja' },
      }),
    ).toEqual([]);
  });

  it('snake_case / kebab-case のキーも同じ規則で検出する', () => {
    const findings = findForbiddenConfigurationValues({
      integrations: { api_key: 'TEST-a', 'private-key': 'TEST-b' },
    });

    expect(findings.map((f) => f.key).sort()).toEqual(['api_key', 'private-key']);
  });

  it('循環参照があっても停止する', () => {
    const cyclic: Record<string, unknown> = { branding: {} };
    (cyclic.branding as Record<string, unknown>).self = cyclic;

    expect(findForbiddenConfigurationValues(cyclic)).toEqual([]);
  });
});

describe('assertNoForbiddenConfigurationValues', () => {
  it('正当な構成では何もしない', () => {
    expect(() => assertNoForbiddenConfigurationValues(BENIGN_CONFIG)).not.toThrow();
  });

  it('違反があれば投げる。メッセージにはパスだけを載せ、値は載せない', () => {
    const secret = 'TEST-super-secret-value';
    try {
      assertNoForbiddenConfigurationValues({ integrations: { apiKey: secret } });
      throw new Error('should have thrown');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('integrations.apiKey');
      expect(message).not.toContain(secret);
    }
  });
});
