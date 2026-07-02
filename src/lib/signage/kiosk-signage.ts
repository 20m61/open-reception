/**
 * 受付端末向けサイネージ取得 (issue #101, increment 1)。
 *
 * 端末（kiosk）はテナント/サイトのスコープで、待機画面に出す「再生可能な」項目だけを
 * 取得する。admin 認可は通さない（端末は #18/#29 の端末認可で別途守られる前提）が、
 * PII は元々設定に含まれないため越境以外の漏えい面はない。
 *
 * 無効（enabled=false）や内容不備の項目は除外し、設定全体が無効なら空を返す。
 * これにより待機画面は「出せるものだけ」を安全に巡回できる（読み込み失敗時も壊れない）。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { SignageContentType } from '@/domain/signage/types';
import { playableItems } from '@/domain/signage/rotation';
import { DataBackedSignageRepository, type SignageRepository } from './repository';

/** 端末へ返す 1 項目（id を伏せ、表示に必要な最小限のみ）。 */
export type KioskSignageItem = {
  type: SignageContentType;
  title?: string;
  message?: string;
  imageUrl?: string;
  imageAlt?: string;
  slideUrls?: string[];
  durationSeconds: number;
};

export type KioskSignage = {
  enabled: boolean;
  defaultIntervalSeconds: number;
  items: KioskSignageItem[];
};

/** 端末向けの再生可能なサイネージを返す。設定なし/無効なら enabled=false + 空配列。 */
export async function getKioskSignage(
  tenantId: TenantId,
  siteId: SiteId,
  repo: SignageRepository = new DataBackedSignageRepository(),
): Promise<KioskSignage> {
  const config = await repo.get(tenantId, siteId);
  if (!config || !config.enabled) {
    return { enabled: false, defaultIntervalSeconds: 10, items: [] };
  }
  const items: KioskSignageItem[] = playableItems(config).map((item) => ({
    type: item.type,
    title: item.title,
    message: item.message,
    imageUrl: item.imageUrl,
    imageAlt: item.imageAlt,
    slideUrls: item.slideUrls,
    durationSeconds: item.durationSeconds ?? config.defaultIntervalSeconds,
  }));
  return {
    enabled: items.length > 0,
    defaultIntervalSeconds: config.defaultIntervalSeconds,
    items,
  };
}
