/**
 * Vonage 外部通知アダプタ (DESIGN #34 §6)。
 * `notify(target, payload): Promise<NotificationResult>`。
 * 応答 / 失敗 / タイムアウトを分類する。
 *
 * secret はクライアントに置かず、実装は Secrets Manager から取得した接続情報で
 * 動作する。既定は MockVonageAdapter（実発信しない）。
 */
import type { NotificationTarget, NotificationResult, AudioRef } from './types';

export interface NotifyPayload {
  requestId: string;
  message: string;
  /** 音声化済みの場合に渡す。未指定ならテキスト通知 fallback。 */
  audio?: AudioRef;
}

export interface VonageAdapter {
  notify(target: NotificationTarget, payload: NotifyPayload): Promise<NotificationResult>;
}

/** テスト・ローカル用。実発信せず delivered を返す。 */
export class MockVonageAdapter implements VonageAdapter {
  async notify(target: NotificationTarget, payload: NotifyPayload): Promise<NotificationResult> {
    return {
      status: 'delivered',
      requestId: payload.requestId,
      synthesized: Boolean(payload.audio),
    };
  }
}

export interface HttpVonageConfig {
  /** 通知 API エンドポイント。 */
  endpoint: string;
  /** Secrets Manager 等から取得した bearer トークン。 */
  token: string;
  /** タイムアウト(ms)。超過は timeout に分類。 */
  timeoutMs: number;
}

/**
 * 実 Vonage 連携の骨組み。グローバル fetch（Node 22）で通知 API を呼ぶ。
 * Vonage アカウント固有の認証（JWT 署名等）は接続情報に応じて token 生成側で吸収する。
 */
export class HttpVonageAdapter implements VonageAdapter {
  constructor(private readonly config: HttpVonageConfig) {}

  async notify(target: NotificationTarget, payload: NotifyPayload): Promise<NotificationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({
          to: target,
          requestId: payload.requestId,
          text: payload.message,
          audioFormat: payload.audio?.format,
          audioBase64: payload.audio?.base64,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          status: 'failed',
          requestId: payload.requestId,
          synthesized: Boolean(payload.audio),
          reason: `upstream_status_${res.status}`,
        };
      }
      return {
        status: 'delivered',
        requestId: payload.requestId,
        synthesized: Boolean(payload.audio),
      };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        status: isAbort ? 'timeout' : 'failed',
        requestId: payload.requestId,
        synthesized: Boolean(payload.audio),
        reason: isAbort ? 'request_timeout' : 'request_error',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 環境に応じて Vonage adapter を選ぶ（createPollyAdapter / createSiteConfigLoader と同じ流儀）。
 * `VONAGE_NOTIFY_ENDPOINT` と `VONAGE_NOTIFY_TOKEN` が揃ったときのみ実 HTTP 通知を行う。
 * いずれか欠ける場合は Mock（実発信なし）に fallback する。
 * token はデプロイ時に Secrets Manager から env へ注入する（平文コミットしない）。
 */
export function createVonageAdapter(
  env: Record<string, string | undefined> = process.env,
): VonageAdapter {
  const endpoint = env.VONAGE_NOTIFY_ENDPOINT;
  const token = env.VONAGE_NOTIFY_TOKEN;
  if (endpoint && token) {
    const timeoutMs = Number(env.VONAGE_NOTIFY_TIMEOUT_MS ?? '5000');
    return new HttpVonageAdapter({
      endpoint,
      token,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000,
    });
  }
  return new MockVonageAdapter();
}
