/**
 * プラットフォーム アップデート状況のストア (issue #83 AC6)。
 *
 * #274 ③ で §9 標準（docs/persistence-design.md）へ統合: 永続化は PlatformRecordRepository
 * （./repository.ts、getBackend() 委譲の単一実装）に閉じ、本ファイルはプロセス共有ファクトリ
 * （getUpdateStatusRepository）と互換 API を担う。呼び出し側 route の変更は不要。
 *
 * `seed` は **memory バックエンド専用**（dev/test/デモ）であり、DynamoDB（本番）は無視する。
 * したがって本番では実際に登録された状況のみが見え、デモ用のダミーは出ない
 * （偽の「更新待ち/最新」を見せない）。更新実行（デプロイ/ロールバック）は破壊的操作のため JIT 昇格・
 * 理由入力・監査つきの route（/api/platform/updates/[id]/execute, #290 item1）で扱う。本モジュールは
 * read（listUpdateStatuses）と、実行後の状態遷移を反映する putUpdateStatus を公開する。
 */
import type { UpdateStatus } from '@/domain/platform/update-status';
import {
  DataBackedPlatformRecordRepository,
  PLATFORM_UPDATE_STATUS_COLLECTION,
  type PlatformRecordRepository,
} from './repository';

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

let repository: PlatformRecordRepository<UpdateStatus> | undefined;

/** プロセス共有の UpdateStatus リポジトリ（§9.2 のファクトリ）。 */
export function getUpdateStatusRepository(): PlatformRecordRepository<UpdateStatus> {
  if (!repository) {
    repository = new DataBackedPlatformRecordRepository<UpdateStatus>(
      PLATFORM_UPDATE_STATUS_COLLECTION,
      seed,
    );
  }
  return repository;
}

/** 全アップデート状況を返す（read-only）。並べ替え・集計は domain の summarizeUpdateStatuses に委譲。 */
export async function listUpdateStatuses(): Promise<UpdateStatus[]> {
  return getUpdateStatusRepository().list();
}

/**
 * アップデート状況を保存する（put/upsert）。更新実行/ロールバック後の状態遷移を反映する
 * (issue #290 item1)。id 一致で置換する（PlatformRecordRepository.create は put 相当）。
 */
export async function putUpdateStatus(status: UpdateStatus): Promise<void> {
  await getUpdateStatusRepository().create(status);
}

/** テスト/seed 用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetUpdateStatuses(): Promise<void> {
  await getUpdateStatusRepository().reset();
}
