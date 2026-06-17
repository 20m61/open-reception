/**
 * 受付セッションのドメイン型 (issue #16)。
 * 来訪者の個人情報は最小限に保つ（issue #14, #19）。
 */
import type { ReceptionState } from './state';

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
