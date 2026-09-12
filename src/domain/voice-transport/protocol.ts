/**
 * Voice Transport WSS wire contract (issue #369).
 *
 * Browser/client と Realtime Node gateway の双方が参照する純粋な定数・組み立て関数だけを置く。
 * 認証/ソケット/HTTP 依存は持たない。
 */
export const VOICE_TRANSPORT_WS_PATH = '/v1/voice';
export const VOICE_TRANSPORT_WS_PROTOCOL = 'open-reception.voice.v1';
export const VOICE_TRANSPORT_AUTH_PROTOCOL_PREFIX = 'auth.';

/** PCM16 mono 16kHz の 20ms / 40ms 分。heartbeat は別途 1 byte。 */
export const VOICE_TRANSPORT_MIN_AUDIO_FRAME_BYTES = (16_000 * 2 * 20) / 1000; // 640
export const VOICE_TRANSPORT_MAX_AUDIO_FRAME_BYTES = (16_000 * 2 * 40) / 1000; // 1280

export function voiceTransportAuthProtocol(token: string): string {
  return `${VOICE_TRANSPORT_AUTH_PROTOCOL_PREFIX}${token}`;
}

/** token は意図的に引数に取らない。credential を URL へ載せる API を作らない。 */
export function buildVoiceTransportRequestTarget(kioskId: string, receptionSessionId: string): string {
  return `${VOICE_TRANSPORT_WS_PATH}?kioskId=${encodeURIComponent(kioskId)}&receptionSessionId=${encodeURIComponent(receptionSessionId)}`;
}
