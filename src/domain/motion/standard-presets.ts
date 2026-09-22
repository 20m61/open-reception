import type { MotionKey } from './types';

export type StandardGazeTarget = 'user' | 'ui' | 'neutral';
export type StandardExpression = 'neutral' | 'smile' | 'concerned';

export type StandardMotionPreset = {
  /** Human-facing purpose of this behavior preset. */
  label: string;
  /** Whether the base motion is expected to loop while the reception state is active. */
  loop: boolean;
  /** Recommended cross-fade duration when entering this preset. */
  fadeInSec: number;
  /** Recommended cross-fade duration when leaving this preset. */
  fadeOutSec: number;
  /** Runtime gaze authority. The actual screen-space target is resolved by the kiosk UI. */
  gaze: StandardGazeTarget;
  /** Runtime expression layered after VRMA playback. */
  expression: StandardExpression;
  /** Short guidance for authors creating/reviewing the corresponding VRMA. */
  authoringNotes: string;
};

/**
 * Open Reception Standard Motion Set.
 *
 * These presets intentionally describe behavior, not asset URLs. A tenant may assign any
 * compatible VRMA to a MotionKey, while the product retains one stable behavioral contract.
 */
export const STANDARD_MOTION_PRESETS: Readonly<Record<MotionKey, StandardMotionPreset>> = {
  idle: {
    label: '待機',
    loop: true,
    fadeInSec: 0.3,
    fadeOutSec: 0.2,
    gaze: 'user',
    expression: 'neutral',
    authoringNotes: '静かな呼吸と小さな重心移動。腕は下ろし、長時間ループしても目立つ反復を作らない。',
  },
  greeting: {
    label: '挨拶',
    loop: false,
    fadeInSec: 0.2,
    fadeOutSec: 0.25,
    gaze: 'user',
    expression: 'smile',
    authoringNotes: '短い会釈または控えめな手振り。ユーザーへの正対を維持し、過剰な身振りを避ける。',
  },
  listening: {
    label: '傾聴',
    loop: true,
    fadeInSec: 0.25,
    fadeOutSec: 0.2,
    gaze: 'user',
    expression: 'neutral',
    authoringNotes: 'わずかな前傾と小さな相槌。発話を急かすような大きな頷きや周期運動は避ける。',
  },
  thinking: {
    label: '確認・思考',
    loop: true,
    fadeInSec: 0.2,
    fadeOutSec: 0.2,
    gaze: 'ui',
    expression: 'neutral',
    authoringNotes: '確認対象へ視線を譲る静かな姿勢。首を傾けすぎず、UIの可読性を邪魔しない。',
  },
  selecting: {
    label: '選択案内',
    loop: true,
    fadeInSec: 0.2,
    fadeOutSec: 0.2,
    gaze: 'ui',
    expression: 'neutral',
    authoringNotes: '選択肢を軽く提示する所作。指差しよりも開いた手のひらを優先し、対象UIへの視線誘導と競合しない。',
  },
  calling: {
    label: '呼び出し中',
    loop: true,
    fadeInSec: 0.3,
    fadeOutSec: 0.25,
    gaze: 'user',
    expression: 'neutral',
    authoringNotes: '安心感のある静かな待機姿勢。接続待ち時間が長くても焦燥感を与える反復を避ける。',
  },
  connected: {
    label: '接続',
    loop: true,
    fadeInSec: 0.25,
    fadeOutSec: 0.25,
    gaze: 'user',
    expression: 'neutral',
    authoringNotes: '遠隔担当者との会話を邪魔しない最小限の生命感。大きなジェスチャーは行わない。',
  },
  success: {
    label: '成功・完了',
    loop: false,
    fadeInSec: 0.15,
    fadeOutSec: 0.3,
    gaze: 'user',
    expression: 'smile',
    authoringNotes: '小さな頷きや会釈で完了を伝える。祝福的・派手な演出ではなく受付として落ち着いた所作にする。',
  },
  failed: {
    label: '失敗・お詫び',
    loop: false,
    fadeInSec: 0.15,
    fadeOutSec: 0.3,
    gaze: 'user',
    expression: 'concerned',
    authoringNotes: '短いお辞儀などで問題を伝える。落胆や大げさな謝罪表現を避け、直後の代替導線へつなげる。',
  },
  timeout: {
    label: '未応答',
    loop: false,
    fadeInSec: 0.15,
    fadeOutSec: 0.25,
    gaze: 'user',
    expression: 'concerned',
    authoringNotes: '軽いお詫びと再操作の余地を示す。責める印象や急かす動きを避ける。',
  },
  fallback: {
    label: '代替導線',
    loop: true,
    fadeInSec: 0.2,
    fadeOutSec: 0.2,
    gaze: 'ui',
    expression: 'neutral',
    authoringNotes: '別の操作方法や代表窓口へ注意を移す。身体は控えめにし、視線とUIを主役にする。',
  },
};

export function standardMotionPresetFor(key: MotionKey): StandardMotionPreset {
  return STANDARD_MOTION_PRESETS[key];
}
