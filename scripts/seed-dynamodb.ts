#!/usr/bin/env tsx
/**
 * DynamoDB の初期データ投入 (docs/persistence-design.md §6)。
 *
 * 受付端末が初期状態で動作するための最小データ（端末・既定背景アセット）を投入する。
 * 設定系（security/voice/motion/activeAssets）はアプリ側が DEFAULTS にフォールバックするため
 * 必須ではないが、アクティブ背景アセットだけは明示する。
 *
 * 使い方（リポジトリルート）:
 *   DATA_BACKEND=dynamodb \
 *   TABLE_NAME=<WebStack の DataTableName 出力> \
 *   AWS_REGION=ap-northeast-1 \
 *     npm run seed:dynamodb -- [--with-mock]
 *
 *   --with-mock : デモ用に架空の部署・担当者も投入する（本番では付けない）。
 *
 * 冪等。既存 id は上書きされる。
 */
import { getBackend } from '../src/lib/data';
import type { Kiosk } from '@/domain/kiosk/types';
import type { Asset, ActiveAssetSet } from '@/domain/assets/types';
import type { Department } from '@/domain/department/types';
import type { Staff } from '@/domain/staff/types';
import type { Tenant, Site, Device } from '@/domain/tenant/types';
import { SEED as TENANT_SEED } from '@/lib/tenant/store';
import {
  TENANT_COLLECTION,
  SITE_COLLECTION,
  DEVICE_COLLECTION,
  DEVICE_COLLECTION_OPTS,
} from '@/lib/tenant/data-repository';

async function main(): Promise<void> {
  // 安全側に倒して DynamoDB を明示する（誤って memory に投入しない）。
  process.env.DATA_BACKEND = 'dynamodb';
  if (!process.env.TABLE_NAME) {
    console.error('TABLE_NAME env var is required (WebStack の DataTableName 出力を指定).');
    process.exit(1);
  }

  const backend = getBackend();

  await backend.collection<Kiosk>('kiosk').put({
    id: 'kiosk-dev',
    displayName: '受付端末1',
    location: '本社1Fエントランス',
    enabled: true,
  });

  await backend.collection<Asset>('asset').put({
    id: 'asset-bg-default',
    kind: 'background',
    name: '既定の背景',
    url: '/assets/default-bg.png',
    enabled: true,
  });
  await backend.singleton<ActiveAssetSet>('activeAssets').put({ background: 'asset-bg-default' });

  // テナント境界（#87）の既定 tenant/site/device を投入する。memory backend は store の SEED が
  // 自動投入するが dynamodb は無視するため、ここで同じ定義を書き込み /admin/sites・/admin/devices を
  // 初期から使えるようにする（未投入だと device 作成が 404 "site not found" になる）。
  for (const t of TENANT_SEED.tenants) await backend.collection<Tenant>(TENANT_COLLECTION).put({ ...t });
  for (const s of TENANT_SEED.sites) await backend.collection<Site>(SITE_COLLECTION).put({ ...s });
  // DEVICE_COLLECTION_OPTS（indexedField=tenantId）を共有し、put が GSI1 キーを書く（#274/#284）。
  // 既存 device の backfill（境界クエリに現れない sparse index の解消）も seed 再実行で行える。
  for (const d of TENANT_SEED.devices)
    await backend.collection<Device>(DEVICE_COLLECTION, DEVICE_COLLECTION_OPTS).put({ ...d });

  console.log(
    `Seeded base data: kiosk-dev, default background asset + active set, ` +
      `tenant/site/device (${TENANT_SEED.tenants.length}/${TENANT_SEED.sites.length}/${TENANT_SEED.devices.length}).`,
  );

  if (process.argv.includes('--with-mock')) {
    const { MOCK_DEPARTMENTS, MOCK_STAFF } = await import('../src/domain/staff/mock-data');
    for (const d of MOCK_DEPARTMENTS) await backend.collection<Department>('department').put({ ...d });
    for (const s of MOCK_STAFF)
      await backend.collection<Staff>('staff').put({ ...s, aliases: [...s.aliases] });
    console.log(
      `Seeded mock data: ${MOCK_DEPARTMENTS.length} departments, ${MOCK_STAFF.length} staff.`,
    );
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
