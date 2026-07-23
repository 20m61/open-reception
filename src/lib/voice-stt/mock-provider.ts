/**
 * `StreamingSttProvider` の mock 実装 (issue #370)。
 *
 * 実ブラウザ/実 AWS 認証情報を前提とする Amazon Transcribe Streaming 接続は #65 にスタックする。
 * ここでは「決まったスクリプトに沿って partial/final を返す」provider を用意し、
 * `SttSession` 契約・partial 安定化（`src/domain/voice-stt/stabilizer.ts`）・Entity 解決を
 * オフラインでテスト可能にする。
 *
 * `pushAudio` の呼び出し回数を「chunk」として数え、スクリプトの `afterChunk` に一致した時点で
 * raw partial（`stable: false`）を発火する。同時に内部で `ingestRawPartial` を通し、
 * stabilizer が新しい stable partial を確定したら追加で `stable: true` のイベントも発火する
 * （UI 字幕にはこちらだけを表示する前提、issue #370 AC）。
 */
import { DEFAULT_STT_STABILIZER_CONFIG, emptyStabilizerState, ingestRawPartial } from '@/domain/voice-stt/stabilizer';
import type {
  FinalTranscript,
  PartialTranscript,
  SttSession,
  SttSessionConfig,
  SttStabilizerConfig,
  StreamingSttProvider,
} from '@/domain/voice-stt/types';

export type MockSttScriptStep = {
  /** この chunk 数目の `pushAudio` で発火する（1 始まり）。 */
  afterChunk: number;
  text: string;
  confidence: number;
};

export type MockSttScript = {
  /** raw（unstable）partial を到着順に並べたもの。 */
  partials: MockSttScriptStep[];
  final: MockSttScriptStep;
};

export function createMockSttProvider(
  script: MockSttScript,
  stabilizerConfig?: Partial<SttStabilizerConfig>,
): StreamingSttProvider {
  return {
    start: async (config: SttSessionConfig): Promise<SttSession> => {
      const chunkMs = config.audio.chunkMs;
      let chunkCount = 0;
      let closed = false;
      let finalEmitted = false;
      let stabilizerState = emptyStabilizerState();
      const partialListeners: Array<(result: PartialTranscript) => void> = [];
      const finalListeners: Array<(result: FinalTranscript) => void> = [];
      const effectiveStabilizerConfig: SttStabilizerConfig = {
        ...DEFAULT_STT_STABILIZER_CONFIG,
        ...config.stabilizer,
        ...stabilizerConfig,
      };

      return {
        pushAudio: async () => {
          if (closed || finalEmitted) return;
          chunkCount += 1;
          const tMs = chunkCount * chunkMs;

          const partialStep = script.partials.find((p) => p.afterChunk === chunkCount);
          if (partialStep) {
            const raw: PartialTranscript = {
              text: partialStep.text,
              stable: false,
              confidence: partialStep.confidence,
              t: tMs,
            };
            partialListeners.forEach((listener) => listener(raw));

            const stabilized = ingestRawPartial(stabilizerState, partialStep.text, tMs, effectiveStabilizerConfig);
            stabilizerState = stabilized.state;
            if (stabilized.stable !== null) {
              const stable: PartialTranscript = {
                text: stabilized.stable,
                stable: true,
                confidence: partialStep.confidence,
                t: tMs,
              };
              partialListeners.forEach((listener) => listener(stable));
            }
          }

          if (!finalEmitted && script.final.afterChunk === chunkCount) {
            finalEmitted = true;
            const final: FinalTranscript = { text: script.final.text, confidence: script.final.confidence, t: tMs };
            finalListeners.forEach((listener) => listener(final));
          }
        },
        onPartial: (listener) => {
          partialListeners.push(listener);
        },
        onFinal: (listener) => {
          finalListeners.push(listener);
        },
        close: async () => {
          closed = true;
        },
      };
    },
  };
}
