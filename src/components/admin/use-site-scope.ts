'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useQueryParams } from './use-query-params';
import { resolveSiteScopeState, type SelectableSite } from './site-scope';

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
  /** この siteId で取得を始めてよいか。false の間は fetch しない（下の解説参照）。 */
  scopeReady: boolean;
  /**
   * 応答を反映してよいかの判定。**取得を始めた拠点**を渡す。
   *
   * `scopeReady` は「確定前に投げない」ための門で、**取得中に拠点を切り替えた場合**は
   * 守れない。A の一覧要求が飛行中に B へ切り替えると、遅れて届いた A の応答が
   * B の状態を上書きし、見出しとセレクタは B なのに**中身は A**になる。その状態で
   * 編集・削除すると別拠点の資源を壊す（#535 レビュー P1）。
   */
  isCurrentSite: (startedWith: string) => boolean;
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

  const { siteId, scopeReady } = (() => {
    const r = resolveSiteScopeState(get('siteId'), sites, fallbackSiteId);
    return { siteId: r.siteId, scopeReady: r.ready };
  })();

  /**
   * URL 遷移が確定するまで真。`setMany` は `router.replace` を起こすだけで、
   * `useSearchParams()` のスナップショットが差し替わるのは遷移確定後なので、その間
   * `siteId` は**古い拠点のまま**。書き込み系はこの間止める（#532 のレビュー指摘）。
   */
  // 現在の siteId を指す参照。応答到着時（＝描画とは別のタイミング）に
  // 「まだこの拠点を見ているか」を判定するために使う。
  // **描画中に ref を書かない**（React の規則。lint が禁止している）ので effect で更新する。
  // 取得も effect 内で始まるため、応答が届く時点では必ず更新済み。
  const currentSiteRef = useRef(siteId);
  useEffect(() => {
    currentSiteRef.current = siteId;
  }, [siteId]);
  const isCurrentSite = useCallback((startedWith: string) => currentSiteRef.current === startedWith, []);

  const [sitePending, startSiteTransition] = useTransition();
  const selectSite = useCallback(
    (next: string) => startSiteTransition(() => setMany({ siteId: next, page: '' })),
    [setMany],
  );

  return { sites, siteId, scopeReady, isCurrentSite, selectSite, sitePending };
}
