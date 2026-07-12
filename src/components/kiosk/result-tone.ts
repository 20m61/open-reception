/**
 * 結果/待ち画面の共通レイアウト (#326 L1) が使うトーン判定。
 *
 * これまで呼び出し中・結果（接続/タイムアウト/失敗/代替導線）・完了/キャンセルの各画面は
 * 「通知ピルが画面中央に浮くだけ」で死空間が大きく、成功/失敗のトーンも一見して伝わらな
 * かった。本モジュールは「状態→アイコン/パネルの色」を一意に導出する純ロジックで、
 * KioskFlow はこの結果に従って `.result-panel--<tone>` を出し分けるだけにする
 * （副作用なし・node 環境でユニットテストできる）。
 */
import type { ReceptionState } from '@/domain/reception/state';

export type ResultTone = 'success' | 'danger' | 'warning' | 'info';

/** 対象は常設アバターコンパニオン（#123）と同じステータス画面。 */
const RESULT_TONE_BY_STATE: Partial<Record<ReceptionState, ResultTone>> = {
  calling: 'info',
  connected: 'success',
  timeout: 'danger',
  failed: 'danger',
  fallback: 'warning',
  completed: 'success',
  cancelled: 'info',
};

/**
 * 状態からトーンを導出する。対象外の状態（選択/入力/確認/待機等）は中立の 'info' へ
 * フォールバックする（呼び出し側は該当ステータス画面でのみ使う想定）。
 */
export function resultToneForState(state: ReceptionState): ResultTone {
  return RESULT_TONE_BY_STATE[state] ?? 'info';
}
