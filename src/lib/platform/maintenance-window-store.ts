/**
 * 予定メンテナンス（MaintenanceWindow）のストア (issue #83 §8 / #90 increment 3e)。
 *
 * #274 ③ で §9 標準（docs/persistence-design.md）へ統合: 永続化は PlatformRecordRepository
 * （./repository.ts、getBackend() 委譲の単一実装）に閉じ、本ファイルはプロセス共有ファクトリ
 * （getMaintenanceWindowRepository）と互換 API を担う。呼び出し側 route の変更は不要。
 *
 * `seed` は **memory バックエンド専用**（dev/test/デモ）であり、DynamoDB（本番）は無視する。
 * したがって本番では実際に登録された予定のみが見え、デモ用のダミー予定は出ない。
 */
import type { MaintenanceWindow } from '@/domain/platform/maintenance-window';
import {
  DataBackedPlatformRecordRepository,
  PLATFORM_MAINTENANCE_WINDOW_COLLECTION,
  type PlatformRecordRepository,
} from './repository';

/** memory バックエンド専用のデモ用サンプル（本番 DynamoDB では無視される）。 */
function seed(): MaintenanceWindow[] {
  return [
    {
      id: 'mw-demo-1',
      scope: 'platform',
      status: 'scheduled',
      startsAt: '2026-07-01T15:00:00.000Z',
      endsAt: '2026-07-01T16:00:00.000Z',
      message: '定期メンテナンス（受付は読み取り専用）。',
      impact: 'read_only',
      createdBy: 'platform:demo',
      updatedAt: '2026-06-20T00:00:00.000Z',
    },
  ];
}

let repository: PlatformRecordRepository<MaintenanceWindow> | undefined;

/** プロセス共有の MaintenanceWindow リポジトリ（§9.2 のファクトリ）。 */
export function getMaintenanceWindowRepository(): PlatformRecordRepository<MaintenanceWindow> {
  if (!repository) {
    repository = new DataBackedPlatformRecordRepository<MaintenanceWindow>(
      PLATFORM_MAINTENANCE_WINDOW_COLLECTION,
      seed,
    );
  }
  return repository;
}

/** 全予定メンテナンスを返す（read-only）。並べ替え・集計は domain に委譲する。 */
export async function listMaintenanceWindows(): Promise<MaintenanceWindow[]> {
  return getMaintenanceWindowRepository().list();
}

/**
 * メンテナンスを登録する（破壊的操作。#83 メンテナンスウィンドウ管理）。呼び出し側は **JIT 昇格
 * ゲート（assertElevated）と監査**を通した後に呼ぶこと。id は呼び出し側で採番済み。
 */
export async function createMaintenanceWindow(window: MaintenanceWindow): Promise<void> {
  await getMaintenanceWindowRepository().create(window);
}

/** テスト/seed 用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetMaintenanceWindows(): Promise<void> {
  await getMaintenanceWindowRepository().reset();
}
