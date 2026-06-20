/**
 * テナント基盤ストア / SiteService の組み立て (issue #87, increment 1; #80, increment 3)。
 *
 * route から使う TenantStore と SiteService を 1 つ生成して共有する。
 * inc3 で永続化を getBackend()（DATA_BACKEND=memory|dynamodb）ベースの DataBackedTenantStore へ
 * 移行した（admin-user-store.ts の流儀）。repository interface は維持しているため、
 * SiteService/DeviceService と既存テスト（memory backend）への影響はない。
 *
 * dev seed は単一テナント運用の互換（docs/multitenant-design.md §移行・互換）に合わせ、
 * `internal` テナント + `default-site` を初期投入し、既存 kiosk-dev に対応する Device を
 * 紐づける。seed は memory backend のみ有効（dynamodb では実データを正とし無視される）。
 * Device/kiosk の統合方針は docs/site-device-management-design.md。
 *
 * 監査は既存の appendAdminAudit（src/lib/mock-backend/reception-log-store.ts）を使い、
 * actor=admin・PII なしで記録する。
 */
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';
import {
  asDeviceId,
  asSiteId,
  asTenantId,
  type Device,
  type Site,
  type Tenant,
} from '@/domain/tenant/types';
import { DataBackedTenantStore, resetTenantCollections } from './data-repository';
import type { TenantStore } from './repository';
import { SiteService } from './site-service';
import { DeviceService } from './device-service';

/** 単一テナント運用の互換シード（#80 §移行・互換）。 */
const SEED_TENANTS: Tenant[] = [
  {
    id: asTenantId('internal'),
    name: '社内（既定テナント）',
    slug: 'internal',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const SEED_SITES: Site[] = [
  {
    id: asSiteId('default-site'),
    tenantId: asTenantId('internal'),
    name: '本社受付',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

// 既存 kiosk-dev（src/lib/kiosk/kiosk-store.ts の SEED）に対応する Device 表現。
const SEED_DEVICES: Device[] = [
  {
    id: asDeviceId('kiosk-dev'),
    tenantId: asTenantId('internal'),
    siteId: asSiteId('default-site'),
    name: '受付端末1',
    status: 'active',
    location: '1F エントランス',
    kind: 'kiosk',
    maintenance: false,
    tokenRegistered: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const SEED = { tenants: SEED_TENANTS, sites: SEED_SITES, devices: SEED_DEVICES };

let store: TenantStore | undefined;
let siteService: SiteService | undefined;
let deviceService: DeviceService | undefined;

export function getTenantStore(): TenantStore {
  if (!store) {
    store = new DataBackedTenantStore(SEED);
  }
  return store;
}

export function getSiteService(): SiteService {
  if (!siteService) {
    const s = getTenantStore();
    siteService = new SiteService({
      sites: s.sites,
      devices: s.devices,
      appendAudit: appendAdminAudit,
    });
  }
  return siteService;
}

export function getDeviceService(): DeviceService {
  if (!deviceService) {
    const s = getTenantStore();
    deviceService = new DeviceService({
      devices: s.devices,
      sites: s.sites,
      appendAudit: appendAdminAudit,
    });
  }
  return deviceService;
}

/**
 * テスト用: ストア（と in-memory データ）を破棄する。
 * getBackend() の Collection は name で共有されるため、seed 状態へ明示リセットする。
 */
export async function __resetTenantStore(): Promise<void> {
  await resetTenantCollections(SEED);
  store = undefined;
  siteService = undefined;
  deviceService = undefined;
}
