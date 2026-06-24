/**
 * アバターの論理表情 → VRM 1.0 expression preset の対応 (issue #31)。
 *
 * guidance.ts が状態ごとに返す論理表情（neutral/happy/relaxed/thinking/concerned）を、
 * VRM 標準の expression preset 名へ写像する純関数。VRM レンダラ（VrmAvatarViewer）が
 * これを消費して `expressionManager.setValue()` を呼ぶ。実描画の確認は実機 UAT（#65）。
 *
 * 設計:
 *  - VRM 1.0 の「感情系」preset（happy/angry/sad/relaxed/surprised/neutral）のみを扱う。
 *    口形素（aa/ih/ou/ee/oh）・瞬き（blink）・視線（lookUp 等）は別系統で、リップシンク
 *    （#5）と競合しないよう本マッピングには含めない。
 *  - VRM 標準に対応物が無い論理表情（thinking/concerned）は意味的に近い preset へ寄せる。
 */
import type { AvatarExpression } from './guidance';

/** VRM 1.0 の感情系 expression preset 名。 */
export const VRM_EMOTION_PRESETS = [
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'neutral',
] as const;
export type VrmEmotionPreset = (typeof VRM_EMOTION_PRESETS)[number];

/**
 * 論理表情を VRM 感情 preset に写像する（純関数）。
 *  - happy → happy / relaxed → relaxed / neutral → neutral
 *  - concerned → sad（VRM に concerned は無い）
 *  - thinking → neutral（VRM に thinking は無い。視線下げ等は #65 で別途検討）
 */
export function vrmEmotionPreset(expression: AvatarExpression): VrmEmotionPreset {
  switch (expression) {
    case 'happy':
      return 'happy';
    case 'relaxed':
      return 'relaxed';
    case 'concerned':
      return 'sad';
    case 'thinking':
      return 'neutral';
    case 'neutral':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/**
 * 表情切替の expressionManager 適用値を返す（純関数・副作用なし）。
 * 対象 preset を 1.0、他の感情 preset を 0 にしたエントリ配列を返す。
 * VrmAvatarViewer がこれを `expressionManager.setValue(name, value)` に流し込む。
 */
export function emotionExpressionValues(
  expression: AvatarExpression,
): ReadonlyArray<{ name: VrmEmotionPreset; value: number }> {
  const target = vrmEmotionPreset(expression);
  return VRM_EMOTION_PRESETS.map((name) => ({ name, value: name === target ? 1 : 0 }));
}
