/**
 * お知らせ集計の単体テスト (issue #83 §8 / #90 increment 3e)。
 */
import { describe, expect, it } from 'vitest';
import { isActiveNotice, summarizeNotices, toNoticeRow, type Notice } from './notice';

function notice(
  args: Partial<Notice> & Pick<Notice, 'id' | 'level' | 'status' | 'publishedAt'>,
): Notice {
  return {
    scope: 'platform',
    title: 't',
    body: 'b',
    createdBy: 'platform:op-1',
    updatedAt: '2026-06-20T00:00:00.000Z',
    ...args,
  };
}

describe('isActiveNotice', () => {
  it('published のみ掲示中', () => {
    expect(isActiveNotice({ status: 'published' })).toBe(true);
    expect(isActiveNotice({ status: 'archived' })).toBe(false);
  });
});

describe('toNoticeRow', () => {
  it('表示用フィールドのみを射影し createdBy を載せない', () => {
    const row = toNoticeRow(
      notice({
        id: 'n1',
        level: 'warning',
        status: 'published',
        publishedAt: '2026-06-20T00:00:00.000Z',
        createdBy: 'platform:secret-op',
      }),
    );
    expect(row).toMatchObject({ id: 'n1', level: 'warning', status: 'published', active: true });
    expect('createdBy' in row).toBe(false);
    expect(JSON.stringify(row)).not.toContain('secret-op');
  });
});

describe('summarizeNotices', () => {
  it('掲示中優先 → 重要度降順 → 公開新しい順', () => {
    const ids = summarizeNotices([
      notice({ id: 'archived-critical', level: 'critical', status: 'archived', publishedAt: '2026-06-19T00:00:00.000Z' }),
      notice({ id: 'pub-info', level: 'info', status: 'published', publishedAt: '2026-06-20T00:00:00.000Z' }),
      notice({ id: 'pub-critical-old', level: 'critical', status: 'published', publishedAt: '2026-06-10T00:00:00.000Z' }),
      notice({ id: 'pub-critical-new', level: 'critical', status: 'published', publishedAt: '2026-06-18T00:00:00.000Z' }),
    ]).notices.map((n) => n.id);
    expect(ids).toEqual(['pub-critical-new', 'pub-critical-old', 'pub-info', 'archived-critical']);
  });

  it('activeCount / totalCount を集計する', () => {
    const summary = summarizeNotices([
      notice({ id: 'a', level: 'info', status: 'published', publishedAt: '2026-06-20T00:00:00.000Z' }),
      notice({ id: 'b', level: 'warning', status: 'archived', publishedAt: '2026-06-19T00:00:00.000Z' }),
    ]);
    expect(summary.activeCount).toBe(1);
    expect(summary.totalCount).toBe(2);
  });

  it('空配列は 0 件', () => {
    expect(summarizeNotices([])).toMatchObject({ activeCount: 0, totalCount: 0, notices: [] });
  });
});
