/**
 * Mock `StreamingTtsProvider` (issue #371)。
 *
 * 実 Amazon Polly（ストリーミング合成・Speech Marks 取得）は AWS 認証情報と実配信境界が要るため
 * #65（外部待ち）。この increment はこの mock provider のみで #371 の AC を検証する
 * （`docs/loop-workflow.md` の「外部認証情報・実機・アセットが要る検証は #65」方針）。
 *
 * 決定的で高速（実タイマー無し）: `synthesize` はテキスト長からチャンク数を導出し、即座に
 * 全チャンクを yield する。実 provider 差し替え時もこの interface のまま置き換えられる。
 */
import { resolveSpeechText, type StreamingTtsProvider, type TtsAudioChunk, type TtsRequest } from '@/domain/voice-tts/types';

const CHARS_PER_CHUNK = 8;
const CHUNK_MS = 20;
const MOCK_BYTE_LENGTH_PER_CHUNK = 640; // 20ms @16kHz/16bit mono 相当のダミー値。

export class MockStreamingTtsProvider implements StreamingTtsProvider {
  private readonly aborted = new Set<string>();

  async *synthesize(request: TtsRequest): AsyncIterable<TtsAudioChunk> {
    this.aborted.delete(request.utteranceId);
    const text = resolveSpeechText(request.text);
    const total = Math.max(1, Math.ceil(text.length / CHARS_PER_CHUNK));

    for (let seq = 0; seq < total; seq += 1) {
      // 各チャンクの生成前に中止フラグを確認する（既に yield 済みのチャンクは取り消さない —
      // AsyncIterable の消費側が既に受け取ったものは戻せないため、「以降を出さない」が中止の意味）。
      if (this.aborted.has(request.utteranceId)) return;
      yield {
        utteranceId: request.utteranceId,
        seq,
        audioTimestampMs: seq * CHUNK_MS,
        byteLength: MOCK_BYTE_LENGTH_PER_CHUNK,
        final: seq === total - 1,
      };
    }
  }

  async abortGeneration(utteranceId: string): Promise<void> {
    this.aborted.add(utteranceId);
  }
}
