/**
 * 拠点一覧の検索・フィルタ・CSV 純関数 (issue #330 item2 残増分)。
 *
 * 担当者一覧（`./staff-filter.ts`）と同じ流儀で、絞り込み/CSV 変換を副作用なしに実装する。
 * Site に PII は無い（`@/domain/tenant/types`）ため、CSV にも PII は含まれない。
 */
import type { SiteStatus } from '@/domain/tenant/types';
import type { SiteWithDevices } from '@/lib/tenant/site-service';
import { toCsv } from './list-io';

/** 拠点一覧の検索条件。未指定（undefined / 空文字）の項目は絞り込みに使わない。 */
export type SiteListFilter = {
  /** 拠点名への部分一致（大文字小文字を無視）。 */
  keyword?: string;
  status?: SiteStatus;
};

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/** 拠点 1 件がフィルタ条件をすべて満たすか（純関数）。 */
export function matchesSiteFilter(site: SiteWithDevices, filter: SiteListFilter): boolean {
  if (filter.keyword && filter.keyword.trim() !== '') {
    if (!norm(site.name).includes(norm(filter.keyword))) return false;
  }
  if (filter.status && site.status !== filter.status) return false;
  return true;
}

/** 拠点配列をフィルタする（順序は入力のまま保持）。 */
export function filterSites(
  sites: readonly SiteWithDevices[],
  filter: SiteListFilter,
): SiteWithDevices[] {
  return sites.filter((s) => matchesSiteFilter(s, filter));
}

const CSV_HEADER = ['拠点名', '状態', '端末数', 'オンライン端末数'];
const STATUS_LABEL: Record<SiteStatus, string> = { active: '有効', suspended: '停止中' };

/** 拠点一覧を CSV（ヘッダ行付き）へ変換する純関数。 */
export function sitesToCsv(sites: readonly SiteWithDevices[]): string {
  const rows = sites.map((s) => [
    s.name,
    STATUS_LABEL[s.status],
    String(s.deviceCount),
    String(s.onlineDeviceCount),
  ]);
  return toCsv(CSV_HEADER, rows);
}
