/**
 * ブランディング設定のストア (issue #88)。既定は未設定（汎用テーマ）。
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 */
import {
  normalizeAccentColor,
  normalizeCompanyName,
  normalizeLogoUrl,
  type BrandingSettings,
} from '@/domain/branding/types';
import { getBackend } from '@/lib/data';

function defaults(): BrandingSettings {
  return {};
}

const branding = () => getBackend().singleton<BrandingSettings>('branding', { default: defaults });

async function current(): Promise<BrandingSettings> {
  return (await branding().get()) ?? defaults();
}

export async function getBrandingSettings(): Promise<BrandingSettings> {
  return { ...(await current()) };
}

/**
 * patch を検証して更新する。各フィールドは:
 *   - 妥当な値 → 設定する
 *   - 明示的な空文字 / null → クリア（undefined）
 *   - 不正な値（typo 等） → 無視（既存を温存）
 */
export async function updateBrandingSettings(patch: unknown): Promise<BrandingSettings> {
  const settings = await current();
  if (typeof patch === 'object' && patch !== null) {
    const o = patch as Record<string, unknown>;
    if ('accentColor' in o) settings.accentColor = resolve(o.accentColor, normalizeAccentColor, settings.accentColor);
    if ('logoUrl' in o) settings.logoUrl = resolve(o.logoUrl, normalizeLogoUrl, settings.logoUrl);
    if ('companyName' in o)
      settings.companyName = resolve(o.companyName, normalizeCompanyName, settings.companyName);
  }
  await branding().put(settings);
  return { ...settings };
}

/** 空/null はクリア、妥当なら採用、不正は現状維持。 */
function resolve(
  raw: unknown,
  normalize: (v: unknown) => string | undefined,
  currentValue: string | undefined,
): string | undefined {
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return undefined;
  return normalize(raw) ?? currentValue;
}

/** テスト用: 既定へ戻す。 */
export async function __resetBranding(): Promise<void> {
  await branding().reset();
}
