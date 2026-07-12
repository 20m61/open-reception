/**
 * 受付履歴 管理 UI の純ロジック (issue #330 item2/item3)。
 *
 * `/admin/audit` のフィルタ純関数（`src/domain/audit/audit-filter.ts`）と同じ流儀で、
 * 検索・絞り込み・ページング・CSV 変換を副作用なしに実装する。ReceptionLog は元々
 * 来訪者の PII を含まない設計（`src/domain/reception/log.ts`）で、CSV も同じ項目
 * （kioskId・目的・呼び出し先名・結果・所要時間・代替導線）のみを出力する。
 */
import type { ReceptionLog } from '@/domain/reception/log';
import type { CallOutcome } from '@/domain/reception/session';

/** 受付履歴の検索条件。未指定（undefined）の項目は絞り込みに使わない。 */
export type ReceptionLogFilter = {
  /** 期間開始（含む）の ISO 文字列/日付文字列。 */
  start?: string;
  /** 期間終了（含む）。**この日の終わりまで**を含む半開区間で扱う。 */
  end?: string;
  /** 結果（複数可、OR）。 */
  outcomes?: readonly CallOutcome[];
  /** 端末 ID の完全一致。 */
  kioskId?: string;
};

/** `end` 日付文字列を「その日の終わり」を含む上限ミリ秒に変換する（audit-filter と同じ規則）。 */
function endBoundary(end: string): number {
  const t = new Date(end).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  if (/^\d{4}-\d{2}-\d{2}$/.test(end.trim())) {
    return t + 86_400_000 - 1;
  }
  return t;
}

/** ログ 1 件がフィルタ条件をすべて満たすか（純関数）。 */
export function matchesReceptionFilter(log: ReceptionLog, filter: ReceptionLogFilter): boolean {
  const at = new Date(log.startedAt).getTime();

  if (filter.start) {
    const start = new Date(filter.start).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(at) && at < start) return false;
  }
  if (filter.end) {
    const upper = endBoundary(filter.end);
    if (!Number.isNaN(at) && at > upper) return false;
  }
  if (filter.outcomes && filter.outcomes.length > 0) {
    if (!filter.outcomes.includes(log.outcome)) return false;
  }
  if (filter.kioskId && filter.kioskId.trim() !== '') {
    if (log.kioskId !== filter.kioskId) return false;
  }
  return true;
}

/** ログ配列をフィルタする（順序は入力のまま保持）。 */
export function filterReceptionLogs(
  logs: readonly ReceptionLog[],
  filter: ReceptionLogFilter,
): ReceptionLog[] {
  return logs.filter((log) => matchesReceptionFilter(log, filter));
}

/** 端末フィルタの選択肢。件数の多い順、同数なら端末 ID 昇順。 */
export function kioskFacets(logs: readonly ReceptionLog[]): Array<{ kioskId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const log of logs) {
    counts.set(log.kioskId, (counts.get(log.kioskId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kioskId, count]) => ({ kioskId, count }))
    .sort((a, b) => b.count - a.count || a.kioskId.localeCompare(b.kioskId));
}

/**
 * 内部の呼び出し失敗理由コード → 日本語ラベル（issue #330 item3）。
 *
 * 非網羅マップ + フォールバック（audit の ACTION_LABEL と同じ流儀）。adapter（mock/vonage）が
 * 返しうる既知コードのみ登録し、未登録コード（Vonage の生エラーメッセージ等）は raw 文字列を
 * そのまま表示する。呼び出し側は raw コードをツールチップ等の詳細に添えてよい。
 */
const FAILURE_REASON_LABEL: Record<string, string> = {
  no_answer: '応答なし',
  timeout: 'タイムアウト',
  call_failed: '通話に失敗',
  target_not_found: '呼び出し先が見つからない',
  vonage_call_failed: '通話サービスとの接続に失敗',
};

/** failureReason の日本語ラベル。未登録コードは raw 文字列、未指定は undefined。 */
export function failureReasonLabel(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  return FAILURE_REASON_LABEL[reason] ?? reason;
}

/** 一覧のページング結果。 */
export type Page<T> = {
  items: T[];
  /** クランプ後の実際のページ番号（1 始まり）。 */
  page: number;
  /** 総ページ数（最低 1）。 */
  pageCount: number;
  /** 絞り込み後の総件数。 */
  total: number;
};

/** 配列を 1 始まりのページに分割する純関数。ページ番号は有効範囲にクランプし、0 除算しない。 */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const startIndex = (clamped - 1) * pageSize;
  return {
    items: items.slice(startIndex, startIndex + pageSize),
    page: clamped,
    pageCount,
    total,
  };
}

/** RFC4180 に沿って 1 セル値をエスケープする（カンマ・改行・ダブルクォートを含む場合のみクォート）。 */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** CSV 出力用の表示ラベル解決。 */
export type ReceptionCsvLabels = {
  outcomeLabel: Record<CallOutcome, string>;
  purposeLabel: (purposeId?: string) => string;
};

const CSV_HEADER = ['開始日時', '端末', '目的', '呼び出し先', '結果', '失敗理由', '所要秒', '代替導線'];

/**
 * 受付履歴を CSV（ヘッダ行付き）へ変換する純関数。
 * 来訪者の氏名・会社名等の PII は ReceptionLog 自体に存在しないため出力にも含まれない。
 */
export function receptionLogsToCsv(
  logs: readonly ReceptionLog[],
  labels: ReceptionCsvLabels,
): string {
  const rows = logs.map((log) => {
    const cells = [
      log.startedAt,
      log.kioskId,
      labels.purposeLabel(log.purpose),
      log.targetLabel ?? '-',
      labels.outcomeLabel[log.outcome],
      failureReasonLabel(log.failureReason) ?? '',
      String(Math.round(log.durationMs / 1000)),
      log.fallbackUsed ? 'あり' : 'いいえ',
    ];
    return cells.map(csvCell).join(',');
  });
  return [CSV_HEADER.join(','), ...rows].join('\n') + '\n';
}
