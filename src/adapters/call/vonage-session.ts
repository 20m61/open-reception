/**
 * Vonage 通話セッション/短命トークンのインターフェースと実装 (issue #4)。
 *
 * 重要: secret/private key はサーバ内に留め、クライアントへは短命トークンのみ渡す。
 * createSession は Vonage Video REST を呼ぶ（transport 注入でテスト可能）。
 * issueToken はローカルで RS256 JWT を発行する（ネットワーク不要）。
 * docs/vonage-call-design.md §10。
 */
import type { VonageConfig } from '@/lib/call/vonage-config';
import { generateAppJwt, generateClientToken } from '@/lib/call/vonage-jwt';

export type VonageSessionRef = { sessionId: string };

export type TokenRole = 'publisher' | 'subscriber';

export type ShortLivedToken = {
  token: string;
  role: TokenRole;
  /** ISO8601。短命（数分程度）を想定。 */
  expiresAt: string;
};

/**
 * 受付セッションに紐づく Vonage セッション作成と短命トークン発行（server-only 実装）。
 */
export interface VonageSessionService {
  /** 受付セッション ID に対応する通話セッションを作成する。 */
  createSession(receptionId: string): Promise<VonageSessionRef>;
  /** 役割ごとの短命トークンを発行する（クライアントへ渡すのはこれのみ）。 */
  issueToken(session: VonageSessionRef, role: TokenRole): Promise<ShortLivedToken>;
}

/** テスト可能にするための最小 transport（fetch 互換）。 */
export type VonageTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const DEFAULT_BASE_URL = 'https://video.api.vonage.com';

const defaultTransport: VonageTransport = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

/**
 * Vonage Video REST に対する実装。
 * NOTE: REST エンドポイント/レスポンス形は実認証情報での結合確認が必要（increment 1 は単体まで）。
 */
export class RestVonageSessionService implements VonageSessionService {
  constructor(
    private readonly config: VonageConfig,
    private readonly transport: VonageTransport = defaultTransport,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async createSession(_receptionId: string): Promise<VonageSessionRef> {
    const jwt = generateAppJwt({
      applicationId: this.config.applicationId,
      privateKeyPem: this.config.privateKey,
    });
    const url = `${this.baseUrl}/v2/project/${this.config.applicationId}/session`;
    const res = await this.transport(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ mediaMode: 'routed', archiveMode: 'manual' }),
    });
    if (!res.ok) {
      throw new Error(`vonage createSession failed: HTTP ${res.status}`);
    }
    const body = JSON.parse(await res.text()) as Array<{ session_id?: string }> | { session_id?: string };
    const sessionId = Array.isArray(body) ? body[0]?.session_id : body.session_id;
    if (!sessionId) {
      throw new Error('vonage createSession: session_id missing in response');
    }
    return { sessionId };
  }

  async issueToken(session: VonageSessionRef, role: TokenRole): Promise<ShortLivedToken> {
    const { token, expiresAt } = generateClientToken({
      applicationId: this.config.applicationId,
      privateKeyPem: this.config.privateKey,
      sessionId: session.sessionId,
      role,
    });
    return { token, role, expiresAt };
  }
}
