import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSiteList } from './use-site-list';

/**
 * 拠点一覧取得の **in-flight 相乗り** (issue #423 / PR #552 レビュー)。
 *
 * ヘッダの対象拠点チップと本文のマネージャは別インスタンスのフックなので、素朴に書くと
 * 1 画面あたり同じ GET が 2 本飛ぶ。飛行中のものに相乗りして 1 本にするが、これは
 * module-level のミュータブルな状態 + `Response.clone()` という**壊れやすい追加**なので、
 * 振る舞いをここで固定する。
 */

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchSiteList', () => {
  it('同時に呼ばれた 2 つは 1 本の要求を共有する', async () => {
    const spy = vi.fn(async () => jsonResponse([{ id: 'default-site' }]));
    globalThis.fetch = spy as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      fetchSiteList('internal', false),
      fetchSiteList('internal', false),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    // **両方が body を読めること**（clone を返していないと片方が落ちる）。
    await expect(a.json()).resolves.toEqual([{ id: 'default-site' }]);
    await expect(b.json()).resolves.toEqual([{ id: 'default-site' }]);
  });

  it('テナントが違えば相乗りしない', async () => {
    const spy = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = spy as unknown as typeof fetch;

    await Promise.all([fetchSiteList('a', false), fetchSiteList('b', false)]);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('相乗り側も失敗ステータスを失敗として読む（成功と誤認しない）', async () => {
    globalThis.fetch = (async () => jsonResponse({ error: 'forbidden' }, 403)) as typeof fetch;

    const [a, b] = await Promise.all([
      fetchSiteList('internal', false),
      fetchSiteList('internal', false),
    ]);

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(b.status).toBe(403);
  });

  it('完了後は相乗りしない（古い一覧を配らない）', async () => {
    const spy = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = spy as unknown as typeof fetch;

    await fetchSiteList('internal', false);
    await fetchSiteList('internal', false);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reload（fresh）は飛行中の要求に相乗りしない', async () => {
    // 作成・改名の直後に相乗りすると、**変更前に飛んだ要求の応答**を掴む。
    let resolveFirst: (r: Response) => void = () => {};
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const spy = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(jsonResponse([]));
    globalThis.fetch = spy as unknown as typeof fetch;

    const pending = fetchSiteList('internal', false);
    await fetchSiteList('internal', true);
    expect(spy).toHaveBeenCalledTimes(2);

    resolveFirst(jsonResponse([]));
    await pending;
  });

  it('失敗しても飛行中の記録が残らない（次の要求が死んだ promise を掴まない）', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(fetchSiteList('internal', false)).rejects.toThrow();

    // 記録が残っていると、この 2 回目が**前回の失敗をそのまま**返す。
    globalThis.fetch = (async () => jsonResponse([{ id: 'default-site' }])) as typeof fetch;
    await expect(fetchSiteList('internal', false)).resolves.toMatchObject({ ok: true });
  });
});
