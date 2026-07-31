'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useQueryParams } from './use-query-params';
import { resolveSiteScope, type SelectableSite } from './site-scope';

/**
 * 拠点スコープを URL と同期する共有フック (issue #421)。
 *
 * 拠点別の設定画面（営業時間・呼び出しルート・取次ルート）は `resolveDefaultScope()` の
 * 拠点に**固定**されていて、UI から別拠点を開く手段が無かった。env でしか変えられないため、
 * 複数拠点のテナントでは 2 つ目の拠点の設定に到達できない。#421 の
 * 「拠点詳細から全関連設定へ到達できる」はここが直らないと成立しない。
 *
 * 同じ配線を画面ごとに書くと必ずずれるので 1 箇所へ集約する。真実源は URL
 * （`docs/admin-spa-design.md`）で、新しい状態ストアは作らない。
 *
 * 認可は UI ではなく API 側が actor を正として検証する（`assertCanReadSite` /
 * `assertCanWriteSite` / `canAccessSite`）。ここで任意の siteId を渡せても境界は破れない。
 */
export function useSiteScope(
  tenantId: string,
  fallbackSiteId: string,
): {
  sites: SelectableSite[];
  siteId: string;
  selectSite: (next: string) => void;
  sitePending: boolean;
} {
  const { get, setMany } = useQueryParams();
  const [sites, setSites] = useState<SelectableSite[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/admin/sites?tenantId=${encodeURIComponent(tenantId)}`);
      if (!res.ok) return;
      const list = (await res.json()) as SelectableSite[];
      if (!cancelled) setSites(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const siteId = resolveSiteScope(get('siteId'), sites, fallbackSiteId);

  /**
   * URL 遷移が確定するまで真。`setMany` は `router.replace` を起こすだけで、
   * `useSearchParams()` のスナップショットが差し替わるのは遷移確定後なので、その間
   * `siteId` は**古い拠点のまま**。書き込み系はこの間止める（#532 のレビュー指摘）。
   */
  const [sitePending, startSiteTransition] = useTransition();
  const selectSite = useCallback(
    (next: string) => startSiteTransition(() => setMany({ siteId: next, page: '' })),
    [setMany],
  );

  return { sites, siteId, selectSite, sitePending };
}
