import { describe, expect, it, vi } from 'vitest';
import { createVonageVoiceInitiator, type VonageVoiceDeps } from './vonage-voice-initiator';
import type { ConnectCommand } from '@/domain/routing/provider';

const COMMAND: ConnectCommand = {
  callUuid: 'RCP-1',
  endpoint: { id: 'ep-1', ownerType: 'staff', channel: 'pstn', providerKey: 'vonage-voice' },
  action: 'notify',
  timeoutSeconds: 30,
};

function deps(over: Partial<VonageVoiceDeps> = {}): VonageVoiceDeps {
  return {
    resolveNumber: async () => '+819012345678',
    credentials: async () => ({
      applicationId: 'APP-1',
      privateKeyPem: 'TEST-KEY',
      fromNumber: '+815012345678',
    }),
    signJwt: () => 'TEST-JWT',
    baseUrl: 'https://api.nexmo.com',
    webhookBaseUrl: 'https://cf.example.com',
    fetch: vi.fn(async () => new Response(JSON.stringify({ uuid: 'CALL-1' }), { status: 201 })),
    ...over,
  };
}

describe('createVonageVoiceInitiator (#4 Inc D)', () => {
  it('provider 通話 ID を返す', async () => {
    const d = deps();
    const r = await createVonageVoiceInitiator(d).initiate(COMMAND);
    expect(r.providerCallId).toBe('CALL-1');
  });

  it('POST /v1/calls を叩く', async () => {
    const d = deps();
    await createVonageVoiceInitiator(d).initiate(COMMAND);
    const [url, init] = (d.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.nexmo.com/v1/calls');
    expect(init.method).toBe('POST');
  });

  it('アプリ JWT を Bearer で送る', async () => {
    const d = deps();
    await createVonageVoiceInitiator(d).initiate(COMMAND);
    const [, init] = (d.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer TEST-JWT');
  });

  it('webhook URL は CloudFront ドメイン配下を渡す（Function URL だと 403 になる）', async () => {
    const d = deps();
    await createVonageVoiceInitiator(d).initiate(COMMAND);
    const [, init] = (d.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { answer_url: string[]; event_url: string[] };
    expect(body.answer_url[0]).toBe('https://cf.example.com/api/providers/vonage/answer');
    expect(body.event_url[0]).toBe('https://cf.example.com/api/providers/vonage/events');
  });

  it('本文に来訪者情報を載せない（PII 境界）', async () => {
    // 🔴 否定条件ではなく**キーの許可リスト**で固定する（理由は voice-initiator.test.ts）。
    const d = deps();
    await createVonageVoiceInitiator(d).initiate(COMMAND);
    const [, init] = (d.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'answer_method',
      'answer_url',
      'event_method',
      'event_url',
      'from',
      'ringing_timer',
      'to',
    ]);
  });

  it('JWT は注入された資格情報で署名する', async () => {
    // 署名先を固定しないと、資格情報の取り違え（別テナントの鍵で署名）が素通りする。
    const signJwt = vi.fn(() => 'TEST-JWT');
    const d = deps({ signJwt });
    await createVonageVoiceInitiator(d).initiate(COMMAND);
    expect(signJwt).toHaveBeenCalledWith({
      applicationId: 'APP-1',
      privateKeyPem: 'TEST-KEY',
    });
  });

  it('2xx 以外は失敗にする（発信したつもりで進めない）', async () => {
    // 🔴 **本文にわざと uuid を入れる。** uuid 無しにすると、status チェックを外しても
    // 後段の「uuid が無い」で落ちてテストが通ってしまい、**status 判定を守れない**
    // （実際に変異で生き残った）。status 経路でしか落ちない形にする。
    const d = deps({
      fetch: vi.fn(async () => new Response(JSON.stringify({ uuid: 'CALL-1' }), { status: 400 })),
    });
    await expect(createVonageVoiceInitiator(d).initiate(COMMAND)).rejects.toThrow(/status 400/);
  });

  it('uuid が無い 2xx も失敗にする（相関を書けないまま発信済みになる）', async () => {
    const d = deps({
      fetch: vi.fn(async () => new Response(JSON.stringify({ status: 'started' }), { status: 201 })),
    });
    await expect(createVonageVoiceInitiator(d).initiate(COMMAND)).rejects.toThrow(/uuid/i);
  });

  it('エラーに秘密（JWT / private key）を含めない', async () => {
    const d = deps({
      fetch: vi.fn(async () => new Response('nope', { status: 401 })),
    });
    const err = await createVonageVoiceInitiator(d)
      .initiate(COMMAND)
      .catch((e: unknown) => e);
    const dump = `${String(err)} ${JSON.stringify((err as Error).cause ?? '')}`;
    expect(dump).not.toContain('TEST-JWT');
    expect(dump).not.toContain('TEST-KEY');
  });

  it('宛先が解決できなければ発信しない', async () => {
    const d = deps({ resolveNumber: async () => undefined });
    await expect(createVonageVoiceInitiator(d).initiate(COMMAND)).rejects.toThrow(/endpoint/i);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('key は endpoint の providerKey と突合できる値', () => {
    expect(createVonageVoiceInitiator(deps()).key).toBe('vonage-voice');
  });
});
