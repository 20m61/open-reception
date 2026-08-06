/**
 * Vonage webhook ルートの共通処理 (issue #4 MVP 1)。
 *
 * 3 本（answer / events / dtmf）が同じ検証と同じ拒否応答を使うようにまとめる。
 * 分けて書くと、いつか 1 本だけ検証が緩む。
 *
 * **拒否は常に同一応答**（403 / 固定文言）。理由で分けると、通話 ID の総当たりで
 * 「その通話は存在する」「署名だけ違う」が漏れる。診断はサーバログで行う。
 *
 * **server-only**。
 */
import { NextResponse } from 'next/server';
import { resolveVonageSignatureSecret } from '@/lib/call/vonage-signature';
import { getCallCorrelationRepository } from './call-correlation';
import { resolveVerifiedWebhook, type VerifiedWebhook } from './vonage-webhook-context';

/** 拒否応答。**理由を載せない**（存在・鍵の有無を漏らさない）。 */
export function rejectWebhook(): NextResponse {
  return new NextResponse('forbidden', {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * リクエストを検証し、成功なら相関を返す。失敗は呼び出し側で `rejectWebhook()` を返すこと。
 * 生ボディも返す（`payload_hash` の対象なので、再取得せず同じ文字列を使う）。
 */
export async function verifyRequest(
  request: Request,
): Promise<{ verified: VerifiedWebhook; rawBody: string }> {
  // **生ボディを 1 度だけ読む。** 読み直し（再シリアライズ）は hash がずれる。
  const rawBody = await request.text();
  const verified = await resolveVerifiedWebhook(
    { rawBody, authorization: request.headers.get('authorization') ?? undefined },
    {
      correlations: getCallCorrelationRepository(),
      loadSignatureSecret: resolveVonageSignatureSecret,
      nowSec: Math.floor(Date.now() / 1000),
    },
  );
  return { verified, rawBody };
}
