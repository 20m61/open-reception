/**
 * 受付完了画面の退館クレデンシャル提示 純ロジック (issue #342)。
 *
 * 副作用・I/O を持たない（QR 符号化は qrcode-generator の純関数のみ）。受付完了時に発行された
 * 退館 token を、退館 checkout URL（`?ct=<token>`）へ組み立て、その URL を QR 画像（SVG data URL）
 * へ描画する。QR に載せるのは URL（= token 参照）のみで、氏名等 PII は一切載せない
 * （docs/checkout-stay-design.md §8.2、`rules/pii-secret-minimization.md`）。
 *
 * token/コードは秘密だが PII ではない。ここではログ出力せず、表示のためだけに使う。
 */
import { CHECKOUT_TOKEN_QUERY } from './self-id';
import { renderTextToQrSvg } from '@/lib/reservation/qr';

/**
 * 退館 checkout URL を組み立てる。`<origin>/kiosk/checkout?ct=<token>`。
 * origin は絶対 URL（ブラウザの window.location.origin）。末尾スラッシュは正規化する。
 */
export function buildCheckoutUrl(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, '');
  const url = new URL(`${base}/kiosk/checkout`);
  url.searchParams.set(CHECKOUT_TOKEN_QUERY, token);
  return url.toString();
}

/**
 * 退館 checkout URL を QR 画像（SVG の data URL）へ描画する。
 *
 * Buffer 非依存（`encodeURIComponent`）でブラウザでも動く。token は QR のモジュール（画素）に
 * 符号化され、SVG マークアップ中に平文の token 文字列としては現れない。
 */
export function checkoutQrDataUrl(url: string, ariaLabel: string): string {
  const svg = renderTextToQrSvg(url, { ariaLabel });
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
