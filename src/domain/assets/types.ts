/**
 * 受付画面アセットのドメイン型 (issue #27)。
 * 背景画像・VRM モデル・モーション・fallback 静止画像を種別ごとに管理する。
 */
export type AssetKind = 'background' | 'vrm' | 'motion' | 'fallbackImage';

export type Asset = {
  id: string;
  kind: AssetKind;
  name: string;
  url: string;
  enabled: boolean;
  sizeBytes?: number;
};

/** 受付画面に適用するアセットセット（種別ごとに 1 つ選択）。 */
export type ActiveAssetSet = Partial<Record<AssetKind, string>>;

export const ALLOWED_EXTENSIONS: Record<AssetKind, string[]> = {
  background: ['png', 'jpg', 'jpeg', 'webp'],
  fallbackImage: ['png', 'jpg', 'jpeg', 'webp'],
  vrm: ['vrm'],
  motion: ['vrma', 'fbx', 'bvh'],
};

export const MAX_SIZE_BYTES: Record<AssetKind, number> = {
  background: 10 * 1024 * 1024,
  fallbackImage: 10 * 1024 * 1024,
  vrm: 50 * 1024 * 1024,
  motion: 20 * 1024 * 1024,
};

export function isAssetKind(value: unknown): value is AssetKind {
  return value === 'background' || value === 'vrm' || value === 'motion' || value === 'fallbackImage';
}

function extensionOf(url: string): string {
  const clean = url.split('?')[0]?.split('#')[0] ?? '';
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

/** アセットのファイル形式・サイズを検証する（純関数）。 */
export function validateAsset(kind: AssetKind, url: string, sizeBytes?: number): string | null {
  const ext = extensionOf(url);
  if (!ALLOWED_EXTENSIONS[kind].includes(ext)) {
    return `unsupported file type for ${kind}: .${ext || '(none)'}`;
  }
  if (typeof sizeBytes === 'number' && sizeBytes > MAX_SIZE_BYTES[kind]) {
    return `file too large for ${kind}: ${sizeBytes} bytes`;
  }
  return null;
}
