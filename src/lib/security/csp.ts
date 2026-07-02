/**
 * nonce ベース CSP（issue #200）。
 *
 * script-src から 'unsafe-inline' を排除し、リクエストごとに生成する nonce で
 * Next.js の inline/bootstrap script を許可する。nonce は per-request のため
 * 静的ヘッダ（next.config.ts）では扱えず、`src/proxy.ts` で生成して
 * リクエスト/レスポンス双方の Content-Security-Policy ヘッダに載せる。
 * Next.js はリクエストヘッダの CSP から nonce を抽出し、SSR 時に自身の
 * framework/inline script へ自動付与する（＝全ルート動的レンダリング必須。
 * root layout の `connection()` で強制する）。
 *
 * 段階導入（#200 撤回知見）: 'strict-dynamic' は付けない。同一オリジンの
 * chunk（外部 script）は 'self' で許可し、inline script のみ nonce で許可する。
 * style-src の 'unsafe-inline' 排除は別課題として現状維持。
 */

/** Server Component から nonce を参照するためのリクエストヘッダ名。 */
export const NONCE_HEADER = 'x-nonce';

/** CSP script-src 用の per-request nonce（128bit エントロピー、base64）。 */
export function createCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Buffer は edge runtime に無いことがあるため btoa 互換の変換を使う。
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * CSP ディレクティブ文字列を組み立てる。
 * nonce 以外は従来の静的 CSP（#6/#31: blob/data の限定許可、ZAP 10055 の
 * スキームワイルドカード回避）を踏襲する。
 */
export function buildCsp(nonce: string, opts?: { dev?: boolean }): string {
  // 開発時のみ 'unsafe-eval' を許可（React がサーバエラーのスタック再構築等に
  // eval を使うため。production では React/Next.js とも eval を使わない）。
  const devEval = opts?.dev ? " 'unsafe-eval'" : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${devEval}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' blob:",
    "media-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
