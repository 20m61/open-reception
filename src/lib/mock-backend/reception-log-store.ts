/**
 * 受付履歴・監査ログのストア (issue #19)。
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 * 保持方針は docs/audit-logging.md を参照。来訪者の PII は記録しない。
 */
import { randomUUID } from 'node:crypto';
import type { ReceptionSession } from '@/domain/reception/session';
import {
  deriveReceptionLog,
  type AuditAction,
  type AuditLog,
  type ReceptionLog,
} from '@/domain/reception/log';
import { getBackend } from '@/lib/data';

const receptionLogs = () =>
  getBackend().log<ReceptionLog>('rcplog', { timestampField: 'createdAt', indexedField: 'receptionId' });
const auditLogs = () => getBackend().log<AuditLog>('audit', { timestampField: 'at' });

const OUTCOME_TO_AUDIT: Record<ReceptionLog['outcome'], AuditAction> = {
  connected: 'reception.connected',
  timeout: 'reception.timeout',
  failed: 'reception.failed',
  cancelled: 'reception.cancelled',
};

/** 管理操作を監査ログに記録する (issue #22)。actor は admin 固定。 */
export async function appendAdminAudit(
  action: AuditAction,
  target: { type: string; id?: string },
  metadata?: Record<string, string>,
): Promise<AuditLog> {
  return appendAuditLog({ action, actor: 'admin', targetType: target.type, targetId: target.id, metadata });
}

export async function appendAuditLog(entry: Omit<AuditLog, 'id' | 'at'> & { at?: string }): Promise<AuditLog> {
  const log: AuditLog = {
    id: randomUUID(),
    at: entry.at ?? new Date().toISOString(),
    action: entry.action,
    actor: entry.actor,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata,
  };
  await auditLogs().put(log);
  return log;
}

/**
 * 終端状態の受付セッションから受付履歴を記録し、対応する監査ログも残す。
 * 来訪者の PII は記録しない。
 */
export async function recordReceptionOutcome(session: ReceptionSession, fallbackUsed = false): Promise<ReceptionLog> {
  const log = deriveReceptionLog(session, randomUUID(), fallbackUsed);
  await receptionLogs().put(log);
  // 来訪目的（カテゴリ。PII ではない）と失敗理由のみを監査メタデータに残す (issue #100)。
  const metadata: Record<string, string> = {};
  if (log.purpose) metadata.purpose = log.purpose;
  if (log.failureReason) metadata.failureReason = log.failureReason;
  await appendAuditLog({
    action: OUTCOME_TO_AUDIT[log.outcome],
    actor: `kiosk:${log.kioskId}`,
    targetType: log.targetType,
    targetId: log.targetId,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
  return log;
}

/** 既存の受付履歴に「完了」イベントを追記する（connected → completed）。 */
export async function recordReceptionCompleted(receptionId: string, kioskId: string): Promise<void> {
  await appendAuditLog({ action: 'reception.completed', actor: `kiosk:${kioskId}`, targetId: receptionId, targetType: 'reception' });
}

/** 代替導線の利用を記録し、対象履歴の fallbackUsed を立てる。 */
export async function markFallbackUsed(receptionId: string, kioskId: string): Promise<void> {
  const log = await receptionLogs().findBy('receptionId', receptionId);
  if (log) {
    log.fallbackUsed = true;
    await receptionLogs().put(log);
  }
  await appendAuditLog({ action: 'reception.fallback_used', actor: `kiosk:${kioskId}`, targetId: receptionId, targetType: 'reception' });
}

/** 受付履歴を新しい順で返す。 */
export async function listReceptionLogs(): Promise<ReceptionLog[]> {
  return receptionLogs().list();
}

/** 監査ログを新しい順で返す。 */
export async function listAuditLogs(): Promise<AuditLog[]> {
  return auditLogs().list();
}

/** テスト用: ストアを初期化する。 */
export async function __resetLogStore(): Promise<void> {
  await Promise.all([receptionLogs().reset(), auditLogs().reset()]);
}
