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

/**
 * accent の上に置くインクの候補 (#884 / 課題 23・25・26)。
 *
 * `globals.css` の `--color-accent-ink`（暗）と `--color-on-accent`（明）と同じ値を持つ。
 * ずれると「選んだのに黒潰れする」accent が生まれるので、`tokens-css-parity` 系の検査で
 * CSS の実値と突き合わせる。
 */
export const ACCENT_INK_DARK = '#06121f';
export const ACCENT_INK_LIGHT = '#ffffff';

/**
 * accent 上の文字に要求する最小コントラスト比。
 *
 * WCAG 2.1 の 1.4.3 は大きな文字で 3:1。主 CTA のラベルは `--font-lg` 相当（24px 以上・太字）で
 * 「大きな文字」に当たる。**実測では 2 つのインクの良いほうを選べば、sRGB のどの色でも
 * 最低 4.34:1 が出る**（最悪ケースは `#9966aa`）ので、この下限は余裕をもって満たされる。
 */
export const MIN_ACCENT_CONTRAST = 3;

/** sRGB チャンネル値（0–255）を相対輝度の線形成分へ。WCAG 2.1 の定義そのまま。 */
function channelLuminance(value8bit: number): number {
  const c = value8bit / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** `#rrggbb` の相対輝度（WCAG 2.1）。 */
function relativeLuminance(hex: string): number {
  const r = channelLuminance(parseInt(hex.slice(1, 3), 16));
  const g = channelLuminance(parseInt(hex.slice(3, 5), 16));
  const b = channelLuminance(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 2 色のコントラスト比（1–21）。 */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * accent の上に置く文字色を**輝度で選ぶ** (#884)。
 *
 * ## なぜ固定インクでは駄目だったか
 *
 * `--color-accent-ink` は `#06121f` 固定で、主 CTA（`.btn--primary`）・選択中タブ・
 * 支援モードメニューの選択状態で accent の上に置かれる。**紺やえんじを選んだテナントは
 * 黒地に黒文字**になり、受付を完遂できない。実測: `#7f1d1d` 対 `#06121f` = **1.88:1**。
 *
 * ## なぜ「暗い accent を弾く」ではなく「インクを選ぶ」か
 *
 * 弾く案も検討したが、`#7f1d1d` / `#1e3a8a` / `#312e81` のような**実在するコーポレート
 * カラーがほぼ全滅**する。ブランド差し替えという機能の目的を潰すので採らなかった。
 *
 * インクを選ぶ側に倒すと、**弾く必要がそもそも無くなる** —— sRGB を総当たりしたところ、
 * 2 つのインクの良いほうを取れば最悪でも 4.34:1（`#9966aa`）が出る。よって
 * `normalizeAccentColor` はコントラストで拒否しない（保存済みの暗い accent も壊さない）。
 */
export function accentInkFor(accent: string): string {
  return contrastRatio(accent, ACCENT_INK_DARK) >= contrastRatio(accent, ACCENT_INK_LIGHT)
    ? ACCENT_INK_DARK
    : ACCENT_INK_LIGHT;
}

/**
 * `#RRGGBB` のみ許可し小文字化する。無効なら undefined。
 *
 * **コントラストでは弾かない。** インクを `accentInkFor` が輝度で選ぶので、どの色でも
 * 読める組み合わせが必ず存在する（上記の総当たり実測）。ここで弾くと、実在する
 * コーポレートカラーを理由なく拒否することになる。
 */
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

/**
 * ロゴ or 社名のどちらかがあれば「ブランド表示あり」と判定する (issue #326)。
 * 待機画面（IdleView）とサイネージのアセット未設定フォールバックが同じ基準を共有するための
 * 単一の真実源（重複判定による乖離を防ぐ）。
 */
export function hasBrandingContent(branding: Pick<BrandingSettings, 'logoUrl' | 'companyName'>): boolean {
  return Boolean(branding.logoUrl || branding.companyName);
}
