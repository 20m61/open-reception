/**
 * 視線誘導先 → 頭部オフセットの純ロジック (#422 inc5-c 増分 3)。
 *
 * 契約の `gazeTargetFor(screenState)` は #489 で実挙動へ突き合わせて真にしたが、
 * **消費者がゼロのままだった**。このセッションが繰り返し確認したとおり、消費者ゼロの契約は
 * 静かに腐る。ここが最初の消費者になる。
 *
 * **レイアウトを引数に取るのが要点。** 同じ「回答を見る」でも、横向き（35%/65% レール。
 * アバターは左、操作は右）では首を右へ振り、縦向き（アバターの真下に操作）では首を振らず
 * 見下ろす。視線先だけでは向く方向が決まらない。
 *
 * 実際の VRM への適用は `VrmAvatarViewer`。ここは副作用を持たない（three 非依存）。
 */
import type { GazeTarget } from '@/domain/reception/ui-contract';
import type { KioskLayout } from '../layout';

/** 頭部の向き（ラジアン）。yaw = 左右（正で右）、pitch = 上下（正で下）。 */
export type GazeOffset = { yaw: number; pitch: number };

const NEUTRAL: GazeOffset = { yaw: 0, pitch: 0 };

/**
 * 横向き（`ipad-landscape` / `large-display`）の視線先。
 * 操作は右 65% レールに在るので首を右へ振る。画面の下方にある要素ほど深く見下ろす。
 */
const LANDSCAPE_OFFSET: Record<Exclude<GazeTarget, 'none'>, GazeOffset> = {
  answers: { yaw: 0.22, pitch: 0.05 },
  form: { yaw: 0.2, pitch: 0.13 },
  confirmCta: { yaw: 0.2, pitch: 0.15 },
  fallbackCta: { yaw: 0.2, pitch: 0.12 },
};

/**
 * 縦向き（`ipad-portrait`）の視線先。
 * 操作はアバターの真下に積まれるので**首は振らず**、見下ろす角度だけで表す。
 */
const PORTRAIT_OFFSET: Record<Exclude<GazeTarget, 'none'>, GazeOffset> = {
  answers: { yaw: 0, pitch: 0.12 },
  form: { yaw: 0, pitch: 0.2 },
  confirmCta: { yaw: 0, pitch: 0.22 },
  fallbackCta: { yaw: 0, pitch: 0.18 },
};

/**
 * 視線先とレイアウトから頭部オフセットを解決する。
 *
 * `'none'`（誘導なし＝操作を急かさない局面）は中立。値は首の可動域に収まる範囲に留める
 * （横 ±0.5rad ≒ 29°、縦 ±0.35rad ≒ 20°。`vrm-gaze.test.ts` が上限を固定）。
 */
export function gazeOffsetFor(target: GazeTarget, layout: KioskLayout): GazeOffset {
  if (target === 'none') return NEUTRAL;
  const table = layout === 'ipad-portrait' ? PORTRAIT_OFFSET : LANDSCAPE_OFFSET;
  return table[target];
}
