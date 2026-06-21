/**
 * 受付端末のレイアウトプロファイル (issue #124 / Epic #119)。
 *
 * 役割: viewport から「画面種別ごとの役割配置」を一意に導出する純ロジック。
 * 単純な拡大縮小ではなく、iPad 横/縦・4K/大型横画面で要素配置を切り替えるための
 * 真実源とする。UI（KioskFlow）はこの結果を `data-kiosk-layout` 属性として公開し、
 * 配置・サイズ調整は CSS（globals.css）が属性セレクタで担う（JS はレイアウトを持たない）。
 *
 * 不変条件（テストで検証）:
 *  1. 戻り値は必ず `KIOSK_LAYOUTS` のいずれか（網羅・排他）。
 *  2. 4K/大型横画面は幅で判定し、iPad 相当の縦横はアスペクト比で分ける。
 *  3. 非正常値（0/負/NaN）でも破綻せず安全側（ipad-portrait）に倒す。
 */

/** レイアウトプロファイル一覧（表示順は役割の優先度ではなく定義順）。 */
export const KIOSK_LAYOUTS = ['ipad-portrait', 'ipad-landscape', 'large-display'] as const;

export type KioskLayout = (typeof KIOSK_LAYOUTS)[number];

/**
 * 大型/4K 横画面とみなす最小幅(px)。
 *
 * iPad (gen 7) 横置きは 1080px 幅のため、それを上回り 4K(3840)/FHD(1920)/QHD(2560) を
 * 含む 1600px をしきい値にする。これ以上は「操作領域を触れる範囲へ集約する」大型プロファイル。
 */
export const LARGE_DISPLAY_MIN_WIDTH = 1600;

/** viewport の寸法（px）。SSR や測定前は undefined を許容する。 */
export type Viewport = { width: number; height: number };

function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * viewport からレイアウトプロファイルを導出する。
 *
 * 判定順（排他）:
 *  1. 幅が `LARGE_DISPLAY_MIN_WIDTH` 以上 → `large-display`（4K/大型横画面）。
 *  2. 横長（幅 >= 高さ）→ `ipad-landscape`（左アバター / 右操作）。
 *  3. それ以外（縦長）→ `ipad-portrait`（上アバター / 下操作）。
 *
 * 寸法が不正（0/負/NaN）なら安全側の `ipad-portrait` を返す。
 */
export function resolveKioskLayout(viewport: Viewport): KioskLayout {
  const { width, height } = viewport;
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) {
    return 'ipad-portrait';
  }
  if (width >= LARGE_DISPLAY_MIN_WIDTH) {
    return 'large-display';
  }
  if (width >= height) {
    return 'ipad-landscape';
  }
  return 'ipad-portrait';
}
