/**
 * VRM モーション割り当てのドメイン型 (issue #31)。
 * 受付状態ごとにモーション（#27 のアセット）を割り当て、未設定/失敗時は default に fallback する。
 * 実際の VRM 再生（three.js レンダラ）は #5 で本書のマッピングを消費する。
 */
import type { ReceptionState } from '@/domain/reception/state';

export const MOTION_KEYS = [
  'idle',
  'greeting',
  'listening',
  'thinking',
  'selecting',
  'calling',
  'connected',
  'success',
  'failed',
  'timeout',
  'fallback',
] as const;

export type MotionKey = (typeof MOTION_KEYS)[number];

/** モーションキー → モーションアセット id。未設定キーは default を使う。 */
export type MotionMapping = Partial<Record<MotionKey, string>>;

export function isMotionKey(value: unknown): value is MotionKey {
  return typeof value === 'string' && (MOTION_KEYS as readonly string[]).includes(value);
}

/** 受付状態から再生すべきモーションキーを決める（純関数）。 */
export function motionKeyForState(state: ReceptionState): MotionKey {
  switch (state) {
    case 'idle':
    case 'cancelled':
      return 'idle';
    case 'selectingPurpose':
      return 'greeting';
    case 'selectingTarget':
      return 'selecting';
    case 'inputVisitorInfo':
      return 'listening';
    case 'confirming':
      return 'thinking';
    case 'calling':
      return 'calling';
    case 'connected':
      return 'connected';
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    case 'timeout':
      return 'timeout';
    case 'fallback':
      return 'fallback';
    default:
      return 'idle';
  }
}

/** キーに割り当てられたアセット id を返す。未設定なら default（あれば）。 */
export function resolveMotionAssetId(
  key: MotionKey,
  mapping: MotionMapping,
  defaultAssetId?: string,
): string | undefined {
  return mapping[key] ?? defaultAssetId;
}

/**
 * 受付端末向け: キー → 解決済みモーション URL を返す（純関数）。
 * 状態キーに URL が割り当てられていなければ default URL に fallback する。
 * 受付状態とモーション再生を接続するために VRM レンダラ（#5/#31）が消費する。
 */
export function resolveMotionUrl(
  key: MotionKey,
  motions: Partial<Record<MotionKey, string>>,
  defaultUrl?: string,
): string | undefined {
  return motions[key] ?? defaultUrl;
}
