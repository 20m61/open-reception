import { join } from "node:path";

/**
 * VRT の撮影フォントを固定する (#1289)。
 *
 * linux の baseline は、`playwright install-deps` が入れるフォント群（WenQuanYi Zen Hei・
 * Liberation・FreeFont・Loma・Noto Color Emoji）と fontconfig 既定の DejaVu だけがある環境で
 * 撮られている。Cloud の環境にはそれ以外に IPA ゴシック・Noto Sans CJK・Unifont・システムの
 * Inter があり、日本語のフォールバック先と合成ボールドの掛かり方が変わって VRT 14 件が落ちていた。
 *
 * `tests/e2e/fonts/fonts.conf` は**許可したディレクトリだけ**を読む fontconfig 設定で、
 * chromium にだけ `FONTCONFIG_FILE` として渡す（`playwright.config.ts`）。どれを外すと何が
 * 落ちるかの実測は `docs/quality-gate.md`「VRT の撮影フォント」。
 */

// `import.meta.dirname` は使えない —— playwright は config を CJS として読み込むので
// `Cannot use 'import.meta' outside a module` で e2e が全部起動しなくなる（vitest は両方通す）。
export const PINNED_FONTCONFIG_FILE = join(
  __dirname,
  "../e2e/fonts/fonts.conf",
);

/** 許可リストで見えていなければならないファミリー。1 つでも欠けると baseline と一致しない（実測）。 */
export const REQUIRED_FAMILIES = [
  "WenQuanYi Zen Hei",
  "DejaVu Sans",
  "Liberation Sans",
  "FreeSans",
  "Loma",
  "Noto Color Emoji",
] as const;

/** 見えてはいけないファミリー。どれも baseline の描画を変える（実測）。 */
export const FORBIDDEN_FAMILY_PATTERNS: readonly RegExp[] = [
  /^IPA/,
  /Noto (Sans|Serif)( Mono)? CJK/,
  /^Unifont/,
  /^Inter(,|$| )/,
];

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
  if (platform !== "linux" || env.FONTCONFIG_FILE) return {};
  return { FONTCONFIG_FILE: PINNED_FONTCONFIG_FILE };
}

function familyLines(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** `fc-list : family` の出力に無い必須ファミリー。 */
export function missingPinnedFamilies(listing: string): string[] {
  const names = new Set(
    familyLines(listing).flatMap((line) =>
      line.split(",").map((n) => n.trim()),
    ),
  );
  return REQUIRED_FAMILIES.filter((family) => !names.has(family));
}

/** `fc-list : family` の出力のうち、見えてはいけないファミリーの行。 */
export function unexpectedFamilies(listing: string): string[] {
  return familyLines(listing).filter((line) =>
    FORBIDDEN_FAMILY_PATTERNS.some((pattern) => pattern.test(line)),
  );
}
