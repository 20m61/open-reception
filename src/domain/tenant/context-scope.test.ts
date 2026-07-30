import { describe, expect, it } from 'vitest';
import { CONTEXT_SOURCES, resolveContextScope } from './context-scope';

/**
 * 対象コンテキストの優先順位 (#423「URL、cookie、server resolved context の優先順位を定義」)。
 *
 * 現状の実害: platform のヘッダは Cookie の選択（sticky）を出すが、`/platform/tenants/[tenantId]`
 * の本文は URL のテナントを出す。両者は食い違い得るので、**ヘッダが本文と別のテナントを
 * 示す**ことがある（#423 AC「主要画面で現在の tenant が常に確認できる」に反する）。
 */

const AUTHORIZED = ['t1', 't2'] as const;

describe('resolveContextScope: URL / cookie / server resolved の優先順位 (#423)', () => {
  it('URL が名指ししたテナントが sticky より優先する（画面と表示を一致させる）', () => {
    const scope = resolveContextScope({
      routeTenantId: 't1',
      stickyTenantId: 't2',
      authorizedTenantIds: AUTHORIZED,
    });
    expect(scope.tenantId).toBe('t1');
    expect(scope.source).toBe('route');
  });

  it('URL と sticky の食い違いを呼び出し側へ伝える（UI が明示できるように）', () => {
    // ここを黙って解決すると、運用者は「いま何を見ているのか」を誤解する。
    const scope = resolveContextScope({
      routeTenantId: 't1',
      stickyTenantId: 't2',
      authorizedTenantIds: AUTHORIZED,
    });
    expect(scope.differsFromSticky).toBe(true);
  });

  it('一致していれば食い違いフラグは立たない', () => {
    const scope = resolveContextScope({
      routeTenantId: 't1',
      stickyTenantId: 't1',
      authorizedTenantIds: AUTHORIZED,
    });
    expect(scope.differsFromSticky).toBe(false);
  });

  it('URL が無ければ sticky を使う', () => {
    const scope = resolveContextScope({ stickyTenantId: 't2', authorizedTenantIds: AUTHORIZED });
    expect(scope.tenantId).toBe('t2');
    expect(scope.source).toBe('sticky');
    expect(scope.differsFromSticky).toBe(false);
  });

  it('どちらも無ければ対象なし（全テナント横断）', () => {
    const scope = resolveContextScope({ authorizedTenantIds: AUTHORIZED });
    expect(scope.tenantId).toBeNull();
    expect(scope.source).toBe('none');
  });

  it('**権威は authorizedTenantIds だけ。** 集合外の URL は採用せず落とす', () => {
    // #419 の教訓「クライアントが送る識別子は権威にしない」。URL は誰でも打てる。
    const scope = resolveContextScope({
      routeTenantId: 'other-tenant',
      stickyTenantId: 't2',
      authorizedTenantIds: AUTHORIZED,
    });
    expect(scope.tenantId).toBe('t2');
    expect(scope.source).toBe('sticky');
    expect(scope.rejected).toContain('other-tenant');
  });

  it('集合外の sticky も採用しない（消えた/権限を失ったテナントを選択中に残さない）', () => {
    const scope = resolveContextScope({
      stickyTenantId: 'gone',
      authorizedTenantIds: AUTHORIZED,
    });
    expect(scope.tenantId).toBeNull();
    expect(scope.source).toBe('none');
    expect(scope.rejected).toContain('gone');
  });

  it('両方が集合外なら対象なしへ倒し、両方を落としたものとして残す', () => {
    const scope = resolveContextScope({
      routeTenantId: 'x',
      stickyTenantId: 'y',
      authorizedTenantIds: AUTHORIZED,
    });
    expect(scope.tenantId).toBeNull();
    expect(scope.source).toBe('none');
    expect(scope.rejected).toEqual(['x', 'y']);
  });

  it('権威の集合が空なら何も採用しない（未所属 actor）', () => {
    const scope = resolveContextScope({
      routeTenantId: 't1',
      stickyTenantId: 't2',
      authorizedTenantIds: [],
    });
    expect(scope.tenantId).toBeNull();
    expect(scope.source).toBe('none');
  });

  it('空文字・null・undefined は未指定として扱う', () => {
    for (const empty of ['', null, undefined] as const) {
      const scope = resolveContextScope({
        routeTenantId: empty,
        stickyTenantId: 't2',
        authorizedTenantIds: AUTHORIZED,
      });
      expect(scope.tenantId, String(empty)).toBe('t2');
      // 未指定は「落とした」ではない（rejected に空文字を混ぜない）。
      expect(scope.rejected, String(empty)).toEqual([]);
    }
  });

  it('source の語彙は 3 つだけ（増やすなら優先順位の定義から見直す）', () => {
    expect(CONTEXT_SOURCES).toEqual(['route', 'sticky', 'none']);
  });

  it('同じ入力なら常に同じ結果（純関数・入力を書き換えない）', () => {
    const input = {
      routeTenantId: 't1',
      stickyTenantId: 't2',
      authorizedTenantIds: [...AUTHORIZED],
    };
    const snapshot = JSON.stringify(input);
    const a = resolveContextScope(input);
    const b = resolveContextScope(input);
    expect(a).toEqual(b);
    // sticky を書き換えないこと自体が #423 AC「画面移動で対象が暗黙に切り替わらない」の担保。
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
