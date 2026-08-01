import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SITE_LIST_TIMEOUT_MS,
  fetchSiteList,
  invalidateSiteList,
  subscribeSiteList,
} from './use-site-list';

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
  vi.useRealTimers();
});

/** 呼び出し側が渡した `signal` でのみ失敗する、それ以外は永久に返らない fetch。 */
function neverResolvingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    })) as unknown as typeof fetch;
}

describe('fetchSiteList', () => {
  it('同時に呼ばれた 2 つは 1 本の要求を共有する', async () => {
    const spy = vi.fn(async () => jsonResponse([{ id: 'default-site' }]));
    globalThis.fetch = spy as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      fetchSiteList('internal'),
      fetchSiteList('internal'),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    // **両方が body を読めること**（clone を返していないと片方が落ちる）。
    await expect(a.json()).resolves.toEqual([{ id: 'default-site' }]);
    await expect(b.json()).resolves.toEqual([{ id: 'default-site' }]);
  });

  it('テナントが違えば相乗りしない', async () => {
    const spy = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = spy as unknown as typeof fetch;

    await Promise.all([fetchSiteList('a'), fetchSiteList('b')]);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('相乗り側も失敗ステータスを失敗として読む（成功と誤認しない）', async () => {
    globalThis.fetch = (async () => jsonResponse({ error: 'forbidden' }, 403)) as typeof fetch;

    const [a, b] = await Promise.all([
      fetchSiteList('internal'),
      fetchSiteList('internal'),
    ]);

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(b.status).toBe(403);
  });

  it('完了後は相乗りしない（古い一覧を配らない）', async () => {
    const spy = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = spy as unknown as typeof fetch;

    await fetchSiteList('internal');
    await fetchSiteList('internal');

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('invalidate 後は飛行中の要求に相乗りしない', async () => {
    // 作成・改名の直後に相乗りすると、**変更前に飛んだ要求の応答**を掴む。
    let resolveFirst: (r: Response) => void = () => {};
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const spy = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(jsonResponse([]));
    globalThis.fetch = spy as unknown as typeof fetch;

    const pending = fetchSiteList('invalidate-inflight');
    await invalidateSiteList('invalidate-inflight');
    await fetchSiteList('invalidate-inflight');
    expect(spy).toHaveBeenCalledTimes(2);

    resolveFirst(jsonResponse([]));
    await pending;
  });

  /**
   * **永久 loading を作らない** (#554 レビュー N8)。
   *
   * `useSiteList` は `status` を `loading` のまま持ち続け、`resolveSiteScopeState` は
   * `ready:false` を返し続けるので、本文は 1 本も取得を始められない。応答が**返らない**
   * ときだけ、失敗（`error`）にすら遷移できず**画面ごと復帰不能**になる。
   */
  describe('timeout', () => {
    // テナント id を検査ごとに変えるのは、**module-level の `inFlight` が検査をまたいで
    // 共有される**ため。打ち切れない要求を同じ id で残すと、後続の検査がその死んだ
    // promise に相乗りして道連れになる（実装前の red で実際にそうなった）。
    it('応答が返らないままなら既定の timeout で打ち切る', async () => {
      vi.useFakeTimers();
      globalThis.fetch = neverResolvingFetch();

      const pending = fetchSiteList('timeout-single');
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(SITE_LIST_TIMEOUT_MS);
      await assertion;
    });

    it('相乗り側も打ち切りを失敗として受け取る（片方だけ復帰不能にしない）', async () => {
      vi.useFakeTimers();
      globalThis.fetch = neverResolvingFetch();

      const first = fetchSiteList('timeout-shared');
      const rider = fetchSiteList('timeout-shared');
      const assertions = Promise.all([
        expect(first).rejects.toThrow(),
        expect(rider).rejects.toThrow(),
      ]);
      await vi.advanceTimersByTimeAsync(SITE_LIST_TIMEOUT_MS);
      await assertions;
    });

    it('打ち切ったあとの再試行は新しい要求を投げる', async () => {
      vi.useFakeTimers();
      const spy = vi.fn(neverResolvingFetch());
      globalThis.fetch = spy as unknown as typeof fetch;

      const pending = fetchSiteList('timeout-retry');
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(SITE_LIST_TIMEOUT_MS);
      await assertion;

      // 飛行中の記録が残っていると、再試行が**打ち切り済みの promise** を掴んで即失敗する
      // （＝再試行ボタンが永久に効かない）。
      globalThis.fetch = (async () => jsonResponse([{ id: 'default-site' }])) as typeof fetch;
      await expect(fetchSiteList('timeout-retry')).resolves.toMatchObject({ ok: true });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('成功したら timer を残さない（未処理の timer で終われないテスト環境を作らない）', async () => {
      vi.useFakeTimers();
      globalThis.fetch = (async () => jsonResponse([])) as typeof fetch;

      await fetchSiteList('internal');

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('失敗しても飛行中の記録が残らない（次の要求が死んだ promise を掴まない）', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(fetchSiteList('internal')).rejects.toThrow();

    // 記録が残っていると、この 2 回目が**前回の失敗をそのまま**返す。
    globalThis.fetch = (async () => jsonResponse([{ id: 'default-site' }])) as typeof fetch;
    await expect(fetchSiteList('internal')).resolves.toMatchObject({ ok: true });
  });
});

/**
 * **同じテナントの一覧を持つ全インスタンスを一緒に取り直す** (#554 M3)。
 *
 * ヘッダの対象拠点チップと本文のマネージャは別インスタンスのフックで、状態も別々に持つ。
 * 初回は in-flight 相乗りで同じ結果になるが、**本文の「再試行」や拠点の作成は自分の
 * 状態しか更新しない**。結果、再試行が成功しても**ヘッダは「確認できません」のまま**
 * （＝直したのに直っていないように見える）、拠点を作ってもヘッダの選択肢に出てこない。
 *
 * 本リポジトリが繰り返している「ある画面で解いた対策を兄弟へ写していない」形なので、
 * 画面ごとに書かせず、購読の形で 1 箇所に持つ。
 */
describe('subscribeSiteList / invalidateSiteList', () => {
  it('同じテナントの全インスタンスが取り直す', async () => {
    globalThis.fetch = (async () => jsonResponse([])) as typeof fetch;
    const header = vi.fn(async () => {});
    const body = vi.fn(async () => {});
    subscribeSiteList('multi', header);
    subscribeSiteList('multi', body);

    await invalidateSiteList('multi');

    expect(header).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('全インスタンスの取り直しが終わるまで待てる', async () => {
    let applied = false;
    subscribeSiteList('await', async () => {
      await Promise.resolve();
      applied = true;
    });

    await invalidateSiteList('await');

    // ここで false だと、作成直後の `await reload()` が**反映前に**返る。
    expect(applied).toBe(true);
  });

  it('解除したインスタンスは呼ばれない（アンマウント後に setState しない）', async () => {
    const gone = vi.fn(async () => {});
    const unsubscribe = subscribeSiteList('unsub', gone);
    unsubscribe();

    await invalidateSiteList('unsub');

    expect(gone).not.toHaveBeenCalled();
  });

  it('別テナントの購読は呼ばない', async () => {
    const other = vi.fn(async () => {});
    subscribeSiteList('tenant-a', other);

    await invalidateSiteList('tenant-b');

    expect(other).not.toHaveBeenCalled();
  });

  it('1 つが失敗しても他のインスタンスは取り直す', async () => {
    // ヘッダの取り直しが投げたせいで本文が更新されない、を作らない。
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    const healthy = vi.fn(async () => {});
    subscribeSiteList('partial', failing);
    subscribeSiteList('partial', healthy);

    await expect(invalidateSiteList('partial')).resolves.toBeUndefined();

    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
