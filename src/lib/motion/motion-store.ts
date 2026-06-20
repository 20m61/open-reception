/**
 * モーション割り当てのストア (issue #31)。
 * 受付状態キーごとに、登録済みのモーションアセット（#27）を割り当てる。
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 */
import { isMotionKey, type MotionKey, type MotionMapping } from '@/domain/motion/types';
import { listAssets } from '@/lib/assets/asset-store';
import { getBackend } from '@/lib/data';

export type StoreError = { code: 'not_found' | 'invalid_input'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

type MotionConfig = { mapping: MotionMapping; defaultMotionAssetId?: string };

const motion = () =>
  getBackend().singleton<MotionConfig>('motionMapping', { default: () => ({ mapping: {} }) });

async function getConfig(): Promise<MotionConfig> {
  return (await motion().get()) ?? { mapping: {} };
}

async function isMotionAsset(assetId: string): Promise<boolean> {
  return (await listAssets('motion')).some((a) => a.id === assetId && a.enabled);
}

export async function getMotionMapping(): Promise<{ mapping: MotionMapping; defaultMotionAssetId?: string }> {
  const config = await getConfig();
  return { mapping: { ...config.mapping }, defaultMotionAssetId: config.defaultMotionAssetId };
}

/** キーにモーションアセットを割り当てる（null で解除）。 */
export async function setMotion(key: string, assetId: string | null): Promise<Result<MotionMapping>> {
  if (!isMotionKey(key)) return { ok: false, error: { code: 'invalid_input', message: 'invalid motion key' } };
  const config = await getConfig();
  if (assetId === null) {
    delete config.mapping[key];
    await motion().put(config);
    return { ok: true, value: { ...config.mapping } };
  }
  if (!(await isMotionAsset(assetId))) {
    return { ok: false, error: { code: 'invalid_input', message: 'assetId is not an enabled motion asset' } };
  }
  config.mapping[key] = assetId;
  await motion().put(config);
  return { ok: true, value: { ...config.mapping } };
}

export async function setDefaultMotion(assetId: string | null): Promise<Result<void>> {
  const config = await getConfig();
  if (assetId === null) {
    config.defaultMotionAssetId = undefined;
    await motion().put(config);
    return { ok: true, value: undefined };
  }
  if (!(await isMotionAsset(assetId))) {
    return { ok: false, error: { code: 'invalid_input', message: 'assetId is not an enabled motion asset' } };
  }
  config.defaultMotionAssetId = assetId;
  await motion().put(config);
  return { ok: true, value: undefined };
}

/** 受付端末向け: キー→アセット URL の解決済みマップを返す。 */
export async function getKioskMotions(): Promise<{ motions: Partial<Record<MotionKey, string>>; defaultUrl?: string }> {
  const [config, motionAssets] = await Promise.all([
    getConfig(),
    listAssets('motion').then((list) => list.filter((a) => a.enabled)),
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
export async function __resetMotions(): Promise<void> {
  await motion().reset();
}
