/**
 * プラットフォーム アップデート状況のストア (issue #83 AC6)。
 *
 * 永続化は data backend の collection に委譲する（docs/persistence-design.md）。
 * `seed` は **memory バックエンド専用**（dev/test/デモ）であり、DynamoDB（本番）は無視する。
 * したがって本番では実際に登録された状況のみが見え、デモ用のダミーは出ない
 * （偽の「更新待ち/最新」を見せない）。更新実行（デプロイ/ロールバック）は破壊的操作のため後段
 * 増分（JIT 昇格・理由入力・監査つき）で扱い、本モジュールは read のみを公開する。
 */
import type { UpdateStatus } from '@/domain/platform/update-status';
import { getBackend } from '@/lib/data';
import { PLATFORM_LIST_LIMIT } from './store-limits';

/** memory バックエンド専用のデモ用サンプル（本番 DynamoDB では無視される）。 */
function seed(): UpdateStatus[] {
  return [
    {
      id: 'upd-demo-platform',
      scope: 'platform',
      component: 'opennext',
      currentVersion: '3.2.0',
      latestVersion: '3.2.0',
      state: 'up_to_date',
      checkedAt: '2026-06-25T00:00:00.000Z',
      updatedBy: 'platform:demo',
    },
    {
      id: 'upd-demo-tenant',
      scope: 'tenant',
      tenantId: 'internal',
      component: 'kiosk-app',
      currentVersion: '1.4.0',
      latestVersion: '1.5.0',
      state: 'update_available',
      checkedAt: '2026-06-24T00:00:00.000Z',
      updatedBy: 'platform:demo',
    },
    {
      id: 'upd-demo-device',
      scope: 'device',
      tenantId: 'internal',
      siteId: 'default-site',
      deviceId: 'kiosk-dev',
      component: 'firmware',
      currentVersion: '2.0.1',
      latestVersion: '2.1.0',
      state: 'failed',
      checkedAt: '2026-06-23T00:00:00.000Z',
      updatedBy: 'platform:demo',
    },
  ];
}

const collection = () => getBackend().collection<UpdateStatus>('platform_update_status', { seed });

/** 全アップデート状況を返す（read-only）。並べ替え・集計は domain の summarizeUpdateStatuses に委譲。 */
export async function listUpdateStatuses(): Promise<UpdateStatus[]> {
  return collection().list({ limit: PLATFORM_LIST_LIMIT });
}

/** テスト/seed 用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetUpdateStatuses(): Promise<void> {
  await collection().reset();
}
