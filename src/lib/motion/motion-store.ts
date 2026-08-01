/**
 * モーション割り当てのストア (issue #31)。
 * 受付状態キーごとに、登録済みのモーションアセット（#27）を割り当てる。
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 */
import { isMotionKey, type MotionKey, type MotionMapping } from '@/domain/motion/types';
import { listAssets } from '@/lib/assets/asset-store';
import { getBackend } from '@/lib/data';
import { tenantScopedStoreKey } from '@/domain/tenant/store-key';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';

export type StoreError = { code: 'not_found' | 'invalid_input'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

type MotionConfig = { mapping: MotionMapping; defaultMotionAssetId?: string };

/**
 * **テナント別に保持する** (#419 残増分)。既定テナントは従来キー据え置きなので移行不要。
 */
const motion = (tenantId: string) =>
  getBackend().singleton<MotionConfig>(
    tenantScopedStoreKey('motionMapping', tenantId, defaultTenantIdFrom()),
    { default: () => ({ mapping: {} }) },
  );

async function getConfig(tenantId: string): Promise<MotionConfig> {
  return (await motion(tenantId).get()) ?? { mapping: {} };
}

async function isMotionAsset(tenantId: string, assetId: string): Promise<boolean> {
  return (await listAssets(tenantId, 'motion')).some((a) => a.id === assetId && a.enabled);
}

export async function getMotionMapping(tenantId: string): Promise<{ mapping: MotionMapping; defaultMotionAssetId?: string }> {
  const config = await getConfig(tenantId);
  return { mapping: { ...config.mapping }, defaultMotionAssetId: config.defaultMotionAssetId };
}

/** キーにモーションアセットを割り当てる（null で解除）。 */
export async function setMotion(tenantId: string, key: string, assetId: string | null): Promise<Result<MotionMapping>> {
  if (!isMotionKey(key)) return { ok: false, error: { code: 'invalid_input', message: 'invalid motion key' } };
  const config = await getConfig(tenantId);
  if (assetId === null) {
    delete config.mapping[key];
    await motion(tenantId).put(config);
    return { ok: true, value: { ...config.mapping } };
  }
  if (!(await isMotionAsset(tenantId, assetId))) {
    return { ok: false, error: { code: 'invalid_input', message: 'assetId is not an enabled motion asset' } };
  }
  config.mapping[key] = assetId;
  await motion(tenantId).put(config);
  return { ok: true, value: { ...config.mapping } };
}

export async function setDefaultMotion(tenantId: string, assetId: string | null): Promise<Result<void>> {
  const config = await getConfig(tenantId);
  if (assetId === null) {
    config.defaultMotionAssetId = undefined;
    await motion(tenantId).put(config);
    return { ok: true, value: undefined };
  }
  if (!(await isMotionAsset(tenantId, assetId))) {
    return { ok: false, error: { code: 'invalid_input', message: 'assetId is not an enabled motion asset' } };
  }
  config.defaultMotionAssetId = assetId;
  await motion(tenantId).put(config);
  return { ok: true, value: undefined };
}

/** 受付端末向け: キー→アセット URL の解決済みマップを返す。 */
export async function getKioskMotions(tenantId: string): Promise<{ motions: Partial<Record<MotionKey, string>>; defaultUrl?: string }> {
  const [config, motionAssets] = await Promise.all([
    getConfig(tenantId),
    listAssets(tenantId, 'motion').then((list) => list.filter((a) => a.enabled)),
  ]);
  const urlOf = (assetId?: string) => motionAssets.find((a) => a.id === assetId)?.url;
  const motions: Partial<Record<MotionKey, string>> = {};
  (Object.keys(config.mapping) as MotionKey[]).forEach((key) => {
    const url = urlOf(config.mapping[key]);
    if (url) motions[key] = url;
  });
  return { motions, defaultUrl: urlOf(config.defaultMotionAssetId) };
}

/** テスト用: 初期化する。 */
export async function __resetMotions(tenantId: string = defaultTenantIdFrom()): Promise<void> {
  await motion(tenantId).reset();
}
