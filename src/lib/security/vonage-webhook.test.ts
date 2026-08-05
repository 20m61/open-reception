import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  REPLAY_WINDOW_SECONDS,
  verifyVonageWebhook,
  type VonageWebhookVerification,
} from './vonage-webhook';

const SECRET = 'TEST-vonage-signature-secret';
const NOW = 1_800_000_000;
const BODY = JSON.stringify({ uuid: 'TEST-call-uuid', status: 'answered' });

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** Vonage が送る signed webhook JWT を組み立てる（HS256）。 */
function signJwt(claims: Record<string, unknown>, secret = SECRET, alg = 'HS256'): string {
  const header = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function sha256Hex(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iat: NOW,
    jti: 'TEST-jti-1',
    api_key: 'TEST-api-key',
    payload_hash: sha256Hex(BODY),
    ...overrides,
  };
}

function verify(
  token: string | undefined,
  body = BODY,
  nowSec = NOW,
): VonageWebhookVerification {
  return verifyVonageWebhook({
    authorization: token === undefined ? undefined : `Bearer ${token}`,
    rawBody: body,
    signatureSecret: SECRET,
    nowSec,
  });
}

describe('verifyVonageWebhook — 正常系 (#4)', () => {
  it('署名・payload_hash・iat がそろっていれば通す', () => {
    const result = verify(signJwt(validClaims()));
    expect(result).toMatchObject({ verified: true, jti: 'TEST-jti-1' });
  });

  it('冪等に使う jti を返す（重複配信の判定材料）', () => {
    const result = verify(signJwt(validClaims({ jti: 'TEST-jti-2' })));
    expect(result.verified && result.jti).toBe('TEST-jti-2');
  });
});

describe('署名の検証 (#4)', () => {
  it('別の secret で署名されたトークンを拒否する', () => {
    expect(verify(signJwt(validClaims(), 'TEST-wrong-secret'))).toMatchObject({
      verified: false,
      reason: 'bad_signature',
    });
  });

  it('署名を書き換えたトークンを拒否する', () => {
    const [h, p] = signJwt(validClaims()).split('.');
    expect(verify(`${h}.${p}.${b64url('forged')}`)).toMatchObject({ verified: false });
  });

  // 🔴 alg confusion。`alg: none` や非対称アルゴリズムを名乗られて検証を飛ばすと、
  // 誰でも任意の通話イベントを注入できる（取次を勝手に進められる）。
  it.each(['none', 'None', 'RS256', 'HS512'])('alg=%s を拒否する', (alg) => {
    expect(verify(signJwt(validClaims(), SECRET, alg))).toMatchObject({
      verified: false,
      reason: 'unsupported_alg',
    });
  });

  it('署名部を削ったトークンを拒否する', () => {
    const [h, p] = signJwt(validClaims()).split('.');
    expect(verify(`${h}.${p}.`)).toMatchObject({ verified: false });
  });
});

describe('本文の束縛 payload_hash (#4)', () => {
  // 🔴 署名だけ検証して payload_hash を見ないと、正規のトークンを再利用して
  // **本文だけ差し替え**られる（別の通話 UUID・別の結果を注入できる）。
  it('本文が改ざんされていたら拒否する', () => {
    const tampered = JSON.stringify({ uuid: 'TEST-other-call', status: 'answered' });
    expect(verify(signJwt(validClaims()), tampered)).toMatchObject({
      verified: false,
      reason: 'payload_hash_mismatch',
    });
  });

  it('payload_hash が無いトークンを拒否する', () => {
    const claims = validClaims();
    delete claims.payload_hash;
    expect(verify(signJwt(claims))).toMatchObject({ verified: false, reason: 'missing_payload_hash' });
  });

  it('空ボディでも hash を検証する', () => {
    const ok = verify(signJwt(validClaims({ payload_hash: sha256Hex('') })), '');
    expect(ok.verified).toBe(true);
    const ng = verify(signJwt(validClaims()), '');
    expect(ng.verified).toBe(false);
  });
});

describe('リプレイ防止 iat (#4)', () => {
  it('窓の内側は通す', () => {
    expect(verify(signJwt(validClaims()), BODY, NOW + REPLAY_WINDOW_SECONDS - 1).verified).toBe(true);
  });

  it('古すぎるトークンを拒否する（記録された正規リクエストの再送）', () => {
    expect(verify(signJwt(validClaims()), BODY, NOW + REPLAY_WINDOW_SECONDS + 1)).toMatchObject({
      verified: false,
      reason: 'stale',
    });
  });

  it('未来すぎるトークンを拒否する（時刻ずれの悪用）', () => {
    expect(verify(signJwt(validClaims()), BODY, NOW - REPLAY_WINDOW_SECONDS - 1)).toMatchObject({
      verified: false,
      reason: 'stale',
    });
  });

  it('iat が無い・数値でないトークンを拒否する', () => {
    expect(verify(signJwt(validClaims({ iat: undefined })))).toMatchObject({ verified: false });
    expect(verify(signJwt(validClaims({ iat: 'いつか' })))).toMatchObject({ verified: false });
  });

  it('jti が無いトークンを拒否する（重複を判定できない）', () => {
    const claims = validClaims();
    delete claims.jti;
    expect(verify(signJwt(claims))).toMatchObject({ verified: false, reason: 'missing_jti' });
  });
});

describe('ヘッダの取り扱い (#4)', () => {
  it.each([undefined, '', 'Bearer', 'Basic abc', 'bearer'])('不正な Authorization %s を拒否する', (h) => {
    expect(
      verifyVonageWebhook({
        authorization: h,
        rawBody: BODY,
        signatureSecret: SECRET,
        nowSec: NOW,
      }),
    ).toMatchObject({ verified: false });
  });

  it('小文字 bearer も受け付ける（RFC 6750 はスキームを case-insensitive とする）', () => {
    const result = verifyVonageWebhook({
      authorization: `bearer ${signJwt(validClaims())}`,
      rawBody: BODY,
      signatureSecret: SECRET,
      nowSec: NOW,
    });
    expect(result.verified).toBe(true);
  });

  it('署名 secret が未設定なら fail-closed（検証できないものを通さない）', () => {
    expect(
      verifyVonageWebhook({
        authorization: `Bearer ${signJwt(validClaims())}`,
        rawBody: BODY,
        signatureSecret: '',
        nowSec: NOW,
      }),
    ).toMatchObject({ verified: false, reason: 'no_signature_secret' });
  });
});

describe('拒否理由に機密を載せない (#4)', () => {
  it.each([
    ['bad secret', () => verify(signJwt(validClaims(), 'TEST-wrong-secret'))],
    ['tampered body', () => verify(signJwt(validClaims()), 'TEST-tampered-body')],
    ['no secret', () => verifyVonageWebhook({ authorization: 'Bearer x.y.z', rawBody: BODY, signatureSecret: SECRET, nowSec: NOW })],
  ])('%s の結果に secret・本文・トークンを含めない', (_label, run) => {
    const serialized = JSON.stringify(run());
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('TEST-tampered-body');
    expect(serialized).not.toContain('TEST-call-uuid');
  });
});
