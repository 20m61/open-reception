import { describe, it, expect } from 'vitest';
import {
  blendExpressionWeights,
  EMOTION_MOUTH_MIN_SCALE,
  EMOTION_BLINK_MIN_SCALE,
  KNOWN_EXPRESSION_NAMES,
  NEUTRAL_EXPRESSION,
} from './expression-blend';

describe('expression-blend (#31 — 感情連動リップシンク + まばたき抑制)', () => {
  it('neutral は強度に関わらず重みを一切変えない（不変）', () => {
    for (const intensity of [0, 0.3, 0.5, 1]) {
      const result = blendExpressionWeights({
        expression: 'neutral',
        intensity,
        mouthOpenWeight: 0.7,
        blinkWeight: 1,
      });
      expect(result).toEqual({ mouthOpenWeight: 0.7, blinkWeight: 1 });
    }
  });

  it('既定(感情入力なし = neutral・intensity 省略)で従来と同一の重みになる（非退行）', () => {
    const result = blendExpressionWeights({
      expression: NEUTRAL_EXPRESSION,
      mouthOpenWeight: 0.42,
      blinkWeight: 1,
    });
    expect(result).toEqual({ mouthOpenWeight: 0.42, blinkWeight: 1 });
  });

  it('感情付き表情・強度 0 は neutral と同じ（減衰なし）', () => {
    const result = blendExpressionWeights({
      expression: 'happy',
      intensity: 0,
      mouthOpenWeight: 0.7,
      blinkWeight: 1,
    });
    expect(result).toEqual({ mouthOpenWeight: 0.7, blinkWeight: 1 });
  });

  it('感情付き表情・強度 1 は口の開き重みを EMOTION_MOUTH_MIN_SCALE まで減衰する', () => {
    const result = blendExpressionWeights({
      expression: 'happy',
      intensity: 1,
      mouthOpenWeight: 0.7,
      blinkWeight: 1,
    });
    expect(result.mouthOpenWeight).toBeCloseTo(0.7 * EMOTION_MOUTH_MIN_SCALE);
  });

  it('感情付き表情・強度 1 はまばたき重みを EMOTION_BLINK_MIN_SCALE（抑制）にする', () => {
    const result = blendExpressionWeights({
      expression: 'concerned',
      intensity: 1,
      mouthOpenWeight: 0.7,
      blinkWeight: 1,
    });
    expect(result.blinkWeight).toBeCloseTo(1 * EMOTION_BLINK_MIN_SCALE);
  });

  it('intensity 省略時は感情付き表情ならフル適用(=1)扱いになる', () => {
    const withDefault = blendExpressionWeights({
      expression: 'happy',
      mouthOpenWeight: 0.7,
      blinkWeight: 1,
    });
    const withExplicit1 = blendExpressionWeights({
      expression: 'happy',
      intensity: 1,
      mouthOpenWeight: 0.7,
      blinkWeight: 1,
    });
    expect(withDefault).toEqual(withExplicit1);
  });

  it('強度は 0..1 の中間で線形に減衰する', () => {
    const result = blendExpressionWeights({
      expression: 'happy',
      intensity: 0.5,
      mouthOpenWeight: 1,
      blinkWeight: 1,
    });
    expect(result.mouthOpenWeight).toBeCloseTo((1 + EMOTION_MOUTH_MIN_SCALE) / 2);
    expect(result.blinkWeight).toBeCloseTo((1 + EMOTION_BLINK_MIN_SCALE) / 2);
  });

  it('未知の表情名は neutral 扱いになる（fail-safe）', () => {
    const result = blendExpressionWeights({
      // 実運用では AvatarExpression 型で守られるが、外部/将来入力の破損を想定して防御する。
      expression: 'unknown-future-expression',
      intensity: 1,
      mouthOpenWeight: 0.7,
      blinkWeight: 1,
    });
    expect(result).toEqual({ mouthOpenWeight: 0.7, blinkWeight: 1 });
  });

  it('強度が範囲外(負数・1超)でもクランプして安全に扱う', () => {
    const tooLow = blendExpressionWeights({
      expression: 'happy',
      intensity: -5,
      mouthOpenWeight: 0.7,
      blinkWeight: 1,
    });
    expect(tooLow).toEqual({ mouthOpenWeight: 0.7, blinkWeight: 1 });

    const tooHigh = blendExpressionWeights({
      expression: 'happy',
      intensity: 5,
      mouthOpenWeight: 0.7,
      blinkWeight: 1,
    });
    expect(tooHigh.mouthOpenWeight).toBeCloseTo(0.7 * EMOTION_MOUTH_MIN_SCALE);
    expect(tooHigh.blinkWeight).toBeCloseTo(EMOTION_BLINK_MIN_SCALE);
  });

  it('入力の重みが負数でも出力は 0 未満にならない（防御的クランプ）', () => {
    const result = blendExpressionWeights({
      expression: 'neutral',
      mouthOpenWeight: -1,
      blinkWeight: -1,
    });
    expect(result.mouthOpenWeight).toBe(0);
    expect(result.blinkWeight).toBe(0);
  });

  it('AVATAR_EXPRESSIONS 語彙(neutral/happy/relaxed/thinking/concerned)は全て既知として扱われる', () => {
    // guidance.ts の AVATAR_EXPRESSIONS と意図的に語彙を揃えている（domain 層は components に
    // 依存しないため独立定義。ドリフト検知は frame-weights.test.ts 側の統合テストで行う）。
    expect(KNOWN_EXPRESSION_NAMES).toEqual([
      'neutral',
      'happy',
      'relaxed',
      'thinking',
      'concerned',
    ]);
  });
});
