/**
 * 予定メンテナンス（MaintenanceWindow）のストア (issue #83 §8 / #90 increment 3e)。
 *
 * 永続化は data backend の collection に委譲する。`seed` は **memory バックエンド専用**（dev/test/
 * デモ）であり、DynamoDB（本番）は無視する。したがって本番では実際に登録された予定のみが見え、
 * デモ用のダミー予定は出ない。登録/状態変更（書き込み）は破壊的操作のため後段増分（JIT 昇格・
 * 理由入力・監査つき）で実装する。本モジュールは read のみを公開する。
 */
import type { MaintenanceWindow } from '@/domain/platform/maintenance-window';
import { getBackend } from '@/lib/data';

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

const collection = () =>
  getBackend().collection<MaintenanceWindow>('platform_maintenance_windows', { seed });

/** 全予定メンテナンスを返す（read-only）。並べ替え・集計は domain に委譲する。 */
export async function listMaintenanceWindows(): Promise<MaintenanceWindow[]> {
  return collection().list();
}

/**
 * メンテナンスを登録する（破壊的操作。#83 メンテナンスウィンドウ管理）。呼び出し側は **JIT 昇格
 * ゲート（assertElevated）と監査**を通した後に呼ぶこと。id は呼び出し側で採番済み。
 */
export async function createMaintenanceWindow(window: MaintenanceWindow): Promise<void> {
  await collection().put(window);
}

/** テスト/seed 用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetMaintenanceWindows(): Promise<void> {
  await collection().reset();
}
