/**
 * モーション割り当ての in-memory ストア (issue #31)。
 * 受付状態キーごとに、登録済みのモーションアセット（#27）を割り当てる。
 */
import { isMotionKey, type MotionKey, type MotionMapping } from '@/domain/motion/types';
import { listAssets } from '@/lib/assets/asset-store';

export type StoreError = { code: 'not_found' | 'invalid_input'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

let mapping: MotionMapping = {};
let defaultMotionAssetId: string | undefined;

function isMotionAsset(assetId: string): boolean {
  return listAssets('motion').some((a) => a.id === assetId && a.enabled);
}

export function getMotionMapping(): { mapping: MotionMapping; defaultMotionAssetId?: string } {
  return { mapping: { ...mapping }, defaultMotionAssetId };
}

/** キーにモーションアセットを割り当てる（null で解除）。 */
export function setMotion(key: string, assetId: string | null): Result<MotionMapping> {
  if (!isMotionKey(key)) return { ok: false, error: { code: 'invalid_input', message: 'invalid motion key' } };
  if (assetId === null) {
    delete mapping[key];
    return { ok: true, value: { ...mapping } };
  }
  if (!isMotionAsset(assetId)) {
    return { ok: false, error: { code: 'invalid_input', message: 'assetId is not an enabled motion asset' } };
  }
  mapping[key] = assetId;
  return { ok: true, value: { ...mapping } };
}

export function setDefaultMotion(assetId: string | null): Result<void> {
  if (assetId === null) {
    defaultMotionAssetId = undefined;
    return { ok: true, value: undefined };
  }
  if (!isMotionAsset(assetId)) {
    return { ok: false, error: { code: 'invalid_input', message: 'assetId is not an enabled motion asset' } };
  }
  defaultMotionAssetId = assetId;
  return { ok: true, value: undefined };
}

/** 受付端末向け: キー→アセット URL の解決済みマップを返す。 */
export function getKioskMotions(): { motions: Partial<Record<MotionKey, string>>; defaultUrl?: string } {
  const motionAssets = listAssets('motion').filter((a) => a.enabled);
  const urlOf = (assetId?: string) => motionAssets.find((a) => a.id === assetId)?.url;
  const motions: Partial<Record<MotionKey, string>> = {};
  (Object.keys(mapping) as MotionKey[]).forEach((key) => {
    const url = urlOf(mapping[key]);
    if (url) motions[key] = url;
  });
  return { motions, defaultUrl: urlOf(defaultMotionAssetId) };
}

/** テスト用: 初期化する。 */
export function __resetMotions(): void {
  mapping = {};
  defaultMotionAssetId = undefined;
}
