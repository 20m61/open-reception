/**
 * Vonage（OpenTok 互換）client SDK アダプタ (issue #4 increment 2c)。
 *
 * call-controller の CallClient 境界を実装する。実 SDK は CDN スクリプトで動的ロードし、
 * 読み込み/接続に失敗したら onError でフォールバックへ降格する（受付フローを止めない）。
 *
 * IMPORTANT(要ライブ検証): SDK のグローバル名/URL/API は Vonage の世代（OpenTok.js の `OT`
 * vs 統合 Video client SDK）で差異がある。本実装は OpenTok.js 互換（`OT`）の最小サーフェスを
 * 前提とし、SDK 依存部は defaultLoadSdk と下記の最小 interface に隔離する。実認証情報・実機での
 * 結合検証時に URL/グローバル/呼び出しを調整する。connect/disconnect の制御ロジックは
 * loadSdk 注入により単体テスト可能。
 */
import type { CallClient } from '@/lib/call/call-controller';

/** OpenTok.js 互換の最小 SDK サーフェス。 */
export interface VideoPublisher {
  destroy?: () => void;
}
export interface VideoSession {
  connect(token: string, callback: (error?: unknown) => void): void;
  publish(publisher: VideoPublisher, callback?: (error?: unknown) => void): void;
  on(event: string, handler: (event: unknown) => void): void;
  disconnect(): void;
}
export interface VideoSdk {
  initSession(applicationId: string, sessionId: string): VideoSession;
  initPublisher(targetElement?: HTMLElement | string, properties?: Record<string, unknown>): VideoPublisher;
}

/** クライアントに露出してよい公開 URL（CDN）。NEXT_PUBLIC_ で上書き可能。 */
const DEFAULT_SDK_URL =
  process.env.NEXT_PUBLIC_VONAGE_SDK_URL ?? 'https://static.opentok.com/v2/js/opentok.min.js';
const GLOBAL_NAME = 'OT';

/** ブラウザで SDK スクリプトを動的ロードし、グローバルを返す（browser-only・要ライブ検証）。 */
async function defaultLoadSdk(): Promise<VideoSdk> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('vonage client sdk requires a browser environment');
  }
  const globalScope = window as unknown as Record<string, unknown>;
  if (globalScope[GLOBAL_NAME]) return globalScope[GLOBAL_NAME] as VideoSdk;

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-vonage-sdk]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('vonage sdk load failed')));
      return;
    }
    const script = document.createElement('script');
    script.src = DEFAULT_SDK_URL;
    script.async = true;
    script.dataset.vonageSdk = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('vonage sdk load failed'));
    document.head.appendChild(script);
  });

  const sdk = globalScope[GLOBAL_NAME];
  if (!sdk) throw new Error('vonage sdk global not found after load');
  return sdk as VideoSdk;
}

export type VonageClientDeps = {
  /** テスト/差し替え用。既定は CDN スクリプトの動的ロード。 */
  loadSdk?: () => Promise<VideoSdk>;
  /** publisher を描画する DOM コンテナの取得。 */
  getContainer?: () => HTMLElement | undefined;
};

export class VonageCallClient implements CallClient {
  private session?: VideoSession;
  private readonly loadSdk: () => Promise<VideoSdk>;
  private readonly getContainer: () => HTMLElement | undefined;

  constructor(deps: VonageClientDeps = {}) {
    this.loadSdk = deps.loadSdk ?? defaultLoadSdk;
    this.getContainer = deps.getContainer ?? (() => undefined);
  }

  async connect(opts: {
    applicationId: string;
    sessionId: string;
    token: string;
    onConnected: () => void;
    onError: (err: unknown) => void;
  }): Promise<void> {
    try {
      const sdk = await this.loadSdk();
      const session = sdk.initSession(opts.applicationId, opts.sessionId);
      this.session = session;
      // 相手（担当者）のストリーム出現を「接続成立」とみなす。
      session.on('streamCreated', () => opts.onConnected());
      session.connect(opts.token, (error) => {
        if (error) {
          opts.onError(error);
          return;
        }
        try {
          const publisher = sdk.initPublisher(this.getContainer());
          session.publish(publisher);
        } catch (err) {
          opts.onError(err);
        }
      });
    } catch (err) {
      opts.onError(err);
    }
  }

  async disconnect(): Promise<void> {
    try {
      this.session?.disconnect();
    } catch {
      // 切断時のエラーは握りつぶす（既にネットワーク断のことがある）。
    }
    this.session = undefined;
  }
}
