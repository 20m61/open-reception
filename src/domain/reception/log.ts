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
  | 'reception.answered'
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
  | 'asset.updated'
  | 'motion.updated'
  // 来訪予約・QR 操作 (issue #97)。PII は metadata に残さない。
  | 'reservation.created'
  | 'reservation.updated'
  | 'reservation.cancelled'
  | 'reservation.revoked'
  | 'reservation.token_issued'
  | 'reservation.token_reissued'
  // 拠点（Site）管理 (issue #87)。テナント/サイト境界の操作のみ記録。
  | 'site.created'
  | 'site.updated'
  // 呼び出し先・通知ルート設定 (issue #88)。
  | 'call_route.created'
  | 'call_route.updated'
  | 'call_route.deleted'
  // 認証方式・外部連携・シークレット状態管理 (issue #93)。secret 値そのものは記録しない（状態のみ）。
  | 'auth_config.updated'
  | 'integration.updated'
  | 'integration.tested'
  | 'secret.updated'
  | 'secret.cleared'
  // 担当者応答アクション (issue #99)。応答種別は metadata.action に持つ（PII は残さない）。
  | 'reception.staff_responded'
  // 受付端末（Device）管理 (issue #87 inc2)。token 値そのものは記録しない。
  | 'device.token_reissued'
  | 'device.disabled'
  | 'device.enabled'
  // 来訪目的別カスタム受付フロー (issue #100)。
  | 'reception_flow.created'
  | 'reception_flow.updated'
  | 'reception_flow.deleted'
  // 待機中サイネージ設定 (issue #101)。
  | 'signage.updated'
  // 退館チェックアウト・滞在状態管理 (issue #102)。PII は残さない。
  | 'visitor.checked_out'
  | 'stay.updated'
  // AI 案内 → 担当者/有人切替 (issue #104)。会話内容・PII は残さない。
  // 引き継ぎ要求が出たことと、その理由種別（metadata.reason）のみを記録する。
  | 'ai_guidance.escalated'
  // 担当者/有人へ確実に引き継がれた。
  | 'ai_guidance.handoff'
  // 引き継ぎ失敗→既存受付フロー/代替導線へフォールバックした。
  | 'ai_guidance.fallback'
  // AI 案内の運用設定（有効/無効・許可トピック）を更新した (issue #104)。
  | 'ai_guidance.config_updated';

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
