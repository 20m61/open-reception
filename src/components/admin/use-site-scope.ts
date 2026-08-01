'use client';

import { useCallback, useEffect, useRef, useTransition } from 'react';
import { useQueryParams } from './use-query-params';
import { resolveSiteScopeState } from './site-scope';
import { useSiteList } from './use-site-list';
import type { SiteListStatus } from './site-context';
import type { SiteWithDevices } from '@/lib/tenant/site-service';

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
  sites: SiteWithDevices[];
  siteId: string;
  /** この siteId で取得を始めてよいか。false の間は fetch しない（下の解説参照）。 */
  scopeReady: boolean;
  /**
   * 取得を始めた時点のスコープ識別子。**テナントと拠点の両方**を含む。
   *
   * 拠点だけで識別すると、**テナントを切り替えたときに守れない**。TenantSwitcher で
   * A → B へ移ると `router.refresh()` で同じ manager が再利用されるが、両テナントが
   * 同じ拠点 ID を持っていると「同じ拠点」と見なされ、A の遅い応答が B として採用される。
   * その状態で保存すると **A の内容を tenantId=B で書き込む**（#541 レビュー P1）。
   */
  scopeKey: string;
  /**
   * 応答を反映してよいかの判定。取得開始時の `scopeKey` を渡す。
   *
   * `scopeReady` は「確定前に投げない」ための門で、**取得中に切り替えた場合**は守れない。
   * A の要求が飛行中に B へ切り替えると、遅れて届いた A の応答が B の状態を上書きし、
   * 表示は B なのに**中身は A**になる。その状態で編集・削除すると別の資源を壊す
   * （#535 レビュー P1）。
   */
  isCurrentScope: (startedWith: string) => boolean;
  selectSite: (next: string) => void;
  sitePending: boolean;
  /**
   * 拠点一覧の取得状態。**画面が「拠点が無い」と「一覧を取れていない」を区別できるように
   * 返す**（#552 レビュー P2）。捨てると、取得失敗時にヘッダは「確認できません」と出すのに
   * 本文のセレクタは実在するかのような拠点 ID を表示し、表は「端末 0 件」と断定する。
   */
  listStatus: SiteListStatus;
} {
  const { get, setMany } = useQueryParams();
  // 取得はヘッダの対象拠点表示と同じ共有フックへ寄せる (#423)。取得失敗を空一覧に
  // 潰さないので、「拠点が無い」と「一覧を取れていない」が区別できる。
  const { sites, status: listStatus } = useSiteList(tenantId);

  const { siteId, scopeReady } = (() => {
    const r = resolveSiteScopeState(get('siteId'), sites, fallbackSiteId);
    return { siteId: r.siteId, scopeReady: r.ready };
  })();

  /**
   * URL 遷移が確定するまで真。`setMany` は `router.replace` を起こすだけで、
   * `useSearchParams()` のスナップショットが差し替わるのは遷移確定後なので、その間
   * `siteId` は**古い拠点のまま**。書き込み系はこの間止める（#532 のレビュー指摘）。
   */
  // テナント + 拠点の識別子。区切りは id に現れない制御文字を使う。
  const scopeKey = `${tenantId}\u0000${siteId}`;

  // 現在のスコープを指す参照。応答到着時（＝描画とは別のタイミング）に
  // 「まだこのスコープを見ているか」を判定するために使う。
  // **描画中に ref を書かない**（React の規則。lint が禁止している）ので effect で更新する。
  // 取得も effect 内で始まるため、応答が届く時点では必ず更新済み。
  const currentScopeRef = useRef(scopeKey);
  useEffect(() => {
    currentScopeRef.current = scopeKey;
  }, [scopeKey]);
  const isCurrentScope = useCallback(
    (startedWith: string) => currentScopeRef.current === startedWith,
    [],
  );

  const [sitePending, startSiteTransition] = useTransition();
  const selectSite = useCallback(
    (next: string) => startSiteTransition(() => setMany({ siteId: next, page: '' })),
    [setMany],
  );

  return {
    sites,
    siteId,
    scopeKey,
    scopeReady,
    isCurrentScope,
    selectSite,
    sitePending,
    listStatus,
  };
}
