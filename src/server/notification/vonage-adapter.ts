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

function parseTimeoutMs(raw: string | undefined): number {
  const ms = Number(raw ?? '5000');
  return Number.isFinite(ms) && ms > 0 ? ms : 5000;
}

/**
 * Secrets Manager の Vonage 接続情報（JSON `{ endpoint, token, timeoutMs? }`）を遅延解決して
 * HttpVonageAdapter へ委譲する。鍵が解決できない場合は Mock に fallback する。
 * authorizer の SITE_TOKEN_SECRET 解決と同じく、初回 notify 時に取得して warm container 内で再利用。
 */
export class SecretsVonageAdapter implements VonageAdapter {
  private delegate: Promise<VonageAdapter> | undefined;
  constructor(
    private readonly secretArn: string,
    private readonly region: string,
  ) {}

  private resolve(): Promise<VonageAdapter> {
    if (!this.delegate) {
      this.delegate = (async () => {
        const { SecretsManagerClient, GetSecretValueCommand } = await import(
          '@aws-sdk/client-secrets-manager'
        );
        const client = new SecretsManagerClient({ region: this.region });
        const res = await client.send(new GetSecretValueCommand({ SecretId: this.secretArn }));
        if (!res.SecretString) return new MockVonageAdapter();
        const cfg = JSON.parse(res.SecretString) as Partial<HttpVonageConfig>;
        if (!cfg.endpoint || !cfg.token) return new MockVonageAdapter();
        return new HttpVonageAdapter({
          endpoint: cfg.endpoint,
          token: cfg.token,
          timeoutMs: cfg.timeoutMs ?? 5000,
        });
      })();
    }
    return this.delegate;
  }

  async notify(target: NotificationTarget, payload: NotifyPayload): Promise<NotificationResult> {
    return (await this.resolve()).notify(target, payload);
  }
}

/**
 * 環境に応じて Vonage adapter を選ぶ（createPollyAdapter / createSiteConfigLoader と同じ流儀）。
 * 1. `VONAGE_NOTIFY_ENDPOINT` + `VONAGE_NOTIFY_TOKEN` が揃えば実 HTTP 通知（直接指定）。
 * 2. `VONAGE_SECRET_ARN` があれば Secrets Manager から接続情報を遅延解決（CDK の配線）。
 * 3. いずれも無ければ Mock（実発信なし）。
 */
export function createVonageAdapter(
  env: Record<string, string | undefined> = process.env,
): VonageAdapter {
  const endpoint = env.VONAGE_NOTIFY_ENDPOINT;
  const token = env.VONAGE_NOTIFY_TOKEN;
  if (endpoint && token) {
    return new HttpVonageAdapter({
      endpoint,
      token,
      timeoutMs: parseTimeoutMs(env.VONAGE_NOTIFY_TIMEOUT_MS),
    });
  }
  if (env.VONAGE_SECRET_ARN) {
    return new SecretsVonageAdapter(env.VONAGE_SECRET_ARN, env.AWS_REGION ?? 'ap-northeast-1');
  }
  return new MockVonageAdapter();
}
