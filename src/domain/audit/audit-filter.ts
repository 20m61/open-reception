/**
 * 監査ログの検索・フィルタ純関数 (issue #89, increment 2)。
 *
 * `/admin/audit` の表示を期間・アクション種別・主体（actor）・対象でフィルタするための
 * 純粋ロジック。I/O は持たない（読み取り専用・テスト容易）。
 *
 * PII 非露出: AuditLog は元々 PII を持たない（来訪者氏名・会話内容などは記録しない設計）。
 * 本フィルタは既存フィールド（action / actor / targetType / targetId / at）と metadata の
 * 値のみを突合し、新たな個人情報を持ち込まない。
 *
 * 監査アクションの新規追加はしない（src/domain/reception/log.ts は触らない）。表示ラベルは
 * 既存 UI 側の非網羅マップ（フォールバックあり）を使う。
 */
import type { AuditLog } from '@/domain/reception/log';

/** 監査ログの検索条件。未指定（undefined / 空文字）の項目は絞り込みに使わない。 */
export type AuditFilter = {
  /** 期間開始（含む）の ISO 文字列。未指定なら下限なし。 */
  start?: string;
  /** 期間終了（含む）の ISO 文字列。**この日の終わりまで**を含む半開区間で扱う。未指定なら上限なし。 */
  end?: string;
  /** アクション種別の完全一致（複数可、OR）。空配列・未指定なら全アクション。 */
  actions?: readonly string[];
  /** 主体（actor）の部分一致（大文字小文字を無視）。 */
  actor?: string;
  /** 対象（targetType / targetId / アクション / metadata 値）への横断キーワード（部分一致）。 */
  keyword?: string;
};

/** 文字列を比較用に正規化（前後空白除去・小文字化）。 */
function norm(value: string): string {
  return value.trim().toLowerCase();
}

/** `end` 日付文字列を「その日の終わり（翌日 0 時の直前）」を含む上限ミリ秒に変換する。 */
function endBoundary(end: string): number {
  const t = new Date(end).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  // 'YYYY-MM-DD'（日付のみ）の場合はその日いっぱいを含めたいので 1 日後の直前まで広げる。
  if (/^\d{4}-\d{2}-\d{2}$/.test(end.trim())) {
    return t + 86_400_000 - 1;
  }
  return t;
}

/** ログ 1 件がフィルタ条件をすべて満たすか（純関数）。 */
export function matchesAuditFilter(log: AuditLog, filter: AuditFilter): boolean {
  const at = new Date(log.at).getTime();

  if (filter.start) {
    const start = new Date(filter.start).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(at) && at < start) return false;
  }
  if (filter.end) {
    const upper = endBoundary(filter.end);
    if (!Number.isNaN(at) && at > upper) return false;
  }

  if (filter.actions && filter.actions.length > 0) {
    if (!filter.actions.includes(log.action)) return false;
  }

  if (filter.actor && filter.actor.trim() !== '') {
    if (!norm(log.actor).includes(norm(filter.actor))) return false;
  }

  if (filter.keyword && filter.keyword.trim() !== '') {
    const needle = norm(filter.keyword);
    const haystack = [
      log.action,
      log.targetType ?? '',
      log.targetId ?? '',
      ...(log.metadata ? Object.values(log.metadata) : []),
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

/** ログ配列をフィルタする（順序は入力のまま保持）。 */
export function filterAuditLogs(logs: readonly AuditLog[], filter: AuditFilter): AuditLog[] {
  return logs.filter((log) => matchesAuditFilter(log, filter));
}

/**
 * ログ集合に実在するアクション種別を出現頻度つきで返す（フィルタ UI の選択肢生成用）。
 * 件数の多い順、同数ならアクション名昇順で安定ソートする。
 */
export function auditActionFacets(logs: readonly AuditLog[]): Array<{ action: string; count: number }> {
  const counts = new Map<string, number>();
  for (const log of logs) {
    counts.set(log.action, (counts.get(log.action) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => (b.count - a.count) || a.action.localeCompare(b.action));
}
