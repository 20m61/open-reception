/**
 * kiosk 待機画面の営業状態クライアント側定期再取得コア (issue #367 残)。
 *
 * 背景: `/kiosk` はサーバ側 (`resolveKioskStatusFor`) で営業状態を評価し `KioskFlow` の
 * `operatingStatus` prop へ渡すが、これは force-dynamic のリロード時のみ。長時間開きっぱなしの
 * 待機画面は営業中→時間外（またはその逆）に自動で切り替わらない。本モジュールは
 * `/api/kiosk/config`（`operatingStatus` を応答済み）を一定間隔でポーリングし、最新の
 * 営業状態を通知する純コントローラを提供する。
 *
 * React 非依存に保つ（DOM レンダラ無しで単体テストできる）: タイマー・fetch・可視性は
 * すべて注入可能にし、React フック側（`use-operating-status.ts`）で実物を配線する。
 *
 * fail-open 原則: 取得失敗・HTTP エラー・不正応答は「最後に取得できた値を保持」する
 * （onStatus を呼ばない）。閉店化しない。連続失敗でもインターバルは回り続けリトライする。
 * `operatingStatus: null`（ポリシー未設定・サーバ側 fail-open）は正当な「判定不能」応答として
 * undefined を通知する（`operatingStateOf` が通常受付に倒す）。
 */
import type { KioskOperatingStatus, OperatingState } from '@/domain/kiosk/operating-status';

/** ポーリング間隔（ms）。iPad 待機端末の無駄リクエストを避けつつ営業状態切替を反映できる粒度。 */
export const OPERATING_STATUS_POLL_INTERVAL_MS = 60_000;

/**
 * 既定のポーリング先。`/api/kiosk/config` は `operatingStatus` を応答済み（kioskId 省略時は
 * 既定スコープへフォールバック = `/kiosk` ページのサーバ評価と同じ tenant/site を見る）。
 */
export const DEFAULT_OPERATING_STATUS_ENDPOINT = '/api/kiosk/config';

const OPERATING_STATES: ReadonlySet<string> = new Set<OperatingState>(['open', 'closed']);

export type ParsedOperatingStatus =
  | { ok: true; status: KioskOperatingStatus | undefined }
  | { ok: false };

/**
 * `/api/kiosk/config` 応答から `operatingStatus` を検証して取り出す。
 *
 * - フィールド欠落・非オブジェクト・不正な state → `ok: false`（呼び出し側は直前値を保持）。
 * - `null`/`undefined` → `ok: true, status: undefined`（判定不能 = fail-open）。
 * - 妥当な `{ state, reopenAt?, emergencyContactLabel? }` → 型に写して返す（余剰フィールドは捨てる）。
 */
export function parseOperatingStatusPayload(payload: unknown): ParsedOperatingStatus {
  if (typeof payload !== 'object' || payload === null || !('operatingStatus' in payload)) {
    return { ok: false };
  }
  const raw = (payload as { operatingStatus: unknown }).operatingStatus;
  if (raw === null || raw === undefined) return { ok: true, status: undefined };
  if (typeof raw !== 'object') return { ok: false };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.state !== 'string' || !OPERATING_STATES.has(obj.state)) return { ok: false };
  const status: KioskOperatingStatus = { state: obj.state as OperatingState };
  if (typeof obj.reopenAt === 'string') status.reopenAt = obj.reopenAt;
  if (typeof obj.emergencyContactLabel === 'string') {
    status.emergencyContactLabel = obj.emergencyContactLabel;
  }
  return { ok: true, status };
}

/** 営業状態の等価判定。無変化時の再レンダー抑止に使う。 */
export function sameOperatingStatus(a?: KioskOperatingStatus, b?: KioskOperatingStatus): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.state === b.state &&
    a.reopenAt === b.reopenAt &&
    a.emergencyContactLabel === b.emergencyContactLabel
  );
}

export interface OperatingStatusPollerDeps {
  /** 新しい営業状態の通知先。失敗・不正応答時は呼ばれない（直前値保持）。 */
  onStatus: (status: KioskOperatingStatus | undefined) => void;
  /** 画面非表示なら true（例: `() => document.hidden`）。true の間は fetch しない。 */
  isHidden: () => boolean;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  intervalMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface OperatingStatusPoller {
  /** インターバルを開始する（冪等）。マウント直後は SSR 値を維持し即時 fetch はしない。 */
  start(): void;
  /** インターバル解除 + 進行中 fetch の abort。 */
  stop(): void;
  /** 1 回ポーリングする。hidden 中は何もしない。例外は投げない（fail-open）。 */
  poll(): Promise<void>;
}

export function createOperatingStatusPoller(deps: OperatingStatusPollerDeps): OperatingStatusPoller {
  const endpoint = deps.endpoint ?? DEFAULT_OPERATING_STATUS_ENDPOINT;
  const intervalMs = deps.intervalMs ?? OPERATING_STATUS_POLL_INTERVAL_MS;
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const setIntervalImpl =
    deps.setIntervalImpl ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearIntervalImpl =
    deps.clearIntervalImpl ?? ((handle: ReturnType<typeof setInterval>) => clearInterval(handle));

  let handle: ReturnType<typeof setInterval> | null = null;
  let controller: AbortController | null = null;

  async function poll(): Promise<void> {
    if (deps.isHidden()) return;
    // 可視性トグル連打などで前回 fetch が残っていれば畳む（オーバーラップ防止・orphan なし）。
    controller?.abort();
    const local = new AbortController();
    controller = local;
    try {
      const res = await fetchImpl(endpoint, { cache: 'no-store', signal: local.signal });
      if (!res.ok) return;
      const payload = await res.json();
      const parsed = parseOperatingStatusPayload(payload);
      if (parsed.ok) deps.onStatus(parsed.status);
    } catch {
      // fail-open: 取得失敗・abort・JSON パース失敗は直前値を保持（onStatus を呼ばない）。
    } finally {
      if (controller === local) controller = null;
    }
  }

  return {
    start() {
      if (handle !== null) return;
      handle = setIntervalImpl(() => {
        void poll();
      }, intervalMs);
    },
    stop() {
      if (handle !== null) {
        clearIntervalImpl(handle);
        handle = null;
      }
      controller?.abort();
      controller = null;
    },
    poll,
  };
}
