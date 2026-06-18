/**
 * アセットの in-memory ストア (issue #27)。登録・有効/無効・アクティブ選択を扱う。
 * 実ファイルのアップロードは storage adapter（本番で S3 等）に委ねる前提で、
 * ここでは URL/メタデータで登録する。
 */
import {
  isAssetKind,
  validateAsset,
  type ActiveAssetSet,
  type Asset,
  type AssetKind,
} from '@/domain/assets/types';

export type StoreError = { code: 'not_found' | 'invalid_input'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

const SEED: Asset[] = [
  { id: 'asset-bg-default', kind: 'background', name: '既定の背景', url: '/assets/default-bg.png', enabled: true },
];

let assets: Asset[] = SEED.map((a) => ({ ...a }));
let active: ActiveAssetSet = { background: 'asset-bg-default' };

function err(code: StoreError['code'], message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

export function listAssets(kind?: AssetKind): Asset[] {
  return assets.filter((a) => (kind ? a.kind === kind : true));
}

export function createAsset(input: unknown): Result<Asset> {
  if (typeof input !== 'object' || input === null) return err('invalid_input', 'body must be an object');
  const o = input as Record<string, unknown>;
  if (!isAssetKind(o.kind)) return err('invalid_input', 'invalid kind');
  if (typeof o.name !== 'string' || o.name.trim() === '') return err('invalid_input', 'name is required');
  if (typeof o.url !== 'string' || o.url.trim() === '') return err('invalid_input', 'url is required');
  const sizeBytes = typeof o.sizeBytes === 'number' ? o.sizeBytes : undefined;
  const invalid = validateAsset(o.kind, o.url, sizeBytes);
  if (invalid) return err('invalid_input', invalid);
  const asset: Asset = {
    id: `asset-${Math.random().toString(36).slice(2, 8)}`,
    kind: o.kind,
    name: o.name.trim(),
    url: o.url.trim(),
    enabled: true,
    sizeBytes,
  };
  assets.push(asset);
  return { ok: true, value: asset };
}

export function setAssetEnabled(id: string, enabled: boolean): Result<Asset> {
  const found = assets.find((a) => a.id === id);
  if (!found) return err('not_found', 'asset not found');
  found.enabled = enabled;
  if (!enabled && active[found.kind] === id) delete active[found.kind];
  return { ok: true, value: found };
}

/** アセットセットに種別ごとのアクティブアセットを設定する。 */
export function setActiveAsset(id: string): Result<Asset> {
  const found = assets.find((a) => a.id === id);
  if (!found) return err('not_found', 'asset not found');
  if (!found.enabled) return err('invalid_input', 'cannot activate a disabled asset');
  active[found.kind] = id;
  return { ok: true, value: found };
}

export function getActiveAssets(): ActiveAssetSet {
  return { ...active };
}

/** 受付端末向け: アクティブな背景・fallback 画像・VRM の URL を返す。 */
export function getKioskAssets(): { backgroundUrl?: string; fallbackImageUrl?: string; vrmUrl?: string } {
  const resolve = (kind: AssetKind): string | undefined => {
    const id = active[kind];
    const asset = id ? assets.find((a) => a.id === id && a.enabled) : undefined;
    return asset?.url;
  };
  return { backgroundUrl: resolve('background'), fallbackImageUrl: resolve('fallbackImage'), vrmUrl: resolve('vrm') };
}

/** テスト用: seed 状態へ戻す。 */
export function __resetAssets(): void {
  assets = SEED.map((a) => ({ ...a }));
  active = { background: 'asset-bg-default' };
}
