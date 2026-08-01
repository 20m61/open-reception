import { describe, expect, it } from 'vitest';
import { resolveSiteListFeedback } from './site-list-feedback';

describe('resolveSiteListFeedback (#554 M3)', () => {
  it('取得に失敗したら「拠点が無い」と断定しない', () => {
    const f = resolveSiteListFeedback('error', false);
    expect(f.emptyMessage).toContain('取得できませんでした');
    expect(f.emptyMessage).not.toContain('ありません。');
    expect(f.showRetry).toBe(true);
  });

  it('取得に失敗したら件数を出さない', () => {
    // 「0 件中 0 件を表示」は取得できた結果としてしか読めない。
    expect(resolveSiteListFeedback('error', false).showCount).toBe(false);
  });

  it('取得中も断定しない', () => {
    const f = resolveSiteListFeedback('loading', false);
    expect(f.emptyMessage).toBe('読み込み中…');
    expect(f.showCount).toBe(false);
    // まだ失敗していないので再試行は出さない（押せる操作を増やして迷わせない）。
    expect(f.showRetry).toBe(false);
  });

  it('取りに行っていない状態も取得中と同じ扱い', () => {
    expect(resolveSiteListFeedback('idle', false)).toEqual(
      resolveSiteListFeedback('loading', false),
    );
  });

  it('取得できていれば空の理由を絞り込みの有無で言い分ける', () => {
    expect(resolveSiteListFeedback('ready', false).emptyMessage).toBe(
      'このテナントに登録された拠点はありません。',
    );
    expect(resolveSiteListFeedback('ready', true).emptyMessage).toBe(
      '条件に一致する拠点はありません。',
    );
  });

  it('取得できているときだけ件数を出す', () => {
    expect(resolveSiteListFeedback('ready', false).showCount).toBe(true);
    expect(resolveSiteListFeedback('ready', false).showRetry).toBe(false);
  });

  it('絞り込みの有無は取得失敗の伝え方を変えない', () => {
    // 絞り込み中に失敗したとき「条件に一致する拠点はありません」と出すと、
    // 条件のせいだと誤解する。
    expect(resolveSiteListFeedback('error', true)).toEqual(resolveSiteListFeedback('error', false));
  });
});
