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

  console.log('Seeded base data: kiosk-dev, default background asset + active set.');

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
