/**
 * platform の read 系監査の記録判定 (issue #83 §5 / inc5b)。
 *
 * #83 §5 は「監査ログ閲覧」自体を監査対象にするが、閲覧のたびに記録すると
 * 「閲覧 → 記録 → 一覧に増える → また閲覧」で監査ログが自己増殖し、実操作の記録を
 * 一覧上限から押し流してしまう。そこで **同一 actor の窓内連続閲覧は 1 回だけ記録する**。
 *
 * 判定はストア（既に取得済みの監査ログ一覧）に基づく純関数で行い、プロセス内状態を
 * 持たない（サーバーレスの複数インスタンスでも記録済みの閲覧監査そのものが抑制の根拠になる）。
 */
import type { AuditLog } from '@/domain/reception/log';

/** 監査ログ閲覧の記録を actor ごとに 1 回へ絞る窓（15 分）。 */
export const AUDIT_VIEW_WINDOW_MS = 15 * 60 * 1000;

/** 判定に必要な最小のログ形（route が取得済みの AuditLog をそのまま渡せる）。 */
export type AuditViewLogLike = Pick<AuditLog, 'action' | 'actor' | 'at'>;

/**
 * 監査ログ閲覧（platform.audit_log.viewed）を今回記録すべきかを判定する純関数。
 *
 * - 同一 actor の閲覧記録が窓内（`now - at < windowMs`）にあれば false（記録しない）。
 * - 未来時刻（クロックスキュー）の閲覧記録も「直近閲覧あり」とみなして抑制する
 *   （スキュー中に毎リクエスト記録して monotonic に増え続けるのを防ぐ）。
 * - `at` が解釈できない記録は無視する（欠損データで監査が止まらない）。
 */
export function shouldRecordAuditView(
  logs: readonly AuditViewLogLike[],
  actor: string,
  nowMs: number,
  windowMs: number = AUDIT_VIEW_WINDOW_MS,
): boolean {
  return !logs.some((log) => {
    if (log.action !== 'platform.audit_log.viewed' || log.actor !== actor) return false;
    const age = nowMs - Date.parse(log.at);
    // NaN（不正な at）は比較で false になり無視される。負の age（未来時刻）は抑制側に倒す。
    return age < windowMs;
  });
}
