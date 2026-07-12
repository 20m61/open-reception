/**
 * 受付セッションのドメイン型 (issue #16)。
 * 来訪者の個人情報は最小限に保つ（issue #14, #19）。
 */
import type { ReceptionState } from './state';
import type { StaffResponseResult } from './staff-response';
import type { ReceptionExperience } from './log';

export type ReceptionTargetType = 'staff' | 'department';

export type ReceptionPurposeId = 'meeting' | 'delivery' | 'interview' | 'other';

export type VisitorInfo = {
  name: string;
  company?: string;
  note?: string;
};

export type CallOutcome = 'connected' | 'timeout' | 'failed' | 'cancelled';

export type ReceptionSession = {
  id: string;
  kioskId: string;
  state: ReceptionState;
  purpose?: ReceptionPurposeId;
  targetType?: ReceptionTargetType;
  targetId?: string;
  targetLabel?: string;
  visitor?: VisitorInfo;
  callOutcome?: CallOutcome;
  failureReason?: string;
  /** Vonage 通話セッション ID（本番 adapter 利用時に紐づく。issue #4 increment 2）。 */
  vonageSessionId?: string;
  /**
   * 担当者の最新応答（来訪者向け）。受付端末が短時間ポーリングで反映する (issue #99)。
   * PII を含めない（応答種別・来訪者向けメッセージ・時刻のみ）。
   */
  staffResponse?: StaffResponseResult;
  /**
   * 受付体験 KPI メトリクス (issue #319)。**optional**（旧セッション・既存テスト互換）。
   * 受付端末が呼び出し確定時に送るサニタイズ済みメトリクス（所要/回数/列挙のみ・PII なし）を
   * 作成時に保持し、終端で ReceptionLog へ引き継ぐ。
   */
  experience?: ReceptionExperience;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export const RECEPTION_PURPOSES: ReadonlyArray<{ id: ReceptionPurposeId; label: string }> = [
  { id: 'meeting', label: '面会' },
  { id: 'delivery', label: '納品' },
  { id: 'interview', label: '打ち合わせ' },
  { id: 'other', label: 'その他' },
];

export function isReceptionPurposeId(value: unknown): value is ReceptionPurposeId {
  return RECEPTION_PURPOSES.some((p) => p.id === value);
}
