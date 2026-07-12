/**
 * 受付端末一覧の検索・フィルタ・CSV 純関数 (issue #330 item2 残増分)。
 *
 * 担当者一覧（`./staff-filter.ts`）と同じ流儀で、絞り込み/CSV 変換を副作用なしに実装する。
 * Device に PII は無い（`@/domain/tenant/types`）ため、CSV にも PII は含まれない。token 平文は
 * `DeviceView` 自体が保持しないため CSV にも出力されない（`tokenRegistered` の真偽のみ）。
 */
import type { DeviceKind } from '@/domain/tenant/types';
import type { DeviceConnectivity, DeviceView } from '@/lib/tenant/device-service';
import { toCsv } from './list-io';

/** 受付端末一覧の検索条件。未指定（undefined / 空文字）の項目は絞り込みに使わない。 */
export type DeviceListFilter = {
  /** 端末名・設置場所への部分一致（大文字小文字を無視）。 */
  keyword?: string;
  connectivity?: DeviceConnectivity;
  kind?: DeviceKind;
};

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/** 端末 1 件がフィルタ条件をすべて満たすか（純関数）。 */
export function matchesDeviceFilter(device: DeviceView, filter: DeviceListFilter): boolean {
  if (filter.keyword && filter.keyword.trim() !== '') {
    const haystack = norm(`${device.name} ${device.location ?? ''}`);
    if (!haystack.includes(norm(filter.keyword))) return false;
  }
  if (filter.connectivity && device.connectivity !== filter.connectivity) return false;
  if (filter.kind && (device.kind ?? 'kiosk') !== filter.kind) return false;
  return true;
}

/** 端末配列をフィルタする（順序は入力のまま保持）。 */
export function filterDevices(
  devices: readonly DeviceView[],
  filter: DeviceListFilter,
): DeviceView[] {
  return devices.filter((d) => matchesDeviceFilter(d, filter));
}

const CSV_HEADER = ['端末名', '設置場所', '種別', '稼働状態', '最終接続', 'token'];
const KIND_LABEL: Record<DeviceKind, string> = { kiosk: '据置端末', tablet: 'タブレット', desktop: 'デスクトップ' };
const CONNECTIVITY_LABEL: Record<DeviceConnectivity, string> = {
  online: 'オンライン',
  offline: 'オフライン',
  maintenance: 'メンテナンス中',
  disabled: '無効',
};

/** 受付端末一覧を CSV（ヘッダ行付き）へ変換する純関数。token 平文は含まれない。 */
export function devicesToCsv(devices: readonly DeviceView[]): string {
  const rows = devices.map((d) => [
    d.name,
    d.location ?? '',
    KIND_LABEL[d.kind ?? 'kiosk'],
    CONNECTIVITY_LABEL[d.connectivity],
    d.lastSeenAt ?? '',
    d.tokenRegistered ? '登録済み' : '未登録',
  ]);
  return toCsv(CSV_HEADER, rows);
}
