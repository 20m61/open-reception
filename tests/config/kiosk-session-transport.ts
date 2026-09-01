/**
 * 受付端末 e2e のセッション確立で使う HTTP 輸送の契約 (#847)。
 *
 * Playwright の `request.newContext()` は、見た目は使い捨ての cookie ジャーでも、
 * **プロセス共通の `http.Agent({ keepAlive: true })`** を使う（playwright-core の
 * `httpHappyEyeballsAgent`）。`dispose()` してもソケットはプールに残る。
 *
 * Node の HTTP サーバは既定で keep-alive を数秒で切る。前のテストがソケットを遊ばせたあと
 * 次のテストの最初の `POST /api/admin/login` が死んだソケットを再利用すると
 * `read ECONNRESET` になる。スタックは fixture の 1 行目なので、spec のアサーションには
 * 一度も到達しない。`retries` が吸収すると `--full` が flaky 付きで green になる。
 *
 * 抑止は **リトライではなく** `Connection: close`。再利用そのものを止める。
 * それでも RST が残るならサーバ側の異常（クラッシュ / 枯渇）であり、keep-alive とは別物。
 */

export const ADMIN_API_CONNECTION_HEADER = 'close' as const;

export function adminApiContextOptions(baseURL: string): {
  baseURL: string;
  extraHTTPHeaders: { Connection: typeof ADMIN_API_CONNECTION_HEADER };
} {
  return {
    baseURL,
    extraHTTPHeaders: { Connection: ADMIN_API_CONNECTION_HEADER },
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if (!('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Playwright が `apiRequestContext.post: read ECONNRESET` と包んだ形も含む。 */
export function isSocketResetError(error: unknown): boolean {
  if (errorCode(error) === 'ECONNRESET') return true;
  if (/\bECONNRESET\b/.test(errorMessage(error))) return true;
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return isSocketResetError(error.cause);
  }
  return false;
}

/**
 * fixture 輸送の RST を、spec のアサーション失敗やサーバ 5xx と読み違えない文言へ包む。
 * **同じエラーを再送して隠さない。** 呼び出し側は throw するだけ。
 */
export function formatKioskSessionTransportError(error: unknown, requestLabel: string): Error {
  if (!isSocketResetError(error)) {
    return error instanceof Error ? error : new Error(errorMessage(error));
  }
  return new Error(
    `kiosk-session-transport: ${requestLabel} で接続がリセットされた (ECONNRESET)。` +
      'Playwright の APIRequestContext はプロセス共通の keep-alive agent を使う。' +
      'サーバが先にソケットを閉じたあとに再利用すると、テスト本体に到達する前に落ちる (#847)。' +
      'Connection: close を付けても残るなら、サーバ側の RST（クラッシュ / 枯渇）であり fixture の keep-alive ではない。' +
      ` 元: ${errorMessage(error)}`,
    { cause: error instanceof Error ? error : undefined },
  );
}
