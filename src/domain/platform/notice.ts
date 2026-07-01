/**
 * プラットフォームお知らせ（Notice） (issue #83 §8 / #90 increment 3e)。
 *
 * 運用者がテナント/拠点/端末/全体へ向けて公開する「お知らせ」（メンテナンス予告・一般周知など。
 * 障害=Incident とは別で、進行中の障害ではなく告知）。本モジュールは read 用の集計・射影の
 * 純関数。I/O は持たない（永続化は src/lib/platform/notice-store）。
 *
 * セキュリティ/PII 方針（#83）: 横断 read 行に PII を含めない。`createdBy`（操作者識別子）は
 * 表示行に載せない。title/body は運用者が記述する告知であり機密値・個人情報を書かない運用とする。
 */

import { byFlagRankTimeDesc } from './scoped-summary';

/** 影響/対象範囲。 */
export type NoticeScope = 'platform' | 'tenant' | 'site' | 'device';

/** お知らせの重要度。 */
export type NoticeLevel = 'info' | 'warning' | 'critical';

/** 公開状態。`published` を「掲示中（active）」とみなす。 */
export type NoticeStatus = 'published' | 'archived';

/** お知らせ（#83 §8 告知）。 */
export type Notice = {
  id: string;
  scope: NoticeScope;
  tenantId?: string;
  siteId?: string;
  deviceId?: string;
  level: NoticeLevel;
  title: string;
  body: string;
  status: NoticeStatus;
  /** 公開日時（ISO）。 */
  publishedAt: string;
  /** 作成者（操作者識別子）。横断 read 行には載せない。 */
  createdBy: string;
  /** 最終更新（ISO）。 */
  updatedAt: string;
};

/** 横断 read 用のお知らせ行。PII・操作者識別子を含めない。 */
export type NoticeRow = {
  id: string;
  scope: NoticeScope;
  tenantId?: string;
  siteId?: string;
  deviceId?: string;
  level: NoticeLevel;
  title: string;
  body: string;
  status: NoticeStatus;
  publishedAt: string;
  /** published を active とみなす。 */
  active: boolean;
};

/** お知らせの横断集計。 */
export type NoticeSummary = {
  /** 掲示中（published）の件数。 */
  activeCount: number;
  /** 全件数（archived 含む）。 */
  totalCount: number;
  /** 表示用に並べ替えた行（掲示中優先 → 公開新しい順）。 */
  notices: NoticeRow[];
};

/** 重要度の順位（大きいほど重要）。並べ替えに使う。 */
const LEVEL_RANK: Record<NoticeLevel, number> = { info: 0, warning: 1, critical: 2 };

/** 掲示中（published）か。 */
export function isActiveNotice(notice: Pick<Notice, 'status'>): boolean {
  return notice.status === 'published';
}

/** お知らせを横断 read 行へ射影する純関数（whitelist。createdBy は載せない）。 */
export function toNoticeRow(notice: Notice): NoticeRow {
  return {
    id: notice.id,
    scope: notice.scope,
    tenantId: notice.tenantId,
    siteId: notice.siteId,
    deviceId: notice.deviceId,
    level: notice.level,
    title: notice.title,
    body: notice.body,
    status: notice.status,
    publishedAt: notice.publishedAt,
    active: isActiveNotice(notice),
  };
}

/**
 * お知らせ一覧を横断集計する純関数。
 * 並び順: 掲示中（active）を先頭 → 重要度降順 → 公開日時の新しい順。
 */
export function summarizeNotices(notices: readonly Notice[]): NoticeSummary {
  const rows = notices.map(toNoticeRow).sort(
    byFlagRankTimeDesc({
      flagOf: (r) => r.active,
      rankOf: (r) => LEVEL_RANK[r.level],
      timeOf: (r) => r.publishedAt,
    }),
  );

  return {
    activeCount: rows.filter((r) => r.active).length,
    totalCount: rows.length,
    notices: rows,
  };
}
