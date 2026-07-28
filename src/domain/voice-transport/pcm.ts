/**
 * マイク入力 → 送出チャンクへの変換（純ロジック）(issue #369 / `docs/adr/0001-voice-transport.md`)。
 *
 * AudioWorklet が受け取るのは「AudioContext の sampleRate（iPad Safari では通常 48kHz）の
 * Float32（-1..1）」で、Transport が送るのは「16kHz / 16bit / mono / 20ms」（ADR 決定値）。
 * その落差を埋める変換をここに閉じ込め、**AudioWorklet 側は薄い殻**にする。
 *
 * こうする理由: AudioWorklet は `AudioWorkletGlobalScope` でしか動かず、ブラウザ無しでは
 * 検証できない。変換の中身（クリップ・リサンプル・チャンク境界）こそバグが出る場所なので、
 * そこを純関数へ出して unit で固定する。実機での遅延・精度計測は #65。
 *
 * 本モジュールは I/O を持たない（`src/domain/**` の規約）。
 */
import {
  DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG,
  type VoiceTransportAudioConfig,
} from './types';

export { DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG };

const INT16_MAX = 32767;
const INT16_MIN = -32768;

/**
 * Float32（-1..1）を Int16 PCM へ変換する。
 *
 * 範囲外は**折り返さずクリップ**する。wrap-around すると大音量が逆位相の大音量に化けて
 * 耳障りなノイズになるため、飽和させる方が安全。NaN / Infinity は 0（無音）に倒す。
 */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const raw = samples[i] as number;
    if (!Number.isFinite(raw)) {
      out[i] = 0;
      continue;
    }
    // 負側 32768 / 正側 32767 でスケールし、Int16 のフルレンジを使う（WebAudio → PCM16 の
    // 慣行）。一律 32767 倍にすると full-scale の負が -32767 止まりで 1 LSB ぶん狭くなる。
    const scaled = Math.round(raw < 0 ? raw * -INT16_MIN : raw * INT16_MAX);
    out[i] = scaled > INT16_MAX ? INT16_MAX : scaled < INT16_MIN ? INT16_MIN : scaled;
  }
  return out;
}

/**
 * 入力レートから目標レートへダウンサンプルする。
 *
 * 区間平均（box filter）で間引く。単純な間引き（decimation）だとエイリアスが乗るため、
 * 各出力サンプルに対応する入力区間を平均する。定常信号で振幅が痩せないことをテストで固定。
 *
 * `inputRate <= targetRate` のときはアップサンプルせず入力をそのまま返す（Transport は
 * ダウンサンプルのみを想定する。低レートマイクの扱いは上位の責務）。
 */
export function downsampleTo(
  samples: Float32Array,
  inputRateHz: number,
  targetRateHz: number,
): Float32Array {
  if (samples.length === 0) return new Float32Array(0);
  if (!Number.isFinite(inputRateHz) || !Number.isFinite(targetRateHz)) return samples;
  if (inputRateHz <= targetRateHz) return samples;

  const ratio = inputRateHz / targetRateHz;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += samples[j] as number;
      count += 1;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

/** チャンク 1 つあたりのサンプル数（20ms @ 16kHz = 320）。 */
export function samplesPerChunk(config: VoiceTransportAudioConfig): number {
  return Math.round((config.sampleRateHz * config.chunkMs) / 1000);
}

export type VoiceChunker = {
  /** サンプルを積み、揃ったぶんのチャンクを返す。揃わなければ空配列。 */
  push(samples: Float32Array): Float32Array[];
  /** 端数をゼロ埋めして 1 チャンクとして取り出す。端数が無ければ null。 */
  flush(): Float32Array | null;
  /** 現在保持している端数のサンプル数（テスト・監視用）。 */
  pendingSamples(): number;
};

/**
 * 一定長のチャンクへ切り出す。**端数はキャリーして次の push と繋ぐ。**
 *
 * AudioWorklet の render quantum は 128 サンプル固定で、320（20ms @ 16kHz）の倍数に
 * ならない。端数を捨てると 20ms ごとに音が欠け、認識精度に直接効く。保持は常に
 * 1 チャンク未満なので、chunker 自体がメモリを膨らませることはない
 * （backpressure は `queue.ts` の責務）。
 */
export function createChunker(
  config: VoiceTransportAudioConfig = DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG,
): VoiceChunker {
  const size = samplesPerChunk(config);
  let carry = new Float32Array(0);

  return {
    push(samples: Float32Array): Float32Array[] {
      const merged = new Float32Array(carry.length + samples.length);
      merged.set(carry, 0);
      merged.set(samples, carry.length);

      const chunks: Float32Array[] = [];
      let offset = 0;
      while (merged.length - offset >= size) {
        chunks.push(merged.slice(offset, offset + size));
        offset += size;
      }
      carry = merged.slice(offset);
      return chunks;
    },

    flush(): Float32Array | null {
      if (carry.length === 0) return null;
      const chunk = new Float32Array(size);
      chunk.set(carry, 0);
      carry = new Float32Array(0);
      return chunk;
    },

    pendingSamples(): number {
      return carry.length;
    },
  };
}
