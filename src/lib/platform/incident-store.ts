/**
 * プラットフォーム障害・インシデントのストア (issue #83 §6 / #90 increment 3e)。
 *
 * #274 ③ で §9 標準（docs/persistence-design.md）へ統合: 永続化は PlatformRecordRepository
 * （./repository.ts、getBackend() 委譲の単一実装）に閉じ、本ファイルはプロセス共有ファクトリ
 * （getIncidentRepository）と互換 API を担う。呼び出し側 route の変更は不要。
 *
 * `seed` は **memory バックエンド専用**（dev/test/デモ）であり、DynamoDB（本番）は無視する。
 * したがって本番では実際に登録された障害のみが見え、デモ用のダミー障害は出ない
 * （偽の「障害あり/なし」を見せない）。
 */
import type { Incident } from '@/domain/platform/incident';
import {
  DataBackedPlatformRecordRepository,
  PLATFORM_INCIDENT_COLLECTION,
  type PlatformRecordRepository,
} from './repository';

/** memory バックエンド専用のデモ用サンプル（本番 DynamoDB では無視される）。 */
function seed(): Incident[] {
  return [
    {
      id: 'inc-demo-1',
      scope: 'platform',
      severity: 'minor',
      status: 'monitoring',
      title: 'CloudFront 一部 POP で遅延',
      message: '一部地域で受付端末の初期描画に遅延。監視継続中。',
      startedAt: '2026-06-22T09:00:00.000Z',
      updatedBy: 'platform:demo',
    },
    {
      id: 'inc-demo-2',
      scope: 'tenant',
      tenantId: 'internal',
      severity: 'major',
      status: 'resolved',
      title: 'Vonage 通話接続失敗',
      message: '担当者呼び出しが一時的に失敗。資格情報の再設定で復旧。',
      startedAt: '2026-06-20T03:00:00.000Z',
      resolvedAt: '2026-06-20T04:30:00.000Z',
      updatedBy: 'platform:demo',
    },
  ];
}

let repository: PlatformRecordRepository<Incident> | undefined;

/** プロセス共有の Incident リポジトリ（§9.2 のファクトリ）。 */
export function getIncidentRepository(): PlatformRecordRepository<Incident> {
  if (!repository) {
    repository = new DataBackedPlatformRecordRepository<Incident>(
      PLATFORM_INCIDENT_COLLECTION,
      seed,
    );
  }
  return repository;
}

/** 全障害を返す（read-only）。並べ替え・集計は domain の summarizeIncidents に委譲する。 */
export async function listIncidents(): Promise<Incident[]> {
  return getIncidentRepository().list();
}

/**
 * 障害を登録する（破壊的操作。#83 AC7）。呼び出し側は **JIT 昇格ゲート（assertElevated）と監査**を
 * 通した後に呼ぶこと。id は呼び出し側で採番済み（buildIncident 済みの Incident を渡す）。
 */
export async function createIncident(incident: Incident): Promise<void> {
  await getIncidentRepository().create(incident);
}

/** テスト/seed 用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetIncidents(): Promise<void> {
  await getIncidentRepository().reset();
}
