/**
 * エネルギー/確率閾値ベースの参照 VAD 実装 (issue #372)。
 *
 * `VadAdapter` contract（`types.ts`）に対する最小の参照実装。ハングオーバ（`hangoverMs`）を
 * 持たせて、瞬間的な無音を発話区間の終わりと誤認しないようにする（実 VAD の一般的な設計）。
 * Smart Turn 等の学習済みモデルへ置換する際は、この関数を差し替えるだけでよい
 * （呼び出し側は `VadAdapter.detectSegments` しか使わない）。
 */
import type { VadAdapter, VadFrame, VadSegment } from './types';

export type EnergyThresholdVadConfig = {
  /** これ以上の発話確率をフレームを「発話中」とみなす閾値。 */
  speechProbabilityThreshold: number;
  /**
   * 発話中と判定した後、この時間だけ確率が閾値を下回っても区間を継続する（ハングオーバ）。
   * 短い無音（子音の切れ目等）で区間が細切れになるのを防ぐ。
   */
  hangoverMs: number;
};

export const DEFAULT_ENERGY_THRESHOLD_VAD_CONFIG: EnergyThresholdVadConfig = {
  speechProbabilityThreshold: 0.5,
  hangoverMs: 200,
};

/**
 * フレーム列から音声区間を検出する。フレームは `tMs` 昇順であること（呼び出し側の責務。
 * ここでは検証しない —— 合成テストの入力は常に昇順で構築されるため）。
 */
export function detectVadSegments(
  frames: readonly VadFrame[],
  config: EnergyThresholdVadConfig = DEFAULT_ENERGY_THRESHOLD_VAD_CONFIG,
): VadSegment[] {
  const segments: VadSegment[] = [];
  let current: VadSegment | null = null;
  let lastAboveThresholdMs: number | null = null;

  for (const frame of frames) {
    const isSpeech = frame.speechProbability >= config.speechProbabilityThreshold;

    if (isSpeech) {
      lastAboveThresholdMs = frame.tMs;
      if (!current) current = { onsetMs: frame.tMs, offsetMs: null };
      continue;
    }

    if (current && lastAboveThresholdMs !== null && frame.tMs - lastAboveThresholdMs > config.hangoverMs) {
      current.offsetMs = lastAboveThresholdMs + config.hangoverMs;
      segments.push(current);
      current = null;
      lastAboveThresholdMs = null;
    }
  }

  if (current) segments.push(current); // 末尾まで発話中（offsetMs は null のまま = 未終端）。

  return segments;
}

/** 参照 `VadAdapter` 実装。 */
export class EnergyThresholdVadAdapter implements VadAdapter {
  constructor(private readonly config: EnergyThresholdVadConfig = DEFAULT_ENERGY_THRESHOLD_VAD_CONFIG) {}

  detectSegments(frames: readonly VadFrame[]): VadSegment[] {
    return detectVadSegments(frames, this.config);
  }
}
