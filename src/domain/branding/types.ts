/**
 * 受付端末のブランディング設定 (issue #88, 「会社の顔」テーマ注入)。
 *
 * 目的: テナント（会社）のロゴ・アクセント色・社名を待機画面に反映し、汎用 UI を
 * 「その会社の受付」に見せる。kiosk は CSS 変数 `--brand-accent` を上書きしてテーマ化する。
 *
 * セキュリティ / 配信 (#105):
 *   - ロゴは秘匿情報ではない公開アセット。CSP は `img-src 'self' data: blob:` のため、
 *     外部 https ホストは許可せず data:image（アップロード）または同一オリジン相対のみ受け付ける。
 *   - data URI の肥大で config が膨らまないよう上限を設ける。
 */

export type BrandingSettings = {
  /** 待機画面に出す会社名（任意・最大 60 文字）。 */
  companyName?: string;
  /** ブランドのアクセント色（#RRGGBB）。kiosk の `--brand-accent` を上書きする。 */
  accentColor?: string;
  /** ロゴ画像。data:image（アップロード）または同一オリジン相対パス（/assets/... 等）。 */
  logoUrl?: string;
};

/** data URI ロゴの上限（config 肥大防止）。約 512KB。 */
export const MAX_LOGO_DATA_URI_LENGTH = 512 * 1024;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);/i;
const SAME_ORIGIN_PATH = /^\/[^/]/;

/** `#RRGGBB` のみ許可し小文字化する。無効なら undefined。 */
export function normalizeAccentColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return HEX_COLOR.test(s) ? s.toLowerCase() : undefined;
}

/** CSP（self/data:）に適合するロゴのみ許可する。無効なら undefined。 */
export function normalizeLogoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (DATA_IMAGE.test(s)) return s.length <= MAX_LOGO_DATA_URI_LENGTH ? s : undefined;
  if (SAME_ORIGIN_PATH.test(s)) return s;
  return undefined;
}

/** 会社名を 60 文字に制限する。空なら undefined。 */
export function normalizeCompanyName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().slice(0, 60);
  return s.length > 0 ? s : undefined;
}
