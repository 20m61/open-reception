/**
 * クライアント側 通話ライフサイクル制御 (issue #4 increment 2b)。
 *
 * フレームワーク非依存。受付端末 UI（KioskFlow）や担当者 UI から使う。
 *   1) token API からトークン取得（未確立/無効なら fallback）
 *   2) CallClient（Vonage 等）で接続。応答で connected を確定（/connected へ報告）
 *   3) timeout までに未接続なら timeout を確定（/timeout へ報告）
 *   4) 接続失敗時は UI を fallback に降格（受付フローは止めない）
 *
 * 実 SDK 接続は CallClient 実装に隔離する（dynamic import + フォールバック）。本制御は
 * fetch/タイマー/状態遷移のみを担い、単体テスト可能（CallClient はテストで fake を注入）。
 */

export type CallTokenResponse = {
  applicationId: string;
  sessionId: string;
  token: string;
  role: string;
  expiresAt: string;
};

/** 実 SDK（Vonage client）への接続境界。2c で具体実装を差し込む。 */
export interface CallClient {
  connect(opts: {
    applicationId: string;
    sessionId: string;
    token: string;
    /** 通話相手（担当者）が参加し、メディアが確立したとき。 */
    onConnected: () => void;
    /** SDK 側の接続エラー。 */
    onError: (err: unknown) => void;
  }): Promise<void>;
  disconnect(): Promise<void>;
}

/** UI が表示に使う状態。 */
export type CallUiState = 'connecting' | 'connected' | 'timeout' | 'fallback';

export type CallControllerDeps = {
  /** GET /token。未確立/無効（409 等）なら null。 */
  fetchToken: () => Promise<CallTokenResponse | null>;
  /** POST /connected。 */
  reportConnected: () => Promise<void>;
  /** POST /timeout。 */
  reportTimeout: () => Promise<void>;
  client: CallClient;
  /** 応答待ちの上限（ミリ秒）。 */
  timeoutMs: number;
  /** UI への状態通知。 */
  onState: (state: CallUiState) => void;
};

export type CallController = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createCallController(deps: CallControllerDeps): CallController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let stopped = false;

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  async function start(): Promise<void> {
    deps.onState('connecting');
    const token = await deps.fetchToken();
    if (!token || stopped) {
      if (!stopped) deps.onState('fallback');
      return;
    }

    // 応答待ちのタイムアウト。未接続のまま満了したら timeout を確定する。
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void deps.client.disconnect().catch(() => {});
      void deps.reportTimeout().catch(() => {});
      deps.onState('timeout');
    }, deps.timeoutMs);

    try {
      await deps.client.connect({
        applicationId: token.applicationId,
        sessionId: token.sessionId,
        token: token.token,
        onConnected: () => {
          if (settled) return;
          settled = true;
          clear();
          void deps.reportConnected().catch(() => {});
          deps.onState('connected');
        },
        // SDK エラーは UI を fallback に降格。タイマーは継続し、未応答なら timeout を確定する。
        onError: () => {
          if (!settled) deps.onState('fallback');
        },
      });
    } catch {
      if (!settled) deps.onState('fallback');
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    settled = true;
    clear();
    await deps.client.disconnect().catch(() => {});
  }

  return { start, stop };
}
