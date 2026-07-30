/**
 * 対象コンテキストの優先順位 (issue #423「URL、cookie、server resolved context の優先順位を定義」)。
 *
 * 現状の実害: platform のヘッダは Cookie の選択（sticky）を出すが、
 * `/platform/tenants/[tenantId]` の本文は URL のテナントを出す。両者は食い違い得るので、
 * **ヘッダが本文と別のテナント（あるいは「全テナント横断」）を示す**ことがある。
 * #423 の受入条件「主要画面で現在の tenant が常に確認できる」「画面移動によって対象が暗黙に
 * 別テナントへ切り替わらない」の両方に関わる。
 *
 * 設計原則:
 *  - 副作用なし（I/O・cookie・DOM 非依存）。**入力を書き換えない**。
 *  - PII を扱わない（id のみ）。
 *
 * ## 3 つの層と、その扱い
 *
 * | 層 | 誰が決めるか | 扱い |
 * | --- | --- | --- |
 * | route（URL） | 来訪者/運用者が打てる | **権威ではない**。ただし「この画面が何についてか」の最も具体的な意思 |
 * | sticky（Cookie） | 明示操作（切替 UI）で更新 | 権威ではない。route が無いときの既定スコープ |
 * | authorized（server resolved） | サーバが actor から導出 | **これだけが権威**。route/sticky を濾す |
 *
 * `route > sticky > none`。ただし**どちらも authorized で濾してから**採用する。
 * #419 の教訓「クライアントが送る識別子は権威にしない（サーバがセッションから解決する）」を、
 * 判定の形として表現したもの（`kiosk-dev` 固定値が全端末の設定を読ませていた事故と同じ根）。
 *
 * ## route が sticky を書き換えないこと
 *
 * この関数は純粋なので副作用が無いこと自体が担保になる。テナント詳細を開いただけで選択中が
 * 変わると、一覧へ戻ったときに別テナントが対象になっている——それが #423 が禁じる「暗黙の
 * 切り替わり」。代わりに `differsFromSticky` を返し、**UI が食い違いを明示できる**ようにする。
 * 黙って解決すると運用者は「いま何を見ているのか」を誤解する。
 *
 * ## 対象は今はテナントだけ
 *
 * #423 の共通コンテキストバーは `Platform > Tenant > Site > Kiosk > Version` を求めるが、
 * まずテナントで優先順位を確定させる。Site / Kiosk / Version も同じ形（route > sticky、
 * 権威で濾す）へ揃える前提で、増分を分ける。
 */

/** 採用元。優先順位はこの順。 */
export const CONTEXT_SOURCES = ['route', 'sticky', 'none'] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

export type ContextScopeInput = {
  /** URL が名指しするテナント（動的セグメント等）。クライアント由来なので権威ではない。 */
  routeTenantId?: string | null;
  /** Cookie が保持する「選択中」。同じくクライアント由来。 */
  stickyTenantId?: string | null;
  /** サーバが actor から導出した許可集合。**唯一の権威**。 */
  authorizedTenantIds: readonly string[];
};

export type ContextScope = {
  /** その画面が対象とするテナント。`null` は対象なし（全テナント横断）。 */
  tenantId: string | null;
  source: ContextSource;
  /**
   * route が sticky と食い違っているか。UI はこれを見て「選択中とは別のテナントを見ている」
   * ことを明示する（黙って解決しない）。
   */
  differsFromSticky: boolean;
  /**
   * 権威の集合に無いため採用しなかった値。表示・監査のために残す
   * （越境の試行を黙って捨てると、運用者にも監査にも何も残らない）。
   */
  rejected: readonly string[];
};

/** 未指定（空文字・null・undefined）を `null` へ正規化する。 */
function normalize(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/**
 * route / sticky / authorized から、その画面の対象コンテキストを解決する。
 *
 * 採用しなかった値（権威の集合外）は `rejected` に順序どおり残す（route → sticky）。
 */
export function resolveContextScope(input: ContextScopeInput): ContextScope {
  const authorized = new Set(input.authorizedTenantIds);
  const route = normalize(input.routeTenantId);
  const sticky = normalize(input.stickyTenantId);

  const rejected: string[] = [];
  const accept = (value: string | null): string | null => {
    if (value === null) return null;
    if (authorized.has(value)) return value;
    rejected.push(value);
    return null;
  };

  // 順序が rejected の順序も決めるので、route を先に評価する。
  const acceptedRoute = accept(route);
  const acceptedSticky = accept(sticky);

  const tenantId = acceptedRoute ?? acceptedSticky;
  const source: ContextSource =
    acceptedRoute !== null ? 'route' : acceptedSticky !== null ? 'sticky' : 'none';

  return {
    tenantId,
    source,
    // 食い違いは「採用した route が sticky と違う」ときだけ。sticky が無い場合は
    // 食い違いではない（まだ何も選んでいないだけ）。
    differsFromSticky: acceptedRoute !== null && sticky !== null && acceptedRoute !== sticky,
    rejected,
  };
}
