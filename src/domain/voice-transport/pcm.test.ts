/**
 * マイク入力 → 送出チャンクへの変換（純ロジック）のテスト (issue #369 / ADR 0001)。
 *
 * AudioWorklet が受け取るのは「AudioContext の sampleRate（iPad Safari では通常 48kHz）の
 * Float32（-1..1）」で、Transport が送るのは「16kHz / 16bit / mono / 20ms」。この落差を
 * 埋めるのが本モジュール。**変換の中身は純関数**にして、AudioWorklet 側は薄い殻にする
 * （ブラウザ API 無しで検証できるようにするため。実機計測は #65）。
 *
 * 20ms @ 16kHz = 320 サンプル = 640 バイト。
 */
import { describe, expect, it } from 'vitest';
import {
  floatToPcm16,
  downsampleTo,
  samplesPerChunk,
  createChunker,
  DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG,
} from './pcm';

describe('floatToPcm16 — Float32(-1..1) → Int16', () => {
  it('0 は 0 に写る', () => {
    expect(Array.from(floatToPcm16(Float32Array.of(0)))).toEqual([0]);
  });

  it('正負の全振幅が Int16 の範囲に収まる', () => {
    const out = floatToPcm16(Float32Array.of(1, -1));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
  });

  it('範囲外の入力を折り返さずクリップする（歪みより飽和を選ぶ）', () => {
    // クリップし忘れると Int16 変換で wrap-around が起き、大音量が「逆位相の大音量」に
    // 化けて耳障りなノイズになる。飽和させる方が安全。
    const out = floatToPcm16(Float32Array.of(2, -2, 1.5, -1.5));
    expect(Array.from(out)).toEqual([32767, -32768, 32767, -32768]);
  });

  it('NaN / Infinity は 0 として扱う（無音に倒す）', () => {
    const out = floatToPcm16(Float32Array.of(NaN, Infinity, -Infinity));
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('長さが保たれる', () => {
    expect(floatToPcm16(new Float32Array(320)).length).toBe(320);
  });
});

describe('downsampleTo — 入力レート → 16kHz', () => {
  it('同じレートなら入力をそのまま返す', () => {
    // Float32 で正確に表せる値を使う（0.1 は Float32 へ丸められ Float64 リテラルと一致しない）。
    const input = Float32Array.of(0.25, 0.5, -0.75);
    expect(Array.from(downsampleTo(input, 16000, 16000))).toEqual([0.25, 0.5, -0.75]);
  });

  it('48kHz → 16kHz でサンプル数が 1/3 になる', () => {
    const input = new Float32Array(48000).fill(0.5);
    expect(downsampleTo(input, 48000, 16000).length).toBe(16000);
  });

  it('44.1kHz のような非整数比でも比率どおりの長さになる', () => {
    const input = new Float32Array(44100);
    // 44100 → 16000 は 1 秒ぶん。端数は切り捨てる。
    expect(downsampleTo(input, 44100, 16000).length).toBe(16000);
  });

  it('定常信号は値が保たれる（平均化で振幅が痩せない）', () => {
    const input = new Float32Array(300).fill(0.25);
    const out = downsampleTo(input, 48000, 16000);
    for (const v of out) expect(v).toBeCloseTo(0.25, 5);
  });

  it('アップサンプルは要求しない（入力 < 目標なら空を返さず入力をそのまま返す）', () => {
    // Transport はダウンサンプルのみを想定する。8kHz マイク等は上位で弾く。
    const input = Float32Array.of(0.25, 0.5);
    expect(Array.from(downsampleTo(input, 8000, 16000))).toEqual([0.25, 0.5]);
  });

  it('空入力は空を返す', () => {
    expect(downsampleTo(new Float32Array(0), 48000, 16000).length).toBe(0);
  });
});

describe('samplesPerChunk — チャンクあたりのサンプル数', () => {
  it('既定（16kHz / 20ms）は 320 サンプル', () => {
    expect(samplesPerChunk(DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG)).toBe(320);
  });

  it('40ms なら 640 サンプル', () => {
    expect(samplesPerChunk({ ...DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG, chunkMs: 40 })).toBe(640);
  });
});

describe('createChunker — 端数を跨いで一定長のチャンクへ切り出す', () => {
  it('ちょうど 1 チャンク分でチャンクが 1 つ出る', () => {
    const chunker = createChunker(DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG);
    const out = chunker.push(new Float32Array(320));
    expect(out.length).toBe(1);
    expect(out[0]!.length).toBe(320);
  });

  it('足りない間は何も出さず、溜まった時点で出す', () => {
    const chunker = createChunker(DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG);
    expect(chunker.push(new Float32Array(200)).length).toBe(0);
    expect(chunker.push(new Float32Array(200)).length).toBe(1);
  });

  it('1 回の push から複数チャンクを取り出せる', () => {
    const chunker = createChunker(DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG);
    const out = chunker.push(new Float32Array(320 * 3));
    expect(out.length).toBe(3);
  });

  it('端数はキャリーされ、次の push と繋がって連続性が保たれる', () => {
    // AudioWorklet の render quantum は 128 サンプル固定で、320 の倍数にならない。
    // 端数を捨てると 20ms ごとに音が欠ける（実際に音声認識精度へ効く）。
    const chunker = createChunker(DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG);
    const emitted: number[] = [];
    let value = 0;
    for (let i = 0; i < 10; i += 1) {
      const quantum = new Float32Array(128);
      for (let j = 0; j < 128; j += 1) {
        quantum[j] = value;
        value += 1;
      }
      for (const chunk of chunker.push(quantum)) emitted.push(...chunk);
    }
    // 1280 サンプル入れたので 320 × 4 = 1280 ちょうど出る。
    expect(emitted.length).toBe(1280);
    // 値が 0,1,2,... と連続している＝欠落も重複もしていない。
    expect(emitted).toEqual(Array.from({ length: 1280 }, (_, i) => i));
  });

  it('flush で端数を取り出せる（ゼロ埋めして 1 チャンクにする）', () => {
    const chunker = createChunker(DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG);
    chunker.push(Float32Array.of(1, 2, 3));
    const tail = chunker.flush();
    expect(tail).not.toBeNull();
    expect(tail!.length).toBe(320);
    expect(Array.from(tail!.slice(0, 3))).toEqual([1, 2, 3]);
    expect(tail![319]).toBe(0);
  });

  it('端数が無ければ flush は null（無音チャンクを送らない）', () => {
    const chunker = createChunker(DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG);
    chunker.push(new Float32Array(320));
    expect(chunker.flush()).toBeNull();
  });

  it('flush 後は内部バッファが空になる（二重送出しない）', () => {
    const chunker = createChunker(DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG);
    chunker.push(Float32Array.of(1, 2, 3));
    chunker.flush();
    expect(chunker.flush()).toBeNull();
  });

  it('バッファは無制限に伸びない（push しても保持は 1 チャンク未満）', () => {
    // backpressure は queue.ts の責務だが、chunker 自体が溜め込むと二重に膨らむ。
    const chunker = createChunker(DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG);
    for (let i = 0; i < 100; i += 1) chunker.push(new Float32Array(128));
    expect(chunker.pendingSamples()).toBeLessThan(320);
  });
});
