/**
 * 受付履歴・監査ログのドメイン型 (issue #19)。
 *
 * 個人情報は最小限にする。ReceptionLog には来訪者の氏名・会社名・メモなどの
 * PII を含めない（誰を呼んだか・結果・所要時間など運用に必要な情報のみ）。
 */
import type {
  CallOutcome,
  ReceptionPurposeId,
  ReceptionSession,
  ReceptionTargetType,
} from './session';

export type ReceptionLog = {
  id: string;
  receptionId: string;
  kioskId: string;
  purpose?: ReceptionPurposeId;
  targetType?: ReceptionTargetType;
  targetId?: string;
  /** 呼び出し先の表示名（部署名・担当者名）。氏名そのものではなく呼び出し対象名。 */
  targetLabel?: string;
  outcome: CallOutcome;
  failureReason?: string;
  /** 失敗/未応答後に代替導線が使われたか。 */
  fallbackUsed: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  createdAt: string;
};

export type AuditAction =
  | 'reception.connected'
  | 'reception.timeout'
  | 'reception.failed'
  | 'reception.cancelled'
  | 'reception.completed'
  | 'reception.fallback_used'
  // 管理操作 (issue #22)
  | 'department.created'
  | 'department.updated'
  | 'department.reordered'
  | 'staff.created'
  | 'staff.updated'
  | 'kiosk.created'
  | 'kiosk.revoked'
  | 'kiosk.restored'
  | 'security.updated'
  | 'voice.updated'
  | 'asset.created'
  | 'asset.updated';

export type AuditLog = {
  id: string;
  action: AuditAction;
  /** 操作主体。受付端末イベントは kiosk:<kioskId>、管理操作は admin:<userId> 等。 */
  actor: string;
  targetType?: string;
  targetId?: string;
  at: string;
  /** PII を含めない補助情報のみ。 */
  metadata?: Record<string, string>;
};

/**
 * 終端状態の受付セッションから ReceptionLog を導出する。
 * PII（visitor.*）は意図的に含めない。
 */
export function deriveReceptionLog(
  session: ReceptionSession,
  logId: string,
  fallbackUsed: boolean,
): ReceptionLog {
  const endedAt = session.completedAt ?? session.updatedAt;
  const durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(session.startedAt).getTime());
  return {
    id: logId,
    receptionId: session.id,
    kioskId: session.kioskId,
    purpose: session.purpose,
    targetType: session.targetType,
    targetId: session.targetId,
    targetLabel: session.targetLabel,
    outcome: session.callOutcome ?? 'failed',
    failureReason: session.failureReason,
    fallbackUsed,
    startedAt: session.startedAt,
    endedAt,
    durationMs,
    createdAt: new Date().toISOString(),
  };
}
