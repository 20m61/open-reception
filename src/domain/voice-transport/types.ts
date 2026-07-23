/**
 * iPad 音声ストリーム Transport 層の共通型 (issue #369)。
 *
 * 位置づけ: 本モジュールは純データ型のみを持つ。I/O（WebSocket・AudioWorklet・署名検証）は
 * `src/lib/voice-transport/` が担う。STT/TTS/ターン判定などのプロバイダとは分離し、
 * 音声を「送る/受ける」経路だけを扱う（WebRTC/LiveKit へ置換可能な境界を保つ設計方針は
 * `docs/adr/0001-voice-transport.md` を参照）。
 *
 * 計測イベントは `src/domain/voice/evaluation-events.ts`（issue #365 契約）へ橋渡しする
 * （`eval-bridge.ts`）。本ファイルの型はその契約に依存しない Transport 固有語彙。
 */

/** MVP は mono PCM 16bit のみ（ADR 参照）。将来 codec を増やす場合はここへ追加する。 */
export type VoiceTransportEncoding = 'pcm16';

/** AudioWorklet が送出するチャンクの物理フォーマット。 */
export type VoiceTransportAudioConfig = {
  sampleRateHz: number;
  bitDepth: 16;
  channels: 1;
  /** 1 チャンクの長さ（ms）。初期値 20〜40ms（実測確定は #65）。 */
  chunkMs: number;
  encoding: VoiceTransportEncoding;
};

/** issue #369 の初期方針（ADR 決定値）。 */
export const DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG: VoiceTransportAudioConfig = {
  sampleRateHz: 16000,
  bitDepth: 16,
  channels: 1,
  chunkMs: 20,
  encoding: 'pcm16',
};

const MIN_CHUNK_MS = 20;
const MAX_CHUNK_MS = 40;

/** audio config が ADR の許容範囲内か（実装ミスの早期検出用）。 */
export function isValidVoiceTransportAudioConfig(config: VoiceTransportAudioConfig): boolean {
  return (
    Number.isFinite(config.sampleRateHz) &&
    config.sampleRateHz > 0 &&
    config.bitDepth === 16 &&
    config.channels === 1 &&
    config.encoding === 'pcm16' &&
    Number.isFinite(config.chunkMs) &&
    config.chunkMs >= MIN_CHUNK_MS &&
    config.chunkMs <= MAX_CHUNK_MS
  );
}

/**
 * 接続トークンが束ねる主体。`tenantId/siteId/kioskId/receptionSessionId` の全境界を
 * 明示的に持つ（issue #369 セキュリティ要件）。
 */
export type VoiceTransportTokenClaims = {
  tenantId: string;
  siteId: string;
  kioskId: string;
  receptionSessionId: string;
  /** 単回性・リプレイ拒否用の識別子。 */
  jti: string;
};

/** クライアントが接続時に主張する文脈（サーバ権威の claims と突き合わせる）。 */
export type VoiceTransportConnectionContext = {
  tenantId: string;
  siteId: string;
  kioskId: string;
  receptionSessionId: string;
};

export const VOICE_TRANSPORT_TOKEN_REJECTION_REASONS = [
  'malformed',
  'expired',
  'replayed',
  'tenant_mismatch',
  'site_mismatch',
  'kiosk_mismatch',
  'reception_mismatch',
] as const;

export type VoiceTransportTokenRejectionReason = (typeof VOICE_TRANSPORT_TOKEN_REJECTION_REASONS)[number];
