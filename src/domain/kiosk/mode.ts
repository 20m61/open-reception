/**
 * KioskMode: サイネージ→ATTRACT→受付開始の段階遷移における「画面が今どの層にあるか」
 * を表す中間レイヤー (issue #362)。
 *
 * 3 層の状態責務（issue #362 の設計）:
 *   - PresenceState（`src/domain/presence/state.ts`）… カメラ・滞在・再発火抑制。
 *     ATTRACT に達しても「受付開始」はしない（画面反応のみ）。
 *   - KioskMode（本モジュール）… サイネージ / 受付 / QR受付 / 完了 / 営業時間外 / 縮退。
 *     明示操作（タップ CTA）を経たときだけ signage → reception / qr_reception へ進む。
 *   - ReceptionState（`src/domain/reception/state.ts`）… 受付業務の具体的ステップ
 *     （purpose/target/visitor-info/confirm/calling/...）。**真実源はこちらのみ**。
 *     本モジュールは ReceptionState を複製せず、既存の値をそのまま入力として受け取り
 *     KioskMode へ写像するだけの純関数を提供する。
 *
 * 新しい巨大な状態機械は作らない。KioskFlow が既に持つ判定材料
 * （アクセスゲート `KioskGate` / QR受付トグル `mode` / 受付状態機械 `data.state`）から
 * 表示レイヤーを一意に決めるための写像でしかない。
 */
import type { ReceptionState } from '@/domain/reception/state';
import type { OperatingState } from './operating-status';

export const KIOSK_MODES = [
  'signage',
  'reception',
  'qr_reception',
  'completion',
  // 営業時間外の専用表示 (#367 の営業時間ポリシー連携)。営業状態は外部から注入する
  // （`operatingStatus`）。判定不能（未注入）は fail-open で通常受付に倒す。
  'out_of_hours',
  'degraded',
] as const;

export type KioskMode = (typeof KIOSK_MODES)[number];

/** `resolveKioskGate` (`src/components/kiosk/integration.ts`) の戻り値と同じ語彙。 */
export type KioskScreenGate = 'revoked' | 'authorize' | 'unenrolled' | 'checking' | 'ready';

/** 受付業務が進行中とみなすステップ（サイネージでも完了/結果表示でもない）。 */
const IN_PROGRESS_RECEPTION_STATES: ReadonlySet<ReceptionState> = new Set([
  'selectingPurpose',
  'selectingTarget',
  'inputVisitorInfo',
  'confirming',
  'calling',
  'connected',
]);

/** 終端/結果表示のステップ（完了・キャンセル・失敗・タイムアウト・代替導線）。 */
const COMPLETION_RECEPTION_STATES: ReadonlySet<ReceptionState> = new Set([
  'completed',
  'cancelled',
  'failed',
  'timeout',
  'fallback',
]);

/**
 * 現在の表示レイヤー（KioskMode）を判定する純関数。
 *
 * 優先順位:
 *   1. gate が ready でない（失効/未エンロール/PIN待ち/確認中）→ 'degraded'。
 *      技術的な利用不可は受付進行状況に関わらず最優先する。
 *   2. QR 受付モード（`mode==='checkin'`）→ 'qr_reception'。
 *   3. 営業時間外（`operatingStatus==='closed'`）かつ待機（idle）→ 'out_of_hours'（#367）。
 *      受付進行中は中断しない（閉店で来訪者を放り出さない）。未指定/open は fail-open で素通り。
 *   4. receptionState が 'idle' → 'signage'（待機サイネージ/待機画面）。
 *   5. 終端/結果表示ステップ → 'completion'。
 *   6. それ以外（選択/入力/確認/呼び出し中）→ 'reception'。
 */
export function resolveKioskMode(input: {
  gate: KioskScreenGate;
  uiMode: 'normal' | 'checkin';
  receptionState: ReceptionState;
  /** 営業状態（#367）。未指定は「判定不能」として fail-open（通常受付）に倒す。 */
  operatingStatus?: OperatingState;
}): KioskMode {
  if (input.gate !== 'ready') return 'degraded';
  if (input.uiMode === 'checkin') return 'qr_reception';
  if (input.operatingStatus === 'closed' && input.receptionState === 'idle') return 'out_of_hours';
  if (input.receptionState === 'idle') return 'signage';
  if (COMPLETION_RECEPTION_STATES.has(input.receptionState)) return 'completion';
  if (IN_PROGRESS_RECEPTION_STATES.has(input.receptionState)) return 'reception';
  return 'reception';
}
