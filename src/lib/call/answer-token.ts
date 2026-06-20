/**
 * 担当者の通話応答トークン (issue #4 increment 2c)。
 *
 * 担当者は通知（通知サブシステム）で受け取ったリンクに署名付きトークンを含む。
 * トークンは受付セッションにスコープし短命。担当者応答エンドポイントがこれを検証して
 * subscriber トークンを発行する。secret は server-only。
 */
import { signSession, verifySession } from '@/lib/auth/session';

/** 応答リンクの既定有効期限（10 分）。未応答リンクを長期間有効にしない。 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function getAnswerSecret(): string {
  return (
    process.env.CALL_ANSWER_SECRET ??
    process.env.KIOSK_SESSION_SECRET ??
    'dev-insecure-answer-secret'
  );
}

/** 受付セッションに対する応答トークンを発行する（通知リンクに含める）。 */
export async function issueAnswerToken(receptionId: string, ttlMs: number = DEFAULT_TTL_MS): Promise<string> {
  return signSession({ role: 'call_answer', receptionId, exp: Date.now() + ttlMs }, getAnswerSecret());
}

/** 応答トークンを検証し receptionId を返す。無効/期限切れ/別用途なら null。 */
export async function readAnswerToken(token: string | undefined): Promise<{ receptionId: string } | null> {
  const payload = await verifySession(token, getAnswerSecret());
  if (!payload || payload.role !== 'call_answer') return null;
  const receptionId = payload.receptionId;
  return typeof receptionId === 'string' ? { receptionId } : null;
}
