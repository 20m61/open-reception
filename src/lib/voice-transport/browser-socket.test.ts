import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  voiceTransportAuthProtocol,
  VOICE_TRANSPORT_WS_PROTOCOL,
} from '@/domain/voice-transport/protocol';
import {
  createBrowserVoiceTransportSocketFactory,
  createRefreshingVoiceTransportSocketPreparer,
  type VoiceTransportWebSocketConstructor,
} from './browser-socket';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  binaryType: BinaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
}

const FakeWebSocketImpl = FakeWebSocket as unknown as VoiceTransportWebSocketConstructor;

beforeEach(() => {
  FakeWebSocket.instances = [];
});

describe('browser VoiceTransportSocket adapter', () => {
  it('puts the short-lived token in subprotocol, never in the URL', () => {
    const token = 'signed.body-signature';
    const url = 'wss://realtime.example.invalid/v1/voice?kioskId=kiosk-1&receptionSessionId=reception-1';
    const socket = createBrowserVoiceTransportSocketFactory(token, FakeWebSocketImpl)(url);

    const native = FakeWebSocket.instances[0]!;
    expect(native.url).toBe(url);
    expect(native.url).not.toContain(token);
    expect(native.protocols).toEqual([VOICE_TRANSPORT_WS_PROTOCOL, voiceTransportAuthProtocol(token)]);
    expect(native.binaryType).toBe('arraybuffer');

    const chunk = new ArrayBuffer(640);
    socket.send(chunk);
    expect(native.send).toHaveBeenCalledWith(chunk);
  });

  it('adapts browser events to the transport socket interface', () => {
    const socket = createBrowserVoiceTransportSocketFactory('token-1', FakeWebSocketImpl)('wss://example.invalid');
    const native = FakeWebSocket.instances[0]!;
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    const onClose = vi.fn();
    socket.onopen = onOpen;
    socket.onmessage = onMessage;
    socket.onclose = onClose;

    native.onopen?.(new Event('open'));
    native.onmessage?.(new MessageEvent('message', { data: new ArrayBuffer(1) }));
    native.onclose?.({ code: 1006, reason: 'network' } as CloseEvent);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: 'network' });
  });

  it('fetches fresh auth material for every prepared connection', async () => {
    const getFreshToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2');
    const prepare = createRefreshingVoiceTransportSocketPreparer(getFreshToken, FakeWebSocketImpl);

    const firstFactory = await prepare();
    firstFactory('wss://example.invalid/v1/voice?kioskId=k&receptionSessionId=r');
    const secondFactory = await prepare();
    secondFactory('wss://example.invalid/v1/voice?kioskId=k&receptionSessionId=r');

    expect(getFreshToken).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances[0]!.protocols).toEqual([
      VOICE_TRANSPORT_WS_PROTOCOL,
      voiceTransportAuthProtocol('token-1'),
    ]);
    expect(FakeWebSocket.instances[1]!.protocols).toEqual([
      VOICE_TRANSPORT_WS_PROTOCOL,
      voiceTransportAuthProtocol('token-2'),
    ]);
  });
});
