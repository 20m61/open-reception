/**
 * 受付履歴・監査ログのストア (issue #19)。
 *
 * #274 ⑥ で §9 標準（docs/persistence-design.md）へ統合: 永続化は ReceptionLogRepository /
 * AuditLogRepository（./reception-log-repository.ts、getBackend() の LogStore へ委譲する
 * 単一実装）に閉じ、本ファイルはプロセス共有ファクトリと互換 API（ログ導出・監査エントリ
 * 組み立て）を担う。既存呼び出し側（route / 各サービスの appendAdminAudit 等）の変更は不要。
 * #254 の listSince 範囲クエリ契約は repository の契約テストが固定する。
 *
 * 保持方針は docs/audit-logging.md を参照。来訪者の PII は記録しない。
 */
import { randomUUID } from 'node:crypto';
import type { ReceptionSession } from '@/domain/reception/session';
import {
  deriveReceptionLog,
  sanitizeReceptionFeedback,
  type AuditAction,
  type AuditLog,
  type ReceptionLog,
} from '@/domain/reception/log';
import {
  DataBackedAuditLogRepository,
  DataBackedReceptionLogRepository,
  type AuditLogRepository,
  type ReceptionLogRepository,
} from './reception-log-repository';

let receptionLogRepository: ReceptionLogRepository | undefined;
let auditLogRepository: AuditLogRepository | undefined;

/** プロセス共有の ReceptionLogRepository（§9.2 のファクトリ）。 */
export function getReceptionLogRepository(): ReceptionLogRepository {
  if (!receptionLogRepository) {
    receptionLogRepository = new DataBackedReceptionLogRepository();
  }
  return receptionLogRepository;
}

/** プロセス共有の AuditLogRepository（§9.2 のファクトリ）。 */
export function getAuditLogRepository(): AuditLogRepository {
  if (!auditLogRepository) {
    auditLogRepository = new DataBackedAuditLogRepository();
  }
  return auditLogRepository;
}

const receptionLogs = () => getReceptionLogRepository();
const auditLogs = () => getAuditLogRepository();

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
  /** 高詳細監査の追加コンテキスト (issue #83 AC13)。before/after・IP・user-agent。 */
  extra?: Pick<AuditLog, 'before' | 'after' | 'ip' | 'userAgent'>,
): Promise<AuditLog> {
  return appendAuditLog({
    action,
    actor: 'admin',
    targetType: target.type,
    targetId: target.id,
    metadata,
    ...extra,
  });
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
    // 高詳細監査 (issue #83 AC13)。未設定は undefined のまま（旧レコード互換）。
    ip: entry.ip,
    userAgent: entry.userAgent,
    before: entry.before,
    after: entry.after,
  };
  await auditLogs().put(log);
  return log;
}

/**
 * 終端状態の受付セッションから受付履歴を記録し、対応する監査ログも残す。
 * 来訪者の PII は記録しない。
 */
export async function recordReceptionOutcome(session: ReceptionSession, fallbackUsed = false): Promise<ReceptionLog> {
  // 受付端末が計測した体験メトリクス (issue #319) を終端ログへ引き継ぐ（PII なし・optional）。
  const log = deriveReceptionLog(session, randomUUID(), fallbackUsed, session.experience);
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
  const log = await receptionLogs().findByReceptionId(receptionId);
  if (log) {
    log.fallbackUsed = true;
    await receptionLogs().put(log);
  }
  await appendAuditLog({ action: 'reception.fallback_used', actor: `kiosk:${kioskId}`, targetId: receptionId, targetType: 'reception' });
}

export type RecordFeedbackResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'forbidden' | 'invalid_input' };

/**
 * ワンタップ満足度フィードバックを既存の受付履歴に追記する (issue #320)。
 *
 * `markFallbackUsed` と同じ read-modify-write（`findByReceptionId` → `put`）で、終端ログ確定後
 * （完了/未応答/失敗）に事後追記する。`input` はホワイトリスト方式でサニタイズし（自由記述は
 * 構造的に存在しない）、無効なら記録せず `invalid_input` を返す。所有権チェック（`kioskId` が
 * ログの `kioskId` と一致するか）は他の kiosk API と同じ方針（#348）で、対象 reception を
 * 作成した端末以外からの書き込みを拒否する。監査ログには評価値・理由コード（列挙のみ・PII なし）
 * だけを残す。
 */
export async function recordSatisfactionFeedback(
  receptionId: string,
  kioskId: string,
  input: unknown,
): Promise<RecordFeedbackResult> {
  const feedback = sanitizeReceptionFeedback(input);
  if (!feedback) return { ok: false, error: 'invalid_input' };

  const log = await receptionLogs().findByReceptionId(receptionId);
  if (!log) return { ok: false, error: 'not_found' };
  if (log.kioskId !== kioskId) return { ok: false, error: 'forbidden' };

  log.satisfactionRating = feedback.rating;
  if (feedback.reasonCodes) log.feedbackReasonCodes = feedback.reasonCodes;
  await receptionLogs().put(log);

  const metadata: Record<string, string> = { rating: feedback.rating };
  if (feedback.reasonCodes && feedback.reasonCodes.length > 0) {
    metadata.reasonCodes = feedback.reasonCodes.join(',');
  }
  await appendAuditLog({
    action: 'reception.feedback_submitted',
    actor: `kiosk:${kioskId}`,
    targetId: receptionId,
    targetType: 'reception',
    metadata,
  });
  return { ok: true };
}

/** 受付履歴を新しい順で返す。 */
export async function listReceptionLogs(): Promise<ReceptionLog[]> {
  return receptionLogs().list();
}

/**
 * `createdAt >= sinceIso`（含む）の受付履歴のみを新しい順で返す (issue #254)。全件走査を避け、
 * ダッシュボードの「本日/当月」集計を境界付きで取得する。呼び出し側は集計側の期間で再フィルタする。
 */
export async function listReceptionLogsSince(sinceIso: string): Promise<ReceptionLog[]> {
  return receptionLogs().listSince(sinceIso);
}

/** 監査ログを新しい順で返す。 */
export async function listAuditLogs(): Promise<AuditLog[]> {
  return auditLogs().list();
}

/** テスト用: ストアを初期化する。 */
export async function __resetLogStore(): Promise<void> {
  await Promise.all([receptionLogs().reset(), auditLogs().reset()]);
}
