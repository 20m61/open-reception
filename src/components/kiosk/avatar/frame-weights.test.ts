import { describe, it, expect } from 'vitest';
import { resolveFrameExpressionWeights } from './frame-weights';
import { mouthOpenValue } from './lip-sync';
import { AVATAR_EXPRESSIONS } from './guidance';
import {
  blendExpressionWeights,
  EMOTION_MOUTH_MIN_SCALE,
  KNOWN_EXPRESSION_NAMES,
} from '@/domain/avatar/expression-blend';
import {
  createAutoBlinkState,
  stepAutoBlink,
  BLINK_DURATION_MS,
  BLINK_MAX_INTERVAL_MS,
} from '@/domain/avatar/auto-blink';

/**
 * VrmAvatarViewer は three.js を動的 import するため jsdom で描画そのものは検証できない。
 * 代わりに「毎フレーム expressionManager.setValue() へ渡す値を算出する」部分をここへ切り出し、
 * viewer が合成関数（#31 感情連動リップシンク + まばたき抑制）を通していることを固定する。
 */
describe('resolveFrameExpressionWeights (#31 — VRM viewer 結線の単体固定)', () => {
  it('非発話中は neutral でも感情付きでも口の開き重みは 0', () => {
    for (const expression of AVATAR_EXPRESSIONS) {
      const result = resolveFrameExpressionWeights({
        expression,
        speaking: false,
        elapsedSec: 1.23,
      });
      expect(result.mouthAa).toBe(0);
    }
  });

  it('neutral 発話中は従来の mouthOpenValue と完全に一致する（非退行）', () => {
    for (let t = 0; t < 2; t += 0.11) {
      const result = resolveFrameExpressionWeights({
        expression: 'neutral',
        speaking: true,
        elapsedSec: t,
      });
      expect(result.mouthAa).toBe(mouthOpenValue(t, true));
    }
  });

  it('感情付き表情・発話中はフル強度で口の開き重みが減衰する', () => {
    const t = 0.1; // mouthOpenValue(0.1, true) > 0 になる時刻
    const raw = mouthOpenValue(t, true);
    expect(raw).toBeGreaterThan(0);
    const result = resolveFrameExpressionWeights({
      expression: 'happy',
      speaking: true,
      elapsedSec: t,
    });
    expect(result.mouthAa).toBeCloseTo(raw * EMOTION_MOUTH_MIN_SCALE);
  });

  it('blinkBaseWeight を渡すと感情付き表情中はまばたきが抑制される', () => {
    const result = resolveFrameExpressionWeights({
      expression: 'concerned',
      speaking: false,
      elapsedSec: 0,
      blinkBaseWeight: 1,
    });
    expect(result.blink).toBe(0);
  });

  it('blinkBaseWeight 省略時は neutral/感情付き問わず blink は 0（fail-safe な既定値）', () => {
    for (const expression of AVATAR_EXPRESSIONS) {
      const result = resolveFrameExpressionWeights({ expression, speaking: false, elapsedSec: 0 });
      expect(result.blink).toBe(0);
    }
  });

  it('expressionIntensity 0 は感情付き表情でも neutral と同じ重みになる', () => {
    const t = 0.1;
    const result = resolveFrameExpressionWeights({
      expression: 'happy',
      expressionIntensity: 0,
      speaking: true,
      elapsedSec: t,
    });
    expect(result.mouthAa).toBe(mouthOpenValue(t, true));
  });

  it('resolveFrameExpressionWeights は blendExpressionWeights の合成結果をそのまま返す', () => {
    const t = 0.1;
    const expected = blendExpressionWeights({
      expression: 'happy',
      intensity: 0.6,
      mouthOpenWeight: mouthOpenValue(t, true),
      blinkWeight: 1,
    });
    const result = resolveFrameExpressionWeights({
      expression: 'happy',
      expressionIntensity: 0.6,
      speaking: true,
      elapsedSec: t,
      blinkBaseWeight: 1,
    });
    expect(result).toEqual({ mouthAa: expected.mouthOpenWeight, blink: expected.blinkWeight });
  });

  it('guidance.ts の AVATAR_EXPRESSIONS は domain 側の KNOWN_EXPRESSION_NAMES と完全一致する（ドリフト検知）', () => {
    expect([...AVATAR_EXPRESSIONS].sort()).toEqual([...KNOWN_EXPRESSION_NAMES].sort());
  });

  describe('auto-blink 接続（issue #31 増分 — 周期駆動と blinkBaseWeight 接続）', () => {
    it('neutral 時は auto-blink の周期的な重みがそのまま blink に反映される（感情抑制が効かない）', () => {
      const state = createAutoBlinkState(21);
      const blinkStart = stepAutoBlink(state, state.nextBlinkAtMs);
      const midBlinkMs = state.nextBlinkAtMs + BLINK_DURATION_MS / 2;
      const midFrame = stepAutoBlink(blinkStart.state, midBlinkMs);
      expect(midFrame.weight).toBeGreaterThan(0.9); // まばたき中間点でほぼ全閉

      const result = resolveFrameExpressionWeights({
        expression: 'neutral',
        speaking: false,
        elapsedSec: midBlinkMs / 1000,
        blinkBaseWeight: midFrame.weight,
      });
      expect(result.blink).toBe(midFrame.weight);
    });

    it('感情付き表情中は auto-blink の周期的な重みがあっても既存合成で抑制される', () => {
      const state = createAutoBlinkState(21);
      const blinkStart = stepAutoBlink(state, state.nextBlinkAtMs);
      const midBlinkMs = state.nextBlinkAtMs + BLINK_DURATION_MS / 2;
      const midFrame = stepAutoBlink(blinkStart.state, midBlinkMs);
      expect(midFrame.weight).toBeGreaterThan(0.9);

      const result = resolveFrameExpressionWeights({
        expression: 'happy',
        speaking: false,
        elapsedSec: midBlinkMs / 1000,
        blinkBaseWeight: midFrame.weight,
      });
      expect(result.blink).toBe(0); // EMOTION_BLINK_MIN_SCALE=0 により全抑制（既存合成、重複制御しない）
    });

    it('待機区間中（まばたき動作外）は auto-blink の重みが0のため blink も0', () => {
      const state = createAutoBlinkState(21);
      const beforeBlinkMs = Math.max(0, state.nextBlinkAtMs - 500);
      const idleFrame = stepAutoBlink(state, beforeBlinkMs);
      expect(idleFrame.weight).toBe(0);

      const result = resolveFrameExpressionWeights({
        expression: 'neutral',
        speaking: false,
        elapsedSec: beforeBlinkMs / 1000,
        blinkBaseWeight: idleFrame.weight,
      });
      expect(result.blink).toBe(0);
    });

    it('複数フレームを連続で流すと neutral 時に周期的な blink 重みの山が観測できる', () => {
      let state = createAutoBlinkState(5);
      let observedNonZero = 0;
      const stepMs = 16; // 概ね60fps相当のフレーム刻み
      // 設計上の最大間隔 + 動作時間を十分にカバーする範囲を歩かせる
      const totalMs = BLINK_MAX_INTERVAL_MS + BLINK_DURATION_MS + 1000;
      for (let t = 0; t <= totalMs; t += stepMs) {
        const frame = stepAutoBlink(state, t);
        state = frame.state;
        const result = resolveFrameExpressionWeights({
          expression: 'neutral',
          speaking: false,
          elapsedSec: t / 1000,
          blinkBaseWeight: frame.weight,
        });
        if (result.blink > 0) observedNonZero++;
        // neutral 中は抑制されないため auto-blink の重みと常に一致する
        expect(result.blink).toBe(frame.weight);
      }
      expect(observedNonZero).toBeGreaterThan(0);
    });
  });
});
