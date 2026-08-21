/**
 * Vonage 切断 adapter の契約 (#743 AC2 後半)。
 *
 * 実資格情報・実 HTTP はゲートで動かせないので fetch を注入して境界を固定する
 * （`vonage-voice-initiator.test.ts` と同じ方針。実物を要する検証は #65）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createVonageVoiceTerminator,
  VONAGE_HANGUP_REQUEST_TIMEOUT_MS,
} from './vonage-voice-terminator';
import { VONAGE_VOICE_REQUEST_TIMEOUT_MS } from './vonage-voice-initiator';

const CREDS = {
  applicationId: 'TEST-app',
  privateKeyPem: 'TEST-pem',
  fromNumber: '+815000000000',
};

function terminator(fetchImpl: typeof globalThis.fetch) {
  return createVonageVoiceTerminator({
    credentials: async () => CREDS,
    signJwt: () => 'TEST-jwt',
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
  });
}

function respond(status: number): typeof globalThis.fetch {
  return (async () => new Response(null, { status })) as unknown as typeof globalThis.fetch;
}

describe('createVonageVoiceTerminator (#743)', () => {
  /**
   * 🔴 **`DELETE /v1/calls/{uuid}` ではない。** #743 の Decision Packet はそう書いていたが
   * Voice API に DELETE は無く、進行中の通話への操作は `PUT` + `{"action": ...}` だけ。
   * DELETE で実装すると 404 が返り `already_ended` と区別が付かないまま
   * 「切ったつもりで鳴り続ける」── しかも気づけるのは実資格情報が入った後（#65）。
   */
  it('🔴 PUT /v1/calls/{uuid} に {"action":"hangup"} を送る', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    await terminator(fetchFn as unknown as typeof globalThis.fetch).terminate('TEST-uuid');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/calls/TEST-uuid');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ action: 'hangup' });
  });

  it('署名した JWT を Bearer で送る', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    await terminator(fetchFn as unknown as typeof globalThis.fetch).terminate('TEST-uuid');
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer TEST-jwt');
  });

  it('通話 ID を URL エスケープする（パスを組み替えさせない）', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    await terminator(fetchFn as unknown as typeof globalThis.fetch).terminate('a/../b');
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.example.test/v1/calls/a%2F..%2Fb');
  });

  it('空の通話 ID では API を叩かない', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const out = await terminator(fetchFn as unknown as typeof globalThis.fetch).terminate('');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: 'failed' });
  });

  it('204 は terminated / 404 は already_ended / 401 は failed', async () => {
    expect(await terminator(respond(204)).terminate('u')).toEqual({ kind: 'terminated' });
    expect(await terminator(respond(404)).terminate('u')).toEqual({ kind: 'already_ended' });
    expect(await terminator(respond(401)).terminate('u')).toEqual({ kind: 'failed' });
  });

  /**
   * 🔴 **例外を投げ返さない。** 呼び出し元は webhook ルートと端末の `/give-up` で、
   * どちらも切断の失敗で 5xx を返してはいけない（Vonage の再送・画面固着を招く）。
   */
  it('🔴 通信例外を投げ返さず failed にする', async () => {
    const boom = (async () => {
      throw new Error('TEST-network-detail');
    }) as unknown as typeof globalThis.fetch;
    await expect(terminator(boom).terminate('u')).resolves.toEqual({ kind: 'failed' });
  });

  it('🔴 例外の内容を結果に載せない', async () => {
    const boom = (async () => {
      throw new Error('TEST-network-detail');
    }) as unknown as typeof globalThis.fetch;
    const out = await terminator(boom).terminate('u');
    expect(JSON.stringify(out)).not.toContain('TEST-network-detail');
  });

  /**
   * 🔴 **上限のない切断をしない。** 発信より短く取る ── 切断は失敗しても呼出予算で
   * 自然に終わるので、待つ価値が発信より小さい。
   */
  it('🔴 上限つきで、発信の上限より短い', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    await terminator(fetchFn as unknown as typeof globalThis.fetch).terminate('u');
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeDefined();
    expect(VONAGE_HANGUP_REQUEST_TIMEOUT_MS).toBeLessThan(VONAGE_VOICE_REQUEST_TIMEOUT_MS);
  });
});
