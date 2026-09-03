import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Pager } from './Pager';

/**
 * ページ送りの不変条件 (#910 / 課題 18)。
 *
 * 同じ形が 6 ファイルに写されていたものを共有へ寄せた部品。分岐ごとの見た目ではなく、
 * **押せる/押せないが実際の位置と一致すること**を縛る（ここがずれると、最初のページで
 * 「前へ」が押せて空の一覧が出る、最後で「次へ」が押せて何も起きない、が起きる）。
 */
function render(props: Parameters<typeof Pager>[0]): string {
  return renderToStaticMarkup(<Pager {...props} />);
}

const BASE = { onChange: () => {}, testIdPrefix: 'dept' } as const;

describe('Pager', () => {
  it('🔴 下界: 1 ページに収まるなら何も描かない', () => {
    // 押せないページ送りを常時出すと「一覧が途中で切れている」と読ませる。
    expect(render({ ...BASE, page: 1, pageCount: 1 })).toBe('');
    expect(render({ ...BASE, page: 1, pageCount: 0 })).toBe('');
  });

  it('先頭ページでは「前へ」だけが押せない', () => {
    const html = render({ ...BASE, page: 1, pageCount: 3 });
    expect(html).toMatch(/data-testid="dept-page-prev"[^>]*disabled/);
    expect(html).not.toMatch(/data-testid="dept-page-next"[^>]*disabled/);
  });

  it('最終ページでは「次へ」だけが押せない', () => {
    const html = render({ ...BASE, page: 3, pageCount: 3 });
    expect(html).toMatch(/data-testid="dept-page-next"[^>]*disabled/);
    expect(html).not.toMatch(/data-testid="dept-page-prev"[^>]*disabled/);
  });

  it('中間ページでは両方押せる', () => {
    const html = render({ ...BASE, page: 2, pageCount: 3 });
    expect(html).not.toMatch(/disabled/);
  });

  it('いま何ページ目かを出す', () => {
    expect(render({ ...BASE, page: 2, pageCount: 5 })).toContain('2 / 5 ページ');
  });

  it('testid は一覧ごとに分かれる（移行しても e2e の引き先が変わらない）', () => {
    const html = render({ ...BASE, page: 2, pageCount: 3, testIdPrefix: 'site' });
    expect(html).toContain('data-testid="site-pagination"');
    expect(html).toContain('data-testid="site-page-prev"');
    expect(html).toContain('data-testid="site-page-label"');
    expect(html).toContain('data-testid="site-page-next"');
  });
});
