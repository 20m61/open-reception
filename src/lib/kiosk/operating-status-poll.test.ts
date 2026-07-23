import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KioskOperatingStatus } from '@/domain/kiosk/operating-status';
import {
  createOperatingStatusPoller,
  parseOperatingStatusPayload,
  sameOperatingStatus,
  DEFAULT_OPERATING_STATUS_ENDPOINT,
  OPERATING_STATUS_POLL_INTERVAL_MS,
} from './operating-status-poll';

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe('parseOperatingStatusPayload (#367)', () => {
  it('closed オブジェクトを検証して写す（reopenAt/label も保持）', () => {
    const parsed = parseOperatingStatusPayload({
      operatingStatus: {
        state: 'closed',
        reopenAt: '2026-07-24T00:00:00.000Z',
        emergencyContactLabel: '警備室内線',
      },
    });
    expect(parsed).toEqual({
      ok: true,
      status: {
        state: 'closed',
        reopenAt: '2026-07-24T00:00:00.000Z',
        emergencyContactLabel: '警備室内線',
      },
    });
  });

  it('open の最小オブジェクト', () => {
    expect(parseOperatingStatusPayload({ operatingStatus: { state: 'open' } })).toEqual({
      ok: true,
      status: { state: 'open' },
    });
  });

  it('operatingStatus:null は「判定不能」= status undefined（fail-open）', () => {
    expect(parseOperatingStatusPayload({ operatingStatus: null })).toEqual({
      ok: true,
      status: undefined,
    });
  });

  it('operatingStatus フィールド欠落は不正応答（ok:false）', () => {
    expect(parseOperatingStatusPayload({ active: true })).toEqual({ ok: false });
  });

  it('state が不正値なら ok:false（直前値を保持させる）', () => {
    expect(parseOperatingStatusPayload({ operatingStatus: { state: 'maybe' } })).toEqual({
      ok: false,
    });
  });

  it('非オブジェクト payload は ok:false', () => {
    expect(parseOperatingStatusPayload('nope')).toEqual({ ok: false });
    expect(parseOperatingStatusPayload(null)).toEqual({ ok: false });
  });
});

describe('sameOperatingStatus (#367)', () => {
  it('同値は true・差分は false', () => {
    expect(sameOperatingStatus(undefined, undefined)).toBe(true);
    expect(sameOperatingStatus({ state: 'open' }, { state: 'open' })).toBe(true);
    expect(sameOperatingStatus({ state: 'open' }, { state: 'closed' })).toBe(false);
    expect(sameOperatingStatus(undefined, { state: 'closed' })).toBe(false);
    expect(
      sameOperatingStatus(
        { state: 'closed', reopenAt: 'a' },
        { state: 'closed', reopenAt: 'b' },
      ),
    ).toBe(false);
  });
});

describe('createOperatingStatusPoller.poll (#367)', () => {
  it('closed に変わると onStatus へ新しい operatingStatus が渡る', async () => {
    const onStatus = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ operatingStatus: { state: 'closed', reopenAt: '2026-07-24T00:00:00.000Z' } }),
    );
    const poller = createOperatingStatusPoller({
      onStatus,
      isHidden: () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await poller.poll();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      DEFAULT_OPERATING_STATUS_ENDPOINT,
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(onStatus).toHaveBeenCalledWith({
      state: 'closed',
      reopenAt: '2026-07-24T00:00:00.000Z',
    });
  });

  it('hidden 中は fetch が発生しない', async () => {
    const onStatus = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ operatingStatus: { state: 'closed' } }));
    const poller = createOperatingStatusPoller({
      onStatus,
      isHidden: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await poller.poll();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('取得失敗（reject）は例外を投げず直前値を保持（onStatus 未呼び出し）', async () => {
    const onStatus = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const poller = createOperatingStatusPoller({
      onStatus,
      isHidden: () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(poller.poll()).resolves.toBeUndefined();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('HTTP 非 2xx は直前値を保持（onStatus 未呼び出し）', async () => {
    const onStatus = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({}, false));
    const poller = createOperatingStatusPoller({
      onStatus,
      isHidden: () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await poller.poll();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('不正応答（operatingStatus 欠落）は直前値を保持', async () => {
    const onStatus = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ active: true }));
    const poller = createOperatingStatusPoller({
      onStatus,
      isHidden: () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await poller.poll();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('operatingStatus:null は fail-open として undefined を通知', async () => {
    const onStatus = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ operatingStatus: null }));
    const poller = createOperatingStatusPoller({
      onStatus,
      isHidden: () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await poller.poll();
    expect(onStatus).toHaveBeenCalledWith(undefined);
  });
});

describe('createOperatingStatusPoller start/stop cleanup (#367)', () => {
  it('start は既定間隔でインターバルを張り、tick が poll を駆動する', async () => {
    const onStatus = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ operatingStatus: { state: 'open' } }));
    let tick: (() => void) | undefined;
    const setIntervalImpl = vi.fn((cb: () => void, ms: number) => {
      expect(ms).toBe(OPERATING_STATUS_POLL_INTERVAL_MS);
      tick = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalImpl = vi.fn();
    const poller = createOperatingStatusPoller({
      onStatus,
      isHidden: () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setIntervalImpl,
      clearIntervalImpl,
    });
    poller.start();
    expect(setIntervalImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled(); // マウント直後は SSR 値を維持（即時 fetch しない）
    tick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stop はインターバルを解除し、進行中の fetch を abort する', async () => {
    const onStatus = vi.fn();
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>(() => {
          capturedSignal = init?.signal;
        }),
    );
    const clearIntervalImpl = vi.fn();
    const poller = createOperatingStatusPoller({
      onStatus,
      isHidden: () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setIntervalImpl: () => 7 as unknown as ReturnType<typeof setInterval>,
      clearIntervalImpl,
    });
    poller.start();
    void poller.poll();
    await Promise.resolve();
    expect(capturedSignal?.aborted).toBe(false);
    poller.stop();
    expect(clearIntervalImpl).toHaveBeenCalledWith(7);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('start は多重呼び出しでも 1 本だけ張る（冪等）', () => {
    const setIntervalImpl = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
    const poller = createOperatingStatusPoller({
      onStatus: vi.fn(),
      isHidden: () => false,
      fetchImpl: (async () => jsonResponse({ operatingStatus: null })) as unknown as typeof fetch,
      setIntervalImpl,
      clearIntervalImpl: vi.fn(),
    });
    poller.start();
    poller.start();
    expect(setIntervalImpl).toHaveBeenCalledTimes(1);
  });
});

// 型のみ利用の import が未使用にならないための最小参照。
const _typecheck: KioskOperatingStatus = { state: 'open' };
void _typecheck;
