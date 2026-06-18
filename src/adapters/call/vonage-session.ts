/**
 * Vonage 通話セッション/短命トークンのインターフェース (issue #4)。
 * 設計のみ先行整備。実装は本番認証情報が用意でき次第（docs/vonage-call-design.md）。
 *
 * 重要: secret/private key はサーバ内に留め、クライアントへは短命トークンのみ渡す。
 */
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
