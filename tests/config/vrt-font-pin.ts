import { join } from 'node:path';

/**
 * VRT の撮影フォントを固定する (#1289)。
 *
 * linux の baseline は、`playwright install-deps` が入れるフォント群から **IPA ゴシックと
 * Unifont を除き**、fontconfig 既定の DejaVu を足した環境と同じ描画になる（どちらも install-deps が
 * 入れるが、入っていると baseline と合わない。実測は `docs/quality-gate.md`「VRT の撮影フォント」）。
 * Cloud の環境にはそのほかに Noto Sans CJK・システムの Inter などもあり、日本語のフォールバック先と
 * 合成ボールドの掛かり方が変わって VRT 14 件が落ちていた。
 *
 * `tests/e2e/fonts/fonts.conf` は**許可したディレクトリだけ**を読む fontconfig 設定で、
 * chromium にだけ `FONTCONFIG_FILE` として渡す（`playwright.config.ts`）。
 */

// `import.meta.dirname` は使えない —— playwright は config を CJS として読み込むので
// `Cannot use 'import.meta' outside a module` で e2e が全部起動しなくなる（vitest は両方通す）。
export const PINNED_FONTCONFIG_FILE = join(__dirname, '../e2e/fonts/fonts.conf');

/** 許可リストで見えていなければならないファミリー。1 つでも欠けると baseline と一致しない（実測）。 */
export const REQUIRED_FAMILIES = [
  'WenQuanYi Zen Hei',
  'DejaVu Sans',
  'Liberation Sans',
  'FreeSans',
  'Loma',
  'Noto Color Emoji',
] as const;

/**
 * 許可リストで見えてよいファミリーの**全部**。ここに無いファミリーが 1 つでも見えたら混入とみなす。
 *
 * 🔴 **禁止の列挙にしない。** 許可したディレクトリに別のパッケージがフォントを置く
 * （例: `fonts-noto-core` は Noto Sans を `truetype/noto` へ置き、`60-latin.conf` が sans-serif の
 * 先頭にする）と、禁止の一覧に無い名前で描画が変わる。知らないものは通さない。
 */
export const ALLOWED_FAMILIES: ReadonlySet<string> = new Set([
  'WenQuanYi Zen Hei',
  'WenQuanYi Zen Hei Mono',
  'WenQuanYi Zen Hei Sharp',
  'DejaVu Sans',
  'DejaVu Sans Mono',
  'DejaVu Serif',
  'Liberation Sans',
  'Liberation Mono',
  'Liberation Serif',
  'FreeSans',
  'FreeMono',
  'FreeSerif',
  'Loma',
  'Noto Color Emoji',
]);

/**
 * chromium の起動時に足す環境変数。
 *
 * darwin（CoreText）は fontconfig を読まないので何も足さない —— darwin の baseline は
 * この設定と無関係のまま。利用者が `FONTCONFIG_FILE` を明示したときはそちらを優先する。
 */
export function pinnedFontEnv(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): { FONTCONFIG_FILE?: string } {
  if (platform !== 'linux' || env.FONTCONFIG_FILE) return {};
  return { FONTCONFIG_FILE: PINNED_FONTCONFIG_FILE };
}

function familyLines(listing: string): string[][] {
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(',').map((name) => name.trim()));
}

/** `fc-list : family` の出力に無い必須ファミリー（別名のどれで出ていてもよい）。 */
export function missingPinnedFamilies(listing: string): string[] {
  const names = new Set(familyLines(listing).flat());
  return REQUIRED_FAMILIES.filter((family) => !names.has(family));
}

/** `fc-list : family` の出力のうち、許可していないファミリーの行（別名のどれも許可に無い）。 */
export function unexpectedFamilies(listing: string): string[] {
  return familyLines(listing)
    .filter((names) => !names.some((name) => ALLOWED_FAMILIES.has(name)))
    .map((names) => names.join(','));
}

/** 既に確かめたことを worker へ伝える環境変数（config は worker ごとに読まれ、worker は env を継ぐ）。 */
export const FONT_PIN_CHECKED_ENV = 'OPEN_RECEPTION_FONT_PIN_CHECKED';

/**
 * 撮影フォントが baseline の前提と食い違っていれば、その中身を名指しする警告を返す（無ければ null）。
 * **実行全体で 1 度だけ**確かめる（`env` に印を付ける）。`runFcList` には許可リストを渡した env を
 * 与える（system のフォントで数えると、Cloud では毎回偽の「混入」を出す）。
 *
 * VRT は許可リストのフォントが無ければ描画差で落ちる。その赤をコードの退行と見分けるための警告。
 */
export function checkPinnedFontsOnce(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  runFcList: (pinnedEnv: Record<string, string | undefined>) => string,
): string | null {
  const pinned = pinnedFontEnv(platform, env);
  if (!pinned.FONTCONFIG_FILE || env[FONT_PIN_CHECKED_ENV]) return null;
  env[FONT_PIN_CHECKED_ENV] = '1';
  let listing: string;
  try {
    listing = runFcList({ ...env, ...pinned });
  } catch {
    return '[vrt-font-pin] fc-list を実行できず、撮影フォントを確かめられませんでした（fontconfig パッケージが要ります）。';
  }
  const missing = missingPinnedFamilies(listing);
  const unexpected = unexpectedFamilies(listing);
  if (missing.length === 0 && unexpected.length === 0) return null;
  return (
    `[vrt-font-pin] 撮影フォントが baseline と一致しません（VRT は描画差で落ちます）。` +
    ` 不足: ${missing.join(' / ') || 'なし'}、混入: ${unexpected.join(' / ') || 'なし'}` +
    `（docs/quality-gate.md「VRT の撮影フォント」）`
  );
}
