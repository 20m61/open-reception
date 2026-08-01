'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SiteWithDevices } from '@/lib/tenant/site-service';
import type { SiteListStatus } from './site-context';

/**
 * **同一テナントに対する飛行中の要求**。ヘッダのチップと本文のマネージャは別インスタンスの
 * フックなので、素朴に書くと 1 画面あたり同じ GET が 2 本飛ぶ（#552 レビュー P2）。
 * 解決済みの結果はキャッシュしない（古い一覧を見せない）— **飛行中のものだけ相乗りする**。
 */
const inFlight = new Map<string, Promise<Response>>();

/**
 * 拠点一覧取得の締切 (#554 レビュー N8)。
 *
 * これが無いと、**応答が返らないときだけ失敗にすら遷移できない**。`useSiteList` の
 * `status` は `loading` のまま、`resolveSiteScopeState` は `ready:false` を返し続けるので
 * 本文は 1 本も取得を始められず、再試行の手段も無い（＝画面ごと復帰不能）。
 * 失敗にさえ落ちれば、あとはエラー表示と再試行で運用者が抜けられる。
 */
export const SITE_LIST_TIMEOUT_MS = 10_000;

/** body 抜きの応答（`new Response(body, {status})` が投げる status）。 */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * 締切付きで 1 本投げ、**body まで読み切ってから**返す。
 *
 * ヘッダ到着で締切を解除すると、body が止まった場合に同じ永久 loading へ戻る
 * （`useSiteList` は `await res.json()` で待つ）。だから buffer し切るまで締切を効かせる。
 * 読み切った応答を返すので、相乗り側の `clone()` も安全になる。
 */
function fetchWithDeadline(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_LIST_TIMEOUT_MS);
  return fetch(url, { signal: controller.signal })
    .then(async (res) => {
      const body = NULL_BODY_STATUS.has(res.status) ? null : await res.text();
      // 読み切った本文は元の転送表現と一致しない（圧縮されていた場合、長さも符号化も違う）。
      // その 2 つだけ落として付け替える。
      const headers = new Headers(res.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new Response(body, { status: res.status, statusText: res.statusText, headers });
    })
    .finally(() => clearTimeout(timer));
}

export function fetchSiteList(tenantId: string): Promise<Response> {
  const url = `/api/admin/sites?tenantId=${encodeURIComponent(tenantId)}`;
  const pending = inFlight.get(tenantId);
  if (pending !== undefined) return pending.then((res) => res.clone());
  const started = fetchWithDeadline(url);
  inFlight.set(tenantId, started);
  // **`finally` の戻り値を捨てない。** `p.finally(cb)` は p と同じ理由で reject する新しい
  // promise を返すので、`void` で捨てるとオフライン時に unhandled rejection になる
  // （#552 レビュー P2。dev のエラーオーバーレイや e2e のノイズ源になる）。
  const forget = () => {
    if (inFlight.get(tenantId) === started) inFlight.delete(tenantId);
  };
  started.then(forget, forget);
  // 相乗り側が body を読めるよう、自分も clone を読む。
  return started.then((res) => res.clone());
}

/**
 * マウント中の `useSiteList` を再取得のために登録する。
 *
 * ヘッダの対象拠点チップと本文のマネージャは**別インスタンスで別々の状態**を持つ。
 * 初回は in-flight 相乗りで同じ結果になるが、その後の再取得（再試行・拠点の作成）は
 * 自分の状態しか更新しない。そのままだと**本文で再試行が成功してもヘッダは
 * 「確認できません」のまま**になり、直したのに直っていないように見える。
 */
type SiteListListener = () => Promise<void>;
const listeners = new Map<string, Set<SiteListListener>>();

export function subscribeSiteList(tenantId: string, listener: SiteListListener): () => void {
  const forTenant = listeners.get(tenantId) ?? new Set<SiteListListener>();
  listeners.set(tenantId, forTenant);
  forTenant.add(listener);
  return () => {
    forTenant.delete(listener);
    if (forTenant.size === 0) listeners.delete(tenantId);
  };
}

/**
 * そのテナントの一覧を持つ**全インスタンス**に取り直させ、全部の反映を待つ。
 *
 * 先に飛行中の記録を落とすのが要点。落とさないと、**書き込み前に飛んだ要求**や
 * **打ち切り済みの要求**に相乗りして、再試行が永久に効かない。落としたあとは
 * 各インスタンスがほぼ同時に投げるので、新しい 1 本へ相乗りして収まる。
 */
export function invalidateSiteList(tenantId: string): Promise<void> {
  inFlight.delete(tenantId);
  return Promise.all(
    // 1 つが投げても他を巻き添えにしない（各インスタンスは自分で `error` を持つ）。
    [...(listeners.get(tenantId) ?? [])].map((listener) => listener().catch(() => undefined)),
  ).then(() => undefined);
}

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
  /**
   * 作成・更新のあと、および取得失敗からの再試行で呼ぶ。
   * **同じテナントの他のインスタンスも一緒に取り直す**（ヘッダと本文をずらさない）。
   */
  reload: () => Promise<void>;
} {
  const [sites, setSites] = useState<SiteWithDevices[]>([]);
  const [status, setStatus] = useState<SiteListStatus>(enabled ? 'loading' : 'idle');
  /** この instance が最後に始めた取得の番号（古い応答を捨てるため）。 */
  const latestRequest = useRef(0);

  /**
   * `cancelled` を呼び出し側から渡せる形にしておく（アンマウント後の setState を避ける）。
   * 明示的な `reload()` では常に反映してよいので既定は「反映する」。
   */
  const fetchSites = useCallback(
    async (isStale: () => boolean = () => false) => {
      /**
       * **後から始めた取得が先に返ることがある。**
       *
       * 作成直後の取り直し（`invalidateSiteList`）は初回の取得が飛行中でも始まるので、
       * 遅れて届いた**古い応答が新しい一覧を上書き**し得る（作った拠点が消えて見える）。
       * この repo が #535 / #541 で P1 を出したのと同じ形なので、同じ守り方をする —
       * 自分より新しい取得が始まっていたら、その応答は捨てる。
       */
      const mine = ++latestRequest.current;
      const superseded = () => isStale() || latestRequest.current !== mine;

      // **失敗から再試行したときだけ** loading へ戻す。押しても何も変わらないと
      // 「再試行が効かない」に見えるため。すでに一覧を出せているとき（`ready`）に
      // 戻すと、作成のたびに一覧が「読み込み中」へ点滅する。
      if (!superseded()) setStatus((prev) => (prev === 'error' ? 'loading' : prev));
      let res: Response;
      try {
        res = await fetchSiteList(tenantId);
      } catch {
        // オフライン・DNS 失敗・締切。**空一覧にしない** — 「拠点が 1 つも無い」と区別が付かない。
        if (!superseded()) setStatus('error');
        return;
      }
      if (superseded()) return;
      if (!res.ok) {
        setStatus('error');
        return;
      }
      /**
       * **本文の解釈失敗も `error` に落とす** (#554 レビュー M8)。
       *
       * ここを `try` の外に置くと、`res.json()` が投げた瞬間 `fetchSites` が reject し、
       * `status` は `loading` のまま固まる（＝締切で塞いだはずの永久 loading へ別経路で
       * 戻る）。認証切れの HTML が 200 で返る構成では実際に起こり得る。
       * 配列であることも確認する — 型アサーションだけだと、描画中に `sites.some` が投げる。
       */
      let list: unknown;
      try {
        list = await res.json();
      } catch {
        if (!superseded()) setStatus('error');
        return;
      }
      if (superseded()) return;
      if (!Array.isArray(list)) {
        setStatus('error');
        return;
      }
      setSites(list as SiteWithDevices[]);
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
    const isStale = () => cancelled;
    // 他のインスタンスが起こした取り直しにも追随する（ヘッダだけ古いまま、を作らない）。
    const unsubscribe = subscribeSiteList(tenantId, () => fetchSites(isStale));
    void fetchSites(isStale);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [fetchSites, enabled, tenantId]);

  const reload = useCallback(() => invalidateSiteList(tenantId), [tenantId]);

  return { sites, status, reload };
}
