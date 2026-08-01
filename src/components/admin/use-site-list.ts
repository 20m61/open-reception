'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SiteWithDevices } from '@/lib/tenant/site-service';
import type { SiteListStatus } from './site-context';

/**
 * テナント配下の拠点一覧を取る共有フック (issue #423)。
 *
 * 同じ `GET /api/admin/sites?tenantId=` が **4 箇所に別々の形で**書かれていた
 * （`use-site-scope` / `SiteDetail` / `DevicesManager` / `SitesManager`）。取得状態の扱いも
 * ばらばらで、失敗を握り潰すもの（一覧が空 = 「拠点が無い」に見える）と、
 * `error` を持つものが混在していた。ヘッダの対象拠点表示で 5 本目を足す前に 1 箇所へ寄せる。
 *
 * 認可は API 側が actor を正として検証する。ここは表示のための read だけを持つ。
 */
export function useSiteList(
  tenantId: string,
  /**
   * 取りに行くか。ヘッダの対象拠点表示は**拠点次元を持たない画面では出さない**ので、
   * そこで一覧を取ると全 admin 画面に無駄な API 呼び出しが 1 本増える。
   */
  { enabled = true }: { enabled?: boolean } = {},
): {
  sites: SiteWithDevices[];
  status: SiteListStatus;
  /** 作成・更新のあとに呼ぶ。 */
  reload: () => Promise<void>;
} {
  const [sites, setSites] = useState<SiteWithDevices[]>([]);
  const [status, setStatus] = useState<SiteListStatus>(enabled ? 'loading' : 'idle');

  /**
   * `cancelled` を呼び出し側から渡せる形にしておく（アンマウント後の setState を避ける）。
   * 明示的な `reload()` では常に反映してよいので既定は「反映する」。
   */
  const fetchSites = useCallback(
    async (isStale: () => boolean = () => false) => {
      let res: Response;
      try {
        res = await fetch(`/api/admin/sites?tenantId=${encodeURIComponent(tenantId)}`);
      } catch {
        // オフライン・DNS 失敗など。**空一覧にしない** — 「拠点が 1 つも無い」と区別が付かない。
        if (!isStale()) setStatus('error');
        return;
      }
      if (isStale()) return;
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const list = (await res.json()) as SiteWithDevices[];
      if (isStale()) return;
      setSites(list);
      setStatus('ready');
    },
    [tenantId],
  );

  useEffect(() => {
    let cancelled = false;
    // テナントが変わったら前テナントの一覧を残さない（別テナントの拠点を見せない）。
    setSites([]);
    if (!enabled) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    void fetchSites(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchSites, enabled]);

  const reload = useCallback(() => fetchSites(), [fetchSites]);

  return { sites, status, reload };
}
