import {
  voiceTransportAuthProtocol,
  VOICE_TRANSPORT_WS_PROTOCOL,
} from '@/domain/voice-transport/protocol';
import type { VoiceTransportSocket, VoiceTransportSocketFactory } from './socket';

/** テスト差し替え用。実ブラウザでは global WebSocket を使う。 */
export type VoiceTransportWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => WebSocket;

class BrowserVoiceTransportSocket implements VoiceTransportSocket {
  onopen: (() => void) | null = null;
  onclose: ((info: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;

  constructor(private readonly socket: WebSocket) {
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => this.onopen?.();
    socket.onclose = (event) => this.onclose?.({ code: event.code, reason: event.reason });
    socket.onerror = (event) => this.onerror?.(event);
    socket.onmessage = (event) => this.onmessage?.(event.data);
  }

  send(chunk: ArrayBuffer): void {
    this.socket.send(chunk);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

/**
 * 1 個の短命 token を 1 回の WebSocket 接続にだけ閉じ込める factory。
 * token は URL へ入れず `Sec-WebSocket-Protocol` で送る。
 */
export function createBrowserVoiceTransportSocketFactory(
  token: string,
  WebSocketImpl: VoiceTransportWebSocketConstructor = WebSocket,
): VoiceTransportSocketFactory {
  if (!token) throw new Error('voice transport token is required');
  const protocols = [VOICE_TRANSPORT_WS_PROTOCOL, voiceTransportAuthProtocol(token)];

  return (url: string) =>
    new BrowserVoiceTransportSocket(new WebSocketImpl(url, protocols));
}

/**
 * `VoiceTransportClient.prepareSocketFactory` 用の helper。
 * 呼ばれるたび `getFreshToken()` を実行するため、初回・reconnect の各 socket が別 token/jti を使う。
 */
export function createRefreshingVoiceTransportSocketPreparer(
  getFreshToken: () => Promise<string>,
  WebSocketImpl: VoiceTransportWebSocketConstructor = WebSocket,
): () => Promise<VoiceTransportSocketFactory> {
  return async () => {
    const token = await getFreshToken();
    return createBrowserVoiceTransportSocketFactory(token, WebSocketImpl);
  };
}
