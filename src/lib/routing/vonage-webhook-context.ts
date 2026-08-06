/**
 * Vonage webhook を「検証済みの受付」へ解決する (issue #4 MVP 1)。
 *
 * webhook は公開エンドポイントなので、**3 つを順に確かめて初めて処理してよい**:
 *
 *   1. 本文から provider の通話 ID を取る（URL のクエリは使わない ── `payload_hash` の
 *      対象外なので、正規の webhook を別の通話へ付け替えられる）
 *   2. その通話 ID で相関を引き、**どのテナントか**を確定する
 *   3. **そのテナントの** signature secret で署名を検証する
 *
 * 2 → 3 の順になるのは、テナントごとに Vonage 資格情報が違うため。相関を引く前は
 * どの鍵で検証すべきか分からない。相関の読み出し自体は何も返さない（下記の一様性）。
 *
 * **失敗はすべて同じ形（`{ ok: false }`）**。理由を返すと、呼び出し側がうっかり応答を
 * 分けてしまい、通話 ID の総当たりで「その通話は存在する」「署名だけ違う」が漏れる。
 * 診断はサーバログで行うこと（この関数は理由を持たない）。
 *
 * **server-only**（署名検証が `node:crypto` を使う）。
 */
import { verifyVonageWebhook } from '@/lib/security/vonage-webhook';
import type { CallCorrelationRepository, StoredCallCorrelation } from './call-correlation';

export type VonageWebhookRequest = {
  /** 署名対象そのもの。パース前の生ボディを渡すこと（再シリアライズすると hash がずれる）。 */
  readonly rawBody: string;
  readonly authorization: string | undefined;
};

export type VonageWebhookDeps = {
  readonly correlations: CallCorrelationRepository;
  /** テナントの Vonage signature secret を引く。未設定なら undefined（＝検証不能）。 */
  readonly loadSignatureSecret: (tenantId: string) => Promise<string | undefined>;
  readonly nowSec: number;
};

export type VerifiedWebhook =
  | { readonly ok: true; readonly correlation: StoredCallCorrelation; readonly jti: string }
  | { readonly ok: false };

/** 一様な失敗。理由を持たせない（呼び出し側が応答を分けられないようにする）。 */
const REJECTED: VerifiedWebhook = { ok: false };

/** 本文から provider の通話 ID を取り出す。Vonage は `uuid` で送る。 */
function readProviderCallId(rawBody: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const uuid = (parsed as Record<string, unknown>).uuid;
  return typeof uuid === 'string' && uuid !== '' ? uuid : undefined;
}

export async function resolveVerifiedWebhook(
  request: VonageWebhookRequest,
  deps: VonageWebhookDeps,
): Promise<VerifiedWebhook> {
  const providerCallId = readProviderCallId(request.rawBody);
  if (providerCallId === undefined) return REJECTED;

  const correlation = await deps.correlations.get(providerCallId);
  if (correlation === undefined) return REJECTED;

  const signatureSecret = await deps.loadSignatureSecret(correlation.tenantId);
  // このガードを外すと `string | undefined` を `string` へ渡せず**コンパイルが通らない**
  // （守っているのはテストではなく型システム。変異させても出力は同じに見えるので念のため記す）。
  if (!signatureSecret) return REJECTED;

  const verification = verifyVonageWebhook({
    authorization: request.authorization,
    rawBody: request.rawBody,
    signatureSecret,
    nowSec: deps.nowSec,
  });
  if (!verification.verified) return REJECTED;

  return { ok: true, correlation, jti: verification.jti };
}
