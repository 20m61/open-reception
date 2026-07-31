import { describe, expect, it } from 'vitest';
import { SITE_DESTINATIONS, siteDestinationHref } from './site-destinations';

describe('拠点詳細から辿る設定の登録簿 (#421)', () => {
  it('拠点スコープを運べる導線には siteId を付ける', () => {
    const scoped = SITE_DESTINATIONS.filter((d) => d.siteScoped);
    expect(scoped.length).toBeGreaterThan(0);
    for (const d of scoped) {
      expect(siteDestinationHref(d, 'branch-site')).toBe(`${d.href}?siteId=branch-site`);
    }
  });

  it('拠点スコープに対応していない導線には siteId を付けない', () => {
    // **付けても無視される導線に付けない**のが要点。リンクが拠点を運んでいるように
    // 見えて実際は捨てられる、という状態（本リポジトリが繰り返し警告している
    // 「消費者ゼロの契約」）を作らない。
    const unscoped = SITE_DESTINATIONS.filter((d) => !d.siteScoped);
    expect(unscoped.length).toBeGreaterThan(0);
    for (const d of unscoped) {
      expect(siteDestinationHref(d, 'branch-site')).toBe(d.href);
    }
  });

  it('siteId が空なら誰にも付けない', () => {
    for (const d of SITE_DESTINATIONS) {
      expect(siteDestinationHref(d, '')).toBe(d.href);
    }
  });

  it('拠点スコープ対応の導線は、実際に URL から siteId を読む画面だけ', () => {
    // ここを更新するときは**実装を確認してから**にする。登録簿だけ先に増やすと
    // リンクが嘘になる。2026-07-31 時点で対応済みなのは以下の 4 つ。
    expect(SITE_DESTINATIONS.filter((d) => d.siteScoped).map((d) => d.href).sort()).toEqual([
      '/admin/call-routes',
      '/admin/call-routing',
      '/admin/devices',
      '/admin/operating-hours',
    ]);
  });
});
