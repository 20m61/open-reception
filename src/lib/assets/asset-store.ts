/**
 * アセットのストア (issue #27)。登録・有効/無効・アクティブ選択を扱う。
 * 実ファイルのアップロードは storage adapter（本番で S3 等）に委ねる前提で、
 * ここでは URL/メタデータで登録する。
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 */
import {
  isAssetKind,
  validateAsset,
  type ActiveAssetSet,
  type Asset,
  type AssetKind,
} from '@/domain/assets/types';
import { getBackend } from '@/lib/data';

export type StoreError = { code: 'not_found' | 'invalid_input'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

const SEED: Asset[] = [
  { id: 'asset-bg-default', kind: 'background', name: '既定の背景', url: '/assets/default-bg.jpg', enabled: true },
];
const DEFAULT_ACTIVE: ActiveAssetSet = { background: 'asset-bg-default' };

const assets = () =>
  getBackend().collection<Asset>('asset', { seed: () => SEED.map((a) => ({ ...a })) });
const activeSet = () =>
  getBackend().singleton<ActiveAssetSet>('activeAssets', { default: () => ({ ...DEFAULT_ACTIVE }) });

function err(code: StoreError['code'], message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

async function getActive(): Promise<ActiveAssetSet> {
  return (await activeSet().get()) ?? { ...DEFAULT_ACTIVE };
}

export async function listAssets(kind?: AssetKind): Promise<Asset[]> {
  const all = await assets().list();
  return all.filter((a) => (kind ? a.kind === kind : true));
}

export async function createAsset(input: unknown): Promise<Result<Asset>> {
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
  await assets().put(asset);
  return { ok: true, value: asset };
}

export async function setAssetEnabled(id: string, enabled: boolean): Promise<Result<Asset>> {
  const found = await assets().get(id);
  if (!found) return err('not_found', 'asset not found');
  found.enabled = enabled;
  await assets().put(found);
  if (!enabled) {
    const active = await getActive();
    if (active[found.kind] === id) {
      delete active[found.kind];
      await activeSet().put(active);
    }
  }
  return { ok: true, value: found };
}

/** アセットセットに種別ごとのアクティブアセットを設定する。 */
export async function setActiveAsset(id: string): Promise<Result<Asset>> {
  const found = await assets().get(id);
  if (!found) return err('not_found', 'asset not found');
  if (!found.enabled) return err('invalid_input', 'cannot activate a disabled asset');
  const active = await getActive();
  active[found.kind] = id;
  await activeSet().put(active);
  return { ok: true, value: found };
}

export async function getActiveAssets(): Promise<ActiveAssetSet> {
  return getActive();
}

/**
 * 既定 VRM モデルの URL（純関数）。管理画面で VRM アセットを未登録/未選択でも、
 * 環境変数 `KIOSK_DEFAULT_VRM_URL` を設定しておけば受付端末にアバターを表示できる (issue #31)。
 * - 空文字 / 'none' / 'off' で明示的に無効化できる。
 * - 未設定なら undefined（VRM 無し＝従来どおりプレースホルダ）。
 * モデルファイルは `public/avatar/` 等に置き、ライセンス（#105）を満たすものを使う。
 */
export function defaultVrmUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.KIOSK_DEFAULT_VRM_URL;
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === '' || v === 'none' || v === 'off') return undefined;
  return v;
}

/** 受付端末向け: アクティブな背景・fallback 画像・VRM の URL を返す。 */
export async function getKioskAssets(): Promise<{ backgroundUrl?: string; fallbackImageUrl?: string; vrmUrl?: string }> {
  const [all, active] = await Promise.all([assets().list(), getActive()]);
  const resolve = (kind: AssetKind): string | undefined => {
    const id = active[kind];
    const asset = id ? all.find((a) => a.id === id && a.enabled) : undefined;
    return asset?.url;
  };
  // 管理画面で選択された VRM を優先し、無ければ環境変数の既定モデルへ fallback する。
  return {
    backgroundUrl: resolve('background'),
    fallbackImageUrl: resolve('fallbackImage'),
    vrmUrl: resolve('vrm') ?? defaultVrmUrl(),
  };
}

/** テスト用: seed 状態へ戻す。 */
export async function __resetAssets(): Promise<void> {
  await Promise.all([assets().reset(), activeSet().reset()]);
}
