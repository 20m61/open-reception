/**
 * 受付端末 checkin URL の基底オリジン解決 (issue #97, increment 2)。
 *
 * QR に載せる `<baseUrl>/kiosk/checkin?rt=<token>` の baseUrl はサーバ側で決める。
 * クライアントが送る値は信用せず、環境変数 → リクエスト由来オリジンの順で決定する。
 * これにより QR の宛先（受付端末オリジン）の改ざんを防ぐ。
 *
 * 優先順位:
 *   1. RESERVATION_CHECKIN_BASE_URL（運用で明示する場合）
 *   2. NEXT_PUBLIC_APP_URL（アプリ公開オリジン。既存の公開設定があれば再利用）
 *   3. リクエストの Origin/Host から推定（フォールバック）
 */

/** 末尾スラッシュを除いた正規化済みオリジンか簡易判定。空文字は不可。 */
function normalizeOrigin(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return undefined;
  try {
    // 妥当な絶対 URL のみ受け付ける（相対やゴミを弾く）。
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}

/** リクエストの forwarded/host ヘッダからオリジンを推定する。 */
function originFromRequest(request: Request): string | undefined {
  const explicitOrigin = normalizeOrigin(request.headers.get('origin'));
  if (explicitOrigin) return explicitOrigin;

  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) {
    // 最後の手段としてリクエスト URL のオリジンを使う。
    return normalizeOrigin(request.url);
  }
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  return normalizeOrigin(`${proto}://${host}`);
}

/** checkin URL の基底オリジンをサーバ側で解決する。決められなければ null。 */
export function resolveCheckinBaseUrl(request: Request): string | null {
  return (
    normalizeOrigin(process.env.RESERVATION_CHECKIN_BASE_URL) ??
    normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL) ??
    originFromRequest(request) ??
    null
  );
}
