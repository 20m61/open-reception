/**
 * Vonage 外部通知アダプタ (DESIGN #34 §6 / #405 Inc3)。
 * `notify(target, payload): Promise<NotificationResult>`。
 * 応答 / 失敗 / タイムアウトを分類する。
 *
 * secret はクライアントに置かず、接続情報の **供給源はテナント設定**
 * （`resolveVonageAdapterForTenant` → `@/lib/platform/provider-resolution`）。グローバル
 * `VONAGE_NOTIFY_*` / `VONAGE_SECRET_ARN` env 経路は #405 Inc3 で撤去済み。既定は
 * MockVonageAdapter（実発信しない。#4 外部待ち）。
 */
import type { NotificationTarget, NotificationResult, AudioRef } from './types';
import { resolveProviderForTenant, type ResolveProviderDeps } from '@/lib/platform/provider-resolution';

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

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * テナント設定に基づく通知 adapter を解決する（#405 Inc3。旧 `createVonageAdapter(env)` の置換）。
 *   - vonage 解決かつ接続 bundle（secret JSON `{ endpoint, token, timeoutMs? }`）完備 → HttpVonageAdapter。
 *   - それ以外（未設定 / provider!=vonage / disabled / bundle 不備）→ MockVonageAdapter（実発信なし）。
 *
 * secret 値は末端（本関数）でのみ `reveal()` する。timeoutMs は非秘密設定 or bundle いずれからでも可。
 * `tenantId` は呼び出し元の認可済みコンテキスト由来のみ渡すこと（越境防止）。
 */
export async function resolveVonageAdapterForTenant(
  tenantId: string,
  deps?: ResolveProviderDeps,
): Promise<VonageAdapter> {
  const resolved = await resolveProviderForTenant(tenantId, deps);
  if (resolved.provider !== 'vonage') return new MockVonageAdapter();

  let bundle: { endpoint?: unknown; token?: unknown; timeoutMs?: unknown };
  try {
    bundle = JSON.parse(resolved.secret.reveal());
  } catch {
    return new MockVonageAdapter();
  }
  const { endpoint, token } = bundle;
  if (typeof endpoint !== 'string' || typeof token !== 'string') return new MockVonageAdapter();

  const bundleTimeout = typeof bundle.timeoutMs === 'number' ? bundle.timeoutMs : undefined;
  const timeoutMs = bundleTimeout ?? resolved.settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new HttpVonageAdapter({ endpoint, token, timeoutMs });
}
