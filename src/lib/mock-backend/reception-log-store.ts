/**
 * 受付履歴・監査ログの in-memory ストア (issue #19)。
 * 本番では永続化層（DB）へ置換する。保持方針は docs/audit-logging.md を参照。
 *
 * NOTE: プロセス内配列のため単一インスタンス前提。
 */
import { randomUUID } from 'node:crypto';
import type { ReceptionSession } from '@/domain/reception/session';
import {
  deriveReceptionLog,
  type AuditAction,
  type AuditLog,
  type ReceptionLog,
} from '@/domain/reception/log';

/** メモリ保護のための保持上限（古いものから破棄）。本番は保持期間で管理する。 */
const MAX_RECEPTION_LOGS = 1000;
const MAX_AUDIT_LOGS = 5000;

const receptionLogs: ReceptionLog[] = [];
const auditLogs: AuditLog[] = [];

const OUTCOME_TO_AUDIT: Record<ReceptionLog['outcome'], AuditAction> = {
  connected: 'reception.connected',
  timeout: 'reception.timeout',
  failed: 'reception.failed',
  cancelled: 'reception.cancelled',
};

function pushCapped<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
}

/** 管理操作を監査ログに記録する (issue #22)。actor は admin 固定。 */
export function appendAdminAudit(
  action: AuditAction,
  target: { type: string; id?: string },
  metadata?: Record<string, string>,
): AuditLog {
  return appendAuditLog({ action, actor: 'admin', targetType: target.type, targetId: target.id, metadata });
}

export function appendAuditLog(entry: Omit<AuditLog, 'id' | 'at'> & { at?: string }): AuditLog {
  const log: AuditLog = {
    id: randomUUID(),
    at: entry.at ?? new Date().toISOString(),
    action: entry.action,
    actor: entry.actor,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata,
  };
  pushCapped(auditLogs, log, MAX_AUDIT_LOGS);
  return log;
}

/**
 * 終端状態の受付セッションから受付履歴を記録し、対応する監査ログも残す。
 * 来訪者の PII は記録しない。
 */
export function recordReceptionOutcome(session: ReceptionSession, fallbackUsed = false): ReceptionLog {
  const log = deriveReceptionLog(session, randomUUID(), fallbackUsed);
  pushCapped(receptionLogs, log, MAX_RECEPTION_LOGS);
  appendAuditLog({
    action: OUTCOME_TO_AUDIT[log.outcome],
    actor: `kiosk:${log.kioskId}`,
    targetType: log.targetType,
    targetId: log.targetId,
    metadata: log.failureReason ? { failureReason: log.failureReason } : undefined,
  });
  return log;
}

/** 既存の受付履歴に「完了」イベントを追記する（connected → completed）。 */
export function recordReceptionCompleted(receptionId: string, kioskId: string): void {
  appendAuditLog({ action: 'reception.completed', actor: `kiosk:${kioskId}`, targetId: receptionId, targetType: 'reception' });
}

/** 代替導線の利用を記録し、対象履歴の fallbackUsed を立てる。 */
export function markFallbackUsed(receptionId: string, kioskId: string): void {
  const log = receptionLogs.find((l) => l.receptionId === receptionId);
  if (log) {
    log.fallbackUsed = true;
  }
  appendAuditLog({ action: 'reception.fallback_used', actor: `kiosk:${kioskId}`, targetId: receptionId, targetType: 'reception' });
}

/** 受付履歴を新しい順で返す。 */
export function listReceptionLogs(): ReceptionLog[] {
  return [...receptionLogs].reverse();
}

/** 監査ログを新しい順で返す。 */
export function listAuditLogs(): AuditLog[] {
  return [...auditLogs].reverse();
}

/** テスト用: ストアを初期化する。 */
export function __resetLogStore(): void {
  receptionLogs.length = 0;
  auditLogs.length = 0;
}
