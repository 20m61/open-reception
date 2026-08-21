import { describe, expect, it, vi } from 'vitest';
import {
  createVonageVoiceInitiator,
  NCCO_RESPONSE_BUDGET_MS,
  VONAGE_VOICE_REQUEST_TIMEOUT_MS,
  type VonageVoiceDeps,
} from './vonage-voice-initiator';
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

/**
 * 発信 HTTP に上限を作る (#744)。
 *
 * ## 事実
 *
 * `/choice` は担当者の選択を相関へ書き、**必要なら次の手を撃ってから** talk（受領応答）を
 * 返す。順序は意図的で、先に返すと担当者が切って `completed` が先に届いたときに取次が
 * 次の手へ進む（#742 の B1 が塞いだ事故そのもの）。
 *
 * だが `POST /v1/calls` の `fetch` に**タイムアウトが無かった**ので、上限が無い。Vonage の
 * webhook タイムアウトが先に来ると、route が宣言している不変条件
 * 「**どの選択でも必ず音声で応答する**」が崩れる ── 担当者は自分の入力が届いたか
 * 分からないまま切る。
 */
describe('発信 HTTP の上限 (#744)', () => {
  it('🔴 中断シグナルを渡す（上限のない発信をしない）', async () => {
    const d = deps();
    await createVonageVoiceInitiator(d).initiate(COMMAND);
    const [, init] = (d.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.signal, '上限が無いと担当者への応答が返らないことがある').toBeDefined();
    expect(init.signal?.aborted).toBe(false);
  });

  /**
   * 🔴 上限は **NCCO 応答の予算より短い**こと。長いと、上限に達する前に Vonage 側の
   * webhook タイムアウトが先に来て、結局担当者へ応答が返らない。
   */
  it('🔴 上限は NCCO 応答の予算より短い', () => {
    expect(VONAGE_VOICE_REQUEST_TIMEOUT_MS).toBeLessThan(NCCO_RESPONSE_BUDGET_MS);
    expect(VONAGE_VOICE_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('中断された発信は失敗として上へ返す（握り潰さない）', async () => {
    const d = deps({
      fetch: vi.fn(async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }),
    });
    await expect(createVonageVoiceInitiator(d).initiate(COMMAND)).rejects.toThrow();
  });
});
