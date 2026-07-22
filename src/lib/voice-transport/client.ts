/**
 * `VoiceTransportClient` — 音声 Transport のクライアント側ライフサイクル統合 (issue #369)。
 *
 * `src/domain/voice-transport/` の純ロジック（lifecycle 状態機械・backpressure キュー・
 * レート制限・フォールバック導出）を、実ソケット（`VoiceTransportSocket`）と組み合わせて
 * 駆動する I/O 層。ブラウザでは `WebSocket` を、テストでは mock を注入する
 * （`client.test.ts` 参照）。AudioWorklet 側の実装・Kiosk UI への配線は次 increment
 * （`docs/adr/0001-voice-transport.md` 参照、Kiosk 配線は他トラック占有のためこの増分では
 * 行わない）。
 *
 * 責務の置き場所（重要）:
 *  - **close() が唯一の後片付けの入口**。`registerCloseHook` で積んだ STT/TTS session の
 *    close 処理は `close()` 呼び出し時にのみ、確実に・厳密に 1 回だけ走る（二重 close 安全）。
 *  - `degraded`（再接続を諦めた状態）は「呼び出し側にフォールバックを促すシグナル」であって、
 *    自動的な終了ではない。呼び出し側（Kiosk 配線）がタッチ受付へ切り替えると判断した時点で
 *    明示的に `close()` を呼び、そこで初めて外部 session が閉じる。この分離により、
 *    「まだリトライする可能性がある状態」で早まって STT/TTS session を破棄しない。
 */
import {
  transition,
  nextReconnectDelayMs,
  type ReconnectBackoffConfig,
  type VoiceTransportLifecycleState,
} from '@/domain/voice-transport/lifecycle';
import {
  emptyQueueState,
  enqueueChunk,
  dequeueChunk,
  type VoiceTransportQueueLimits,
  type VoiceTransportQueueState,
  type VoiceTransportQueuedChunk,
} from '@/domain/voice-transport/queue';
import {
  createRateLimiterState,
  tryConsume,
  type VoiceTransportRateLimiterConfig,
  type VoiceTransportRateLimiterState,
} from '@/domain/voice-transport/rate-limit';
import { fallbackEventForLifecycle, type VoiceTransportFallbackEvent } from '@/domain/voice-transport/fallback';
import type { VoiceEvalEvent } from '@/domain/voice/evaluation-events';
import {
  transportConnectedEvent,
  transportStreamOpenEvent,
  transportReconnectingEvent,
  transportDisconnectedEvent,
  transportStatsEvent,
} from '@/domain/voice-transport/eval-bridge';
import type { VoiceTransportSocket, VoiceTransportSocketCloseInfo, VoiceTransportSocketFactory } from './socket';

type ClientQueuedChunk = VoiceTransportQueuedChunk & { bytes: ArrayBuffer };

/** ハートビート用の制御フレーム。1 byte にして音声チャンク（通常もっと大きい）と区別しやすくする。 */
const HEARTBEAT_PING: ArrayBuffer = new Uint8Array([0]).buffer;
/** レート制限で待たされたときの再試行間隔（ms）。 */
const DRAIN_RETRY_MS = 20;

export type VoiceTransportReconnectConfig = {
  backoff: ReconnectBackoffConfig;
  /** これを超えて失敗したら `degraded`（フォールバック要求）に落ちる。 */
  maxAttempts: number;
};

export type VoiceTransportClientConfig = {
  url: string;
  socketFactory: VoiceTransportSocketFactory;
  queueLimits: VoiceTransportQueueLimits;
  rateLimit: VoiceTransportRateLimiterConfig;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  idleTimeoutMs: number;
  reconnect: VoiceTransportReconnectConfig;
};

export type VoiceTransportClientCallbacks = {
  onLifecycleChange?: (state: VoiceTransportLifecycleState) => void;
  onFallback?: (event: VoiceTransportFallbackEvent) => void;
  onEvalEvent?: (event: VoiceEvalEvent) => void;
};

export class VoiceTransportClient {
  private readonly config: VoiceTransportClientConfig;
  private readonly callbacks: VoiceTransportClientCallbacks;
  private readonly startedAtMs: number;

  private lifecycleState: VoiceTransportLifecycleState = 'idle';
  private socket: VoiceTransportSocket | null = null;
  private queueState: VoiceTransportQueueState<ClientQueuedChunk> = emptyQueueState();
  private rateLimiterState: VoiceTransportRateLimiterState;
  private seq = 0;
  private reconnectAttempt = 0;
  private closed = false;
  private dropped = 0;
  private readonly closeHooks: Array<() => void | Promise<void>> = [];

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private drainRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatIntervalTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: VoiceTransportClientConfig, callbacks: VoiceTransportClientCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.startedAtMs = Date.now();
    this.rateLimiterState = createRateLimiterState(config.rateLimit, this.startedAtMs);
  }

  get state(): VoiceTransportLifecycleState {
    return this.lifecycleState;
  }

  get queueDepth(): number {
    return this.queueState.chunks.length;
  }

  get droppedChunkCount(): number {
    return this.dropped;
  }

  /** STT/TTS session など、Transport 終了時に確実に close すべき外部リソースを登録する。 */
  registerCloseHook(hook: () => void | Promise<void>): void {
    this.closeHooks.push(hook);
  }

  /**
   * 接続を開始する。`idle` からは新規接続、`degraded`（再接続を諦めた状態）からは
   * バックオフ回数をリセットして手動リトライする。それ以外の状態では no-op。
   */
  connect(): void {
    if (this.closed) return;
    if (this.lifecycleState === 'idle') {
      this.lifecycleState = transition(this.lifecycleState, { type: 'CONNECT' });
    } else if (this.lifecycleState === 'degraded') {
      this.reconnectAttempt = 0;
      this.lifecycleState = transition(this.lifecycleState, { type: 'RETRY' });
    } else {
      return;
    }
    this.emitLifecycle();
    this.openSocket();
  }

  /** 音声チャンクを送る。未接続/再接続中でも有界キューへ積み、接続中のみ即座に送出する。 */
  sendAudioChunk(bytes: ArrayBuffer): void {
    if (this.closed) return;
    const chunk: ClientQueuedChunk = { seq: this.seq, t: this.tMs(), byteLength: bytes.byteLength, bytes };
    this.seq += 1;

    const result = enqueueChunk(this.queueState, chunk, this.config.queueLimits);
    this.queueState = result.state;
    if (result.outcome !== 'enqueued') {
      this.dropped += 1;
      this.emitEval(transportStatsEvent(this.tMs(), { droppedPackets: this.dropped, jitterMs: 0 }));
    }

    if (this.lifecycleState === 'connected') {
      this.resetIdleTimer();
      this.drainQueue();
    }
  }

  /** 明示的に終了する。冪等 — 二重に呼んでも close hook は 1 回しか走らない。 */
  async close(): Promise<void> {
    await this.terminate({ type: 'CLOSE' });
  }

  // --- 内部 ---

  private tMs(): number {
    return Date.now() - this.startedAtMs;
  }

  private emitLifecycle(): void {
    this.callbacks.onLifecycleChange?.(this.lifecycleState);
  }

  private emitEval(event: VoiceEvalEvent): void {
    this.callbacks.onEvalEvent?.(event);
  }

  private openSocket(): void {
    const socket = this.config.socketFactory(this.config.url);
    this.socket = socket;
    socket.onopen = () => this.handleOpen();
    socket.onclose = (info) => this.handleSocketClose(info);
    socket.onerror = () => this.handleSocketError();
    socket.onmessage = (data) => this.handleMessage(data);
  }

  /** callback だけ外して参照を捨てる（ソケット自身の close は呼ばない — 既に閉じている想定）。 */
  private discardSocket(): void {
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
    }
    this.socket = null;
  }

  /** こちらの都合でソケットを打ち切る（close() を呼んでから捨てる）。 */
  private teardownSocket(): void {
    const current = this.socket;
    this.discardSocket();
    try {
      current?.close();
    } catch {
      // best effort — 既に壊れているソケットの close 失敗は無視する。
    }
  }

  private handleOpen(): void {
    if (this.closed) return;
    this.lifecycleState = transition(this.lifecycleState, { type: 'OPENED' });
    this.reconnectAttempt = 0;
    this.emitLifecycle();
    this.emitEval(transportConnectedEvent(this.tMs()));
    this.emitEval(transportStreamOpenEvent(this.tMs()));
    this.startHeartbeat();
    this.resetIdleTimer();
    this.drainQueue();
  }

  private handleSocketClose(_info: VoiceTransportSocketCloseInfo): void {
    if (this.closed) return; // 既に明示 close 済み — 遅延到着したコールバックは無視する
    this.clearHeartbeatTimers();
    this.clearIdleTimer();
    this.discardSocket();

    const next = transition(this.lifecycleState, { type: 'DISCONNECTED', reason: 'network' });
    this.lifecycleState = next;
    this.emitLifecycle();
    this.emitEval(transportDisconnectedEvent(this.tMs(), 'network'));
    if (next === 'reconnecting') this.scheduleReconnect();
  }

  private handleSocketError(): void {
    // MVP: エラーは切断として扱う（実ソケットは通常 error の後 close も発火するため、
    // 二重処理は handleSocketClose 側の `closed` ガードと discardSocket で吸収する）。
  }

  private handleMessage(_data: unknown): void {
    // 生存確認としてどんな受信も heartbeat ack とみなす（プロトコル細部は実 WSS 実装で確定、#65）。
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= this.config.reconnect.maxAttempts) {
      this.lifecycleState = transition(this.lifecycleState, { type: 'GIVE_UP' });
      this.emitLifecycle();
      const fallback = fallbackEventForLifecycle(this.lifecycleState, this.tMs());
      if (fallback) this.callbacks.onFallback?.(fallback);
      return;
    }
    const delay = nextReconnectDelayMs(this.reconnectAttempt, this.config.reconnect.backoff);
    this.emitEval(transportReconnectingEvent(this.tMs(), this.reconnectAttempt + 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt += 1;
      this.lifecycleState = transition(this.lifecycleState, { type: 'RETRY' });
      this.emitLifecycle();
      this.openSocket();
    }, delay);
  }

  private drainQueue(): void {
    if (!this.socket || this.lifecycleState !== 'connected') return;
    for (;;) {
      if (this.queueState.chunks.length === 0) return;
      const now = Date.now();
      const rl = tryConsume(this.rateLimiterState, this.config.rateLimit, 1, now);
      this.rateLimiterState = rl.state;
      if (!rl.allowed) {
        this.scheduleDrainRetry();
        return;
      }
      const dequeued = dequeueChunk(this.queueState);
      if (!dequeued) return;
      this.queueState = dequeued.state;
      this.socket.send(dequeued.chunk.bytes);
    }
  }

  private scheduleDrainRetry(): void {
    if (this.drainRetryTimer) return;
    this.drainRetryTimer = setTimeout(() => {
      this.drainRetryTimer = null;
      this.drainQueue();
    }, DRAIN_RETRY_MS);
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimers();
    this.heartbeatIntervalTimer = setInterval(() => {
      if (!this.socket || this.lifecycleState !== 'connected') return;
      try {
        this.socket.send(HEARTBEAT_PING);
      } catch {
        return;
      }
      this.heartbeatTimeoutTimer = setTimeout(
        () => this.handleHeartbeatTimeout(),
        this.config.heartbeatTimeoutMs,
      );
    }, this.config.heartbeatIntervalMs);
  }

  private handleHeartbeatTimeout(): void {
    if (this.lifecycleState !== 'connected') return;
    this.clearHeartbeatTimers();
    this.clearIdleTimer();
    this.teardownSocket();
    this.lifecycleState = transition(this.lifecycleState, { type: 'HEARTBEAT_TIMEOUT' });
    this.emitLifecycle();
    this.emitEval(transportDisconnectedEvent(this.tMs(), 'timeout'));
    this.scheduleReconnect();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.terminate({ type: 'IDLE_TIMEOUT' });
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatIntervalTimer) {
      clearInterval(this.heartbeatIntervalTimer);
      this.heartbeatIntervalTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearHeartbeatTimers();
    this.clearIdleTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.drainRetryTimer) {
      clearTimeout(this.drainRetryTimer);
      this.drainRetryTimer = null;
    }
  }

  /**
   * 終端処理の唯一の入口（明示 close / idle timeout）。`this.closed` を関数の先頭で
   * 同期的に立てるため、同期的な二重呼び出しでも close hook は必ず 1 回だけ走る。
   */
  private async terminate(event: { type: 'CLOSE' } | { type: 'IDLE_TIMEOUT' }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearAllTimers();
    this.lifecycleState = transition(this.lifecycleState, event);
    this.emitLifecycle();
    this.teardownSocket();

    for (const hook of this.closeHooks) {
      try {
        await hook();
      } catch {
        // 1 つの hook の失敗で残りの hook（他の外部 session の close）を止めない。
      }
    }
  }
}
