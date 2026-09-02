import type { AuditLog } from '@/domain/reception/log';
import { toCsv } from '@/components/admin/list-io';

/**
 * 監査ログ一覧の純ロジック (#905 / 課題 17)。
 *
 * ページングは `list-io.ts` の `paginate` をそのまま使う（受付履歴と同じ実装）。
 * ここに置くのは CSV の組み立てだけ。
 */

/** CSV の列。**画面に出ている 4 列と同じ**にする。 */
export const AUDIT_CSV_HEADER = ['日時', '操作', '主体', '対象種別', '対象 ID'] as const;

/**
 * 監査ログを CSV へ。
 *
 * 🔴 **`metadata` は書き出さない。** #889 で運用者が入力する `reason` が載るようになっており、
 * 自由文をエクスポートすると PII 混入の窓が開く（`.claude/rules/pii-secret-minimization.md`:
 * 監査ログに来訪者の氏名/会社名/メモ等を残さない）。画面に出ていないものを
 * ファイルにだけ出す、という非対称を作らない意味もある。
 *
 * セルのエスケープと数式インジェクション無害化は `toCsv` → `csvCell` が担う。
 * `actor` と `targetId` は運用者が触れる文字列なので、**受付履歴に入れた対策を
 * ここへ写さないと同じ穴が片側だけ空く**（#330 レビューの指摘と同型）。
 */
export function auditLogsToCsv(
  logs: readonly AuditLog[],
  labelFor: (action: string) => string,
): string {
  const rows = logs.map((log) => [
    log.at,
    labelFor(log.action),
    log.actor,
    log.targetType ?? '',
    log.targetId ?? '',
  ]);
  return toCsv(AUDIT_CSV_HEADER, rows);
}
