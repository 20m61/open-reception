'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { ContextChip } from './TenantContextView';
import { isSiteScopedPathname, resolveAdminSiteContext } from './site-context';
import { useSiteList } from './use-site-list';

/** 「対象拠点」の見出し文言。`SiteScopeSelect` のラベルと同じ語にする（別語だと別物に見える）。 */
export const SITE_CONTEXT_LABEL = '対象拠点';

/**
 * ヘッダに「いまどの拠点を見ているか」を常設する (issue #423 受入条件
 * 「主要画面で現在の tenant/site が常に確認できる」の Site 次元)。
 *
 * **クライアント側で解決する。** 共有 layout の props はクライアント遷移では更新されないので
 * （第 87 wave の教訓）、サーバから拠点を渡すと画面を移っても前の画面の拠点を出し続ける。
 * `usePathname` / `useSearchParams` は遷移のたびに再評価される。
 *
 * 判定そのものは純関数 `resolveAdminSiteContext` が持ち、ここは表示だけ。
 */
export function SiteContextChip({
  tenantId,
  fallbackSiteId,
}: {
  tenantId: string;
  /** サーバが解決した既定拠点。拠点別画面が `?siteId=` 未指定のとき本文が使う値と同じもの。 */
  fallbackSiteId: string;
}) {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  // 拠点次元を持たない画面では一覧を取りに行かない（全 admin 画面に 1 本増やさない）。
  const { sites, status } = useSiteList(tenantId, { enabled: isSiteScopedPathname(pathname) });

  const context = resolveAdminSiteContext({
    pathname,
    requestedSiteId: searchParams?.get('siteId') ?? '',
    sites,
    status,
    fallbackSiteId,
  });

  switch (context.kind) {
    case 'not-scoped':
    // 取得中に既定拠点を先に出すと、確定後に別拠点へ書き換わって「勝手に切り替わった」
    // ように見える。確定するまで出さない（本文の `scopeReady` と同じ考え方）。
    case 'loading':
      return null;
    case 'unavailable':
      return (
        <ContextChip
          testId="active-site"
          label={SITE_CONTEXT_LABEL}
          value="確認できません"
          muted
          data-site-state="unavailable"
        />
      );
    case 'unknown':
      return (
        <ContextChip
          testId="active-site"
          label={SITE_CONTEXT_LABEL}
          value={context.siteId}
          muted
          note="（この拠点は見つかりません）"
          data-site-state="unknown"
          data-site-id={context.siteId}
        />
      );
    case 'resolved':
      return (
        <ContextChip
          testId="active-site"
          label={SITE_CONTEXT_LABEL}
          value={context.siteName}
          data-site-state="resolved"
          data-site-id={context.siteId}
          data-site-source={context.source}
        />
      );
  }
}
