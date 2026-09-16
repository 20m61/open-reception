/**
 * 担当者の通話応答トークン (issue #4 increment 2c)。
 *
 * 担当者は通知（通知サブシステム）で受け取ったリンクに署名付きトークンを含む。
 * トークンは受付セッションにスコープし短命。担当者応答エンドポイントがこれを検証して
 * subscriber トークンを発行する。secret は server-only。
 */
import { signSession, verifySession } from '@/lib/auth/session';
import { serverSecret } from '@/lib/auth/server-secret';

/** 応答リンクの既定有効期限（10 分）。未応答リンクを長期間有効にしない。 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * 応答トークンの署名鍵。**deploy 環境で未設定なら throw する** (#1021 AC2)。
 *
 * 🔴 ここは `serverSecret()` を通していなかった。deploy で未設定でも
 * 警告すら出ず、公開ソース上の既知文字列で応答トークンを偽造できた。受け取り側は
 * subscriber トークンを発行して受付を `connected` に確定するので、**来訪者には
 * 「担当者が応答しました」と出る**（誰も出ていない）。
 *
 * 🔴 **`KIOSK_SESSION_SECRET` へのフォールバックも外した（信頼境界を共有しない）。**
 * 流用していると、kiosk セッション鍵を握った者が「担当者が応答した」を偽造できる。
 * 別の信頼境界には別の鍵を使う。
 *
 * 消費者は `/api/staff/calls/[id]/answer` と `.../respond` だけで、要求ごとに評価される
 * ので、failClosed にしても他の経路は壊れない。
 *
 * 🔴 **route 層で 503 に写像済み（#1123）。** 鍵未設定のデプロイでは
 * `/api/staff/calls/[id]/answer`・`/respond` が uncaught 例外ではなく 503 を返し、
 * 設定不備はプロセスにつき 1 度だけ記録される（`src/lib/auth/secret-unavailable.ts`）。
 * 担当者画面も「リンクの有効期限切れ」ではなく「サーバー側の問題」と伝える
 * （`src/components/staff/staff-failure.ts`）。
 *
 * 🔴 **正常時（403）との差は残る＝鍵の有無は外から読める。** 403 に揃えれば閉じるが、
 * 区別不能にすると担当者にも真実を伝えられなくなるため両立しない。リポジトリ全体で
 * どちらを採るかは **#1127**。
 */
export function getAnswerSecret(): string {
  return serverSecret('CALL_ANSWER_SECRET', 'dev-insecure-answer-secret', { failClosed: true });
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
