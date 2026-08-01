import { describe, expect, it } from 'vitest';
import { isSiteScopedPathname, resolveAdminSiteContext } from './site-context';
import { SITE_SCOPED_PATHS } from './site-destinations';
import { resolveSiteScopeState } from './site-scope';

const SITES = [
  { id: 'default-site', name: '本社' },
  { id: 'branch-site', name: '大阪支社' },
];

function ctx(over: Partial<Parameters<typeof resolveAdminSiteContext>[0]> = {}) {
  return resolveAdminSiteContext({
    pathname: '/admin/operating-hours',
    requestedSiteId: '',
    sites: SITES,
    status: 'ready',
    fallbackSiteId: 'default-site',
    ...over,
  });
}

describe('resolveAdminSiteContext (#423 共通コンテキストバーの site 次元)', () => {
  describe('拠点次元を持たない画面', () => {
    it.each(['/admin', '/admin/departments', '/admin/audit', '/admin/sites'])(
      '%s では拠点を出さない',
      (pathname) => {
        expect(ctx({ pathname })).toEqual({ kind: 'not-scoped' });
      },
    );

    it('拠点一覧 `/admin/sites` は対象が 1 つに絞られていないので出さない', () => {
      // 一覧で「対象拠点: 本社」と出すと、一覧が本社に絞られているように読める。
      expect(ctx({ pathname: '/admin/sites' })).toEqual({ kind: 'not-scoped' });
    });
  });

  describe('拠点別設定画面（`?siteId=` を読む画面）', () => {
    it('URL が指定した拠点を採用する', () => {
      expect(ctx({ requestedSiteId: 'branch-site' })).toEqual({
        kind: 'resolved',
        siteId: 'branch-site',
        siteName: '大阪支社',
        source: 'query',
      });
    });

    it('URL 未指定なら既定拠点を出す', () => {
      expect(ctx()).toEqual({
        kind: 'resolved',
        siteId: 'default-site',
        siteName: '本社',
        source: 'default',
      });
    });

    it.each([
      ['', 'default-site'],
      ['branch-site', 'branch-site'],
      ['missing-site', 'default-site'],
    ])(
      '本文（resolveSiteScopeState）と同じ拠点を指す: ?siteId=%s',
      (requestedSiteId, expected) => {
        // **ヘッダと本文がずれると嘘になる。** platform で実際に起きた事故
        // （ヘッダは Cookie の選択、本文は URL のテナントを出す）と同じ形を作らない。
        const body = resolveSiteScopeState(requestedSiteId, SITES, 'default-site');
        const header = ctx({ requestedSiteId });
        expect(body.siteId).toBe(expected);
        expect(header).toMatchObject({ kind: 'resolved', siteId: body.siteId });
      },
    );

    it('既定拠点がこのテナントに無ければ先頭へ倒れる（本文と同じ）', () => {
      const header = ctx({ fallbackSiteId: 'other-tenant-site' });
      expect(header).toMatchObject({ kind: 'resolved', siteId: 'default-site' });
    });

    it('拠点名が無ければ id を出す（空欄にしない）', () => {
      expect(ctx({ sites: [{ id: 'default-site' }] })).toEqual({
        kind: 'resolved',
        siteId: 'default-site',
        siteName: 'default-site',
        source: 'default',
      });
    });
  });

  describe('拠点詳細 `/admin/sites/[siteId]`', () => {
    it('URL の拠点をそのまま対象にする', () => {
      expect(ctx({ pathname: '/admin/sites/branch-site' })).toEqual({
        kind: 'resolved',
        siteId: 'branch-site',
        siteName: '大阪支社',
        source: 'route',
      });
    });

    it('末尾スラッシュでも同じ', () => {
      expect(ctx({ pathname: '/admin/sites/branch-site/' })).toMatchObject({
        kind: 'resolved',
        siteId: 'branch-site',
      });
    });

    it('一覧に無い拠点は黙って既定へ倒さず「不明」として出す', () => {
      // route は運用者が明示した対象。黙って別拠点へ倒すと、**別拠点の設定を見ているのに
      // 気づけない**（#423「画面移動によって対象が暗黙に別テナント/拠点へ切り替わらない」）。
      expect(ctx({ pathname: '/admin/sites/ghost-site' })).toEqual({
        kind: 'unknown',
        siteId: 'ghost-site',
      });
    });

    it('`?siteId=` が付いていても route を優先する', () => {
      expect(
        ctx({ pathname: '/admin/sites/branch-site', requestedSiteId: 'default-site' }),
      ).toMatchObject({ kind: 'resolved', siteId: 'branch-site', source: 'route' });
    });
  });

  describe('一覧が確定していないとき', () => {
    it('取得中は何も断定しない', () => {
      expect(ctx({ status: 'loading', sites: [] })).toEqual({ kind: 'loading' });
      expect(ctx({ pathname: '/admin/sites/branch-site', status: 'loading', sites: [] })).toEqual({
        kind: 'loading',
      });
    });

    it('取得に失敗したら「確認できない」と出す（既定拠点を騙らない）', () => {
      expect(ctx({ status: 'error', sites: [] })).toEqual({ kind: 'unavailable' });
    });

    it('拠点次元を持たない画面では取得状態に関わらず何も出さない', () => {
      expect(ctx({ pathname: '/admin/audit', status: 'loading', sites: [] })).toEqual({
        kind: 'not-scoped',
      });
    });

    it('一覧が空（拠点が 1 つも無い）なら確認できない扱い', () => {
      expect(ctx({ status: 'ready', sites: [] })).toEqual({ kind: 'unavailable' });
    });

    it('取りに行っていない（idle）状態を「取得失敗」と混同しない', () => {
      // 拠点次元を持たない画面では一覧を取らない。もし idle が unavailable に落ちると、
      // 判定を 1 箇所でも間違えたときに全画面へ「確認できません」が出る。
      expect(ctx({ status: 'idle', sites: [] })).toEqual({ kind: 'loading' });
    });
  });

  describe('取得の要否（`isSiteScopedPathname`）', () => {
    it.each(SITE_SCOPED_PATHS.filter((p) => !p.includes('[')))('%s は取りに行く', (pathname) => {
      expect(isSiteScopedPathname(pathname)).toBe(true);
    });

    it('拠点詳細も取りに行く', () => {
      expect(isSiteScopedPathname('/admin/sites/branch-site')).toBe(true);
    });

    it.each(['/admin', '/admin/audit', '/admin/sites', '/admin/staff'])(
      '%s は取りに行かない',
      (pathname) => {
        expect(isSiteScopedPathname(pathname)).toBe(false);
      },
    );

    it('判定は resolveAdminSiteContext と一致する', () => {
      // 2 箇所で別々に判定すると、片方だけ直したときに「取りに行かないのに出す」
      // （＝永遠に loading）が起きる。
      for (const pathname of ['/admin/devices', '/admin/audit', '/admin/sites/branch-site']) {
        const scoped = isSiteScopedPathname(pathname);
        const kind = ctx({ pathname }).kind;
        expect(scoped).toBe(kind !== 'not-scoped');
      }
    });
  });
});
