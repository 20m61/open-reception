import { describe, expect, it } from 'vitest';

import { DEFAULT_ENERGY_THRESHOLD_VAD_CONFIG, EnergyThresholdVadAdapter, detectVadSegments } from './vad';
import type { VadFrame } from './types';

function frame(tMs: number, speechProbability: number): VadFrame {
  return { tMs, speechProbability };
}

describe('detectVadSegments', () => {
  it('単一の発話区間を検出する', () => {
    const frames = [frame(0, 0), frame(100, 0.9), frame(200, 0.9), frame(300, 0.9), frame(400, 0)];
    const segments = detectVadSegments(frames, { speechProbabilityThreshold: 0.5, hangoverMs: 50 });
    expect(segments).toEqual([{ onsetMs: 100, offsetMs: 350 }]);
  });

  it('ハングオーバ内の短い無音は区間を分断しない', () => {
    const frames = [
      frame(0, 0.9), // onset
      frame(100, 0.1), // 瞬間的な落ち込み（ハングオーバ内）
      frame(150, 0.9), // 発話再開
      frame(400, 0), // 十分に無音が続く → 終端
    ];
    const segments = detectVadSegments(frames, { speechProbabilityThreshold: 0.5, hangoverMs: 200 });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.onsetMs).toBe(0);
  });

  it('ハングオーバを超える無音は区間を分ける（2 発話）', () => {
    const frames = [
      frame(0, 0.9),
      frame(100, 0),
      frame(500, 0), // 400ms 以上無音 → 最初の区間は終端
      frame(600, 0.9), // 2 発話目
      frame(700, 0),
      frame(1100, 0),
    ];
    const segments = detectVadSegments(frames, { speechProbabilityThreshold: 0.5, hangoverMs: 200 });
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ onsetMs: 0, offsetMs: 200 });
    expect(segments[1]).toEqual({ onsetMs: 600, offsetMs: 800 });
  });

  it('末尾まで発話中の区間は offsetMs が null（未終端。捨てない）', () => {
    const frames = [frame(0, 0.9), frame(100, 0.9), frame(200, 0.9)];
    const segments = detectVadSegments(frames, DEFAULT_ENERGY_THRESHOLD_VAD_CONFIG);
    expect(segments).toEqual([{ onsetMs: 0, offsetMs: null }]);
  });

  it('発話が一度も無ければ空配列', () => {
    expect(detectVadSegments([frame(0, 0), frame(100, 0.1)], DEFAULT_ENERGY_THRESHOLD_VAD_CONFIG)).toEqual([]);
  });
});

describe('EnergyThresholdVadAdapter', () => {
  it('VadAdapter contract を満たす（detectSegments が同じ結果を返す）', () => {
    const adapter = new EnergyThresholdVadAdapter({ speechProbabilityThreshold: 0.5, hangoverMs: 100 });
    const frames = [frame(0, 0.9), frame(50, 0.9), frame(300, 0)];
    expect(adapter.detectSegments(frames)).toEqual(detectVadSegments(frames, { speechProbabilityThreshold: 0.5, hangoverMs: 100 }));
  });
});
