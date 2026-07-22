/**
 * VRM viewer が毎フレーム expressionManager へ渡す口形素(aa)／まばたき(blink)の重みを
 * 1 箇所にまとめて算出する純関数 (issue #31 — 感情連動リップシンク + まばたき抑制)。
 *
 * `VrmAvatarViewer` の描画ループは three.js を動的 import するため jsdom で直接検証できない。
 * 「発話中か・経過時間・現在の表情/強度から、実際に `expressionManager.setValue()` へ渡す
 * 値を導く」計算だけをここへ切り出すことで、viewer が合成関数（`domain/avatar/expression-blend`）
 * を通していることをユニットテストで固定する。viewer はこの関数の戻り値をそのまま
 * `setValue('aa', mouthAa)` / `setValue('blink', blink)` に渡すだけにする。
 */
import { mouthOpenValue } from './lip-sync';
import type { AvatarExpression } from './guidance';
import { blendExpressionWeights } from '@/domain/avatar/expression-blend';

export interface FrameExpressionWeightsInput {
  /** 現在の論理表情（#31）。 */
  expression: AvatarExpression;
  /**
   * 表情強度 0..1。省略時は 1（フル適用）。現状 avatarGuidanceFor は強度を持たないため
   * 常に 1 相当で扱われるが、将来の強度可変入力（プロパティ/ストア）を受けられるようここに
   * 注入 seam を用意しておく。
   */
  expressionIntensity?: number;
  /** TTS 発話中か（#5 簡易リップシンク）。 */
  speaking: boolean;
  /** three.js Clock の経過秒（口の開き量の時間ベース合成に使う）。 */
  elapsedSec: number;
  /**
   * まばたきの基準重み（減衰前）。このプロジェクトに auto-blink（周期的なまばたき駆動、
   * `docs/aituber-kit-v1-ui-reference.md` 提案 E）はまだ無いため既定 0（未接続）。
   * 将来 auto-blink を実装したら、その周期的な重みをここへ渡すだけで感情中の抑制が
   * 自動的に効くようになる（本トラックで用意する注入 seam）。
   */
  blinkBaseWeight?: number;
}

export interface FrameExpressionWeights {
  mouthAa: number;
  blink: number;
}

export function resolveFrameExpressionWeights(
  input: FrameExpressionWeightsInput,
): FrameExpressionWeights {
  const rawMouth = mouthOpenValue(input.elapsedSec, input.speaking);
  const blended = blendExpressionWeights({
    expression: input.expression,
    intensity: input.expressionIntensity,
    mouthOpenWeight: rawMouth,
    blinkWeight: input.blinkBaseWeight ?? 0,
  });
  return { mouthAa: blended.mouthOpenWeight, blink: blended.blinkWeight };
}
