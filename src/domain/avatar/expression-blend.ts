/**
 * 感情表情とリップシンク／まばたきの重み合成 (issue #31)。
 *
 * 背景（`docs/aituber-kit-v1-ui-reference.md` 採用提案 [B]）:
 *   感情表情（happy 等）と口形素（リップシンク）は顔の同じ領域の重みを奪い合うため、
 *   両方をそのまま 1.0 で加算すると口元が破綻して見える。また非 neutral 表情の最中に
 *   まばたきが重なると表情の変化点が読み取りにくくなる。
 *   「感情表示中は口の開き重みを減衰させる」「非 neutral 表情中はまばたきを抑制する」は
 *   AITuberKit v1 の expressionController に見られる一般的な破綻回避の考え方（重み配分で
 *   競合を解く）を **参考にしただけ** であり、本モジュールはコードを移植せず自前で
 *   再構成した純関数群である。
 *
 * 副作用なし・three.js / VRM への依存なし。VRM viewer 側（`components/kiosk/avatar/*`）が
 * 毎フレームの生の重み（口の開き量・まばたきの基準重み）を計算し、本関数へ通してから
 * expressionManager に適用する。
 */

/**
 * 減衰の対象と見なす既知の表情名。
 * `components/kiosk/avatar/guidance.ts` の `AVATAR_EXPRESSIONS` と意図的に語彙を揃えている
 * （domain 層は components に依存しない方針のためここで独立に定義・重複させる。ドリフトは
 * `components/kiosk/avatar/frame-weights.test.ts` の統合テストで検知する）。
 * ここに無い文字列（型で守られない外部/将来入力の破損など）は fail-safe で neutral として扱う。
 */
export const KNOWN_EXPRESSION_NAMES = [
  'neutral',
  'happy',
  'relaxed',
  'thinking',
  'concerned',
] as const;
export type KnownExpressionName = (typeof KNOWN_EXPRESSION_NAMES)[number];

/** 表情の中立を表す値。未知の表情名はこれとして扱う（fail-safe）。 */
export const NEUTRAL_EXPRESSION: KnownExpressionName = 'neutral';

/**
 * 感情付き表情・強度 1 のときに口の開き重みへ掛ける下限スケール。
 * 0 まで落とすと発話中に口が完全に消えて「喋っているのに無表情」に見え、かえって不自然に
 * 破綻するため、下限を残してリップシンクと表情を両立させる（AITuberKit の neutral=50%/
 * 感情=25% という固定 2 値ではなく、本実装は強度で連続的に減衰させる自前設計）。
 */
export const EMOTION_MOUTH_MIN_SCALE = 0.4;

/**
 * 感情付き表情・強度 1 のときにまばたき重みへ掛ける下限スケール。
 * まばたきは口と違い「一瞬閉じるだけ」で消失しても破綻して見えないため、表情の変化点を
 * まばたきで隠さないよう 0（完全抑制）まで落として良い。
 */
export const EMOTION_BLINK_MIN_SCALE = 0;

export interface ExpressionBlendInput {
  /** 現在の論理表情名。`KNOWN_EXPRESSION_NAMES` に無い文字列は neutral として扱う。 */
  expression: string;
  /** 表情の強度 0..1（範囲外はクランプ）。省略時は 1（フル適用）。 */
  intensity?: number;
  /** リップシンクが算出した口の開き重み（減衰前の生値）。負数は 0 として扱う。 */
  mouthOpenWeight: number;
  /** まばたきの基準重み（減衰前の生値）。負数は 0 として扱う。 */
  blinkWeight: number;
}

export interface ExpressionBlendResult {
  mouthOpenWeight: number;
  blinkWeight: number;
}

function isKnownExpression(value: string): value is KnownExpressionName {
  return (KNOWN_EXPRESSION_NAMES as readonly string[]).includes(value);
}

/** 0..1 にクランプする（NaN/Infinity は安全側の 1 = フル適用として扱う）。 */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * 感情表情の種類・強度から、口の開き重み／まばたき重みへ掛ける減衰を合成する純関数。
 *  - neutral（または未知の表情 = fail-safe で neutral 扱い）: 強度に関わらず一切変えない。
 *  - 感情付き表情: 強度 0..1 に応じて `EMOTION_*_MIN_SCALE` まで線形に減衰する
 *    （強度 0 = neutral と同じ、強度 1 = 下限までフル減衰）。
 */
export function blendExpressionWeights(input: ExpressionBlendInput): ExpressionBlendResult {
  const expression = isKnownExpression(input.expression) ? input.expression : NEUTRAL_EXPRESSION;
  const isNeutral = expression === NEUTRAL_EXPRESSION;
  const intensity = clampUnit(input.intensity ?? 1);

  const mouthScale = isNeutral ? 1 : lerp(1, EMOTION_MOUTH_MIN_SCALE, intensity);
  const blinkScale = isNeutral ? 1 : lerp(1, EMOTION_BLINK_MIN_SCALE, intensity);

  return {
    mouthOpenWeight: Math.max(0, input.mouthOpenWeight) * mouthScale,
    blinkWeight: Math.max(0, input.blinkWeight) * blinkScale,
  };
}
