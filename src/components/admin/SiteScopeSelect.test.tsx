import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteScopeSelect } from './SiteScopeSelect';

/**
 * 拠点一覧を取れなかったときの**復帰導線** (#554 M3)。
 *
 * それまでは失敗を「拠点一覧を取得できません」という option 名で伝えるだけで、
 * 運用者にできることが**画面全体のリロードしか無かった**。拠点別画面は一覧が確定するまで
 * 本文の取得を始めないので（`resolveSiteScopeState` の `ready`）、一覧の失敗は
 * その画面の機能全部を止める。再試行はここに要る。
 */

function render(props: Partial<Parameters<typeof SiteScopeSelect>[0]> = {}): string {
  return renderToStaticMarkup(
    <SiteScopeSelect
      sites={[{ id: 'default-site', name: '本社' }]}
      siteId="default-site"
      onSelect={() => {}}
      onRetry={() => {}}
      {...props}
    />,
  );
}

describe('SiteScopeSelect', () => {
  it('取得に失敗したら再試行を出す', () => {
    const html = render({ sites: [], status: 'error' });
    expect(html).toContain('site-scope-select-retry');
    expect(html).toContain('再試行');
  });

  it('取得に失敗したとき拠点 ID を名指ししない', () => {
    // ヘッダは「確認できません」と言っているのに本文が拠点を名指しすると、
    // どちらが本当か分からなくなる（#552 レビュー P2）。
    const html = render({ sites: [], siteId: 'default-site', status: 'error' });
    expect(html).toContain('拠点一覧を取得できません');
    expect(html).not.toContain('>default-site<');
  });

  it('取得できているときは再試行を出さない', () => {
    const html = render({ status: 'ready' });
    expect(html).not.toContain('site-scope-select-retry');
  });

  it('取得中は再試行を出さない（まだ失敗していない）', () => {
    const html = render({ sites: [], status: 'loading' });
    expect(html).not.toContain('site-scope-select-retry');
  });

  it('testId を変えると再試行の testId も一緒に変わる', () => {
    // 画面ごとに testId を変えるのに再試行だけ固定だと、同一ページに複数置いたとき
    // e2e が別画面のボタンを掴む。
    const html = render({ sites: [], status: 'error', testId: 'devices-site-select' });
    expect(html).toContain('devices-site-select-retry');
  });
});
