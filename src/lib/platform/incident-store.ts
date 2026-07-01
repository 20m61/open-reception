/**
 * プラットフォーム障害・インシデントのストア (issue #83 §6 / #90 increment 3e)。
 *
 * 永続化は data backend の collection に委譲する（docs/persistence-design.md）。
 * `seed` は **memory バックエンド専用**（dev/test/デモ）であり、DynamoDB（本番）は無視する。
 * したがって本番では実際に登録された障害のみが見え、デモ用のダミー障害は出ない
 * （偽の「障害あり/なし」を見せない）。登録/更新（書き込み）は破壊的操作のため後段増分
 * （JIT 昇格・理由入力・監査つき）で実装する。本モジュールは read のみを公開する。
 */
import type { Incident } from '@/domain/platform/incident';
import { getBackend } from '@/lib/data';

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

const collection = () => getBackend().collection<Incident>('platform_incidents', { seed });

/** 全障害を返す（read-only）。並べ替え・集計は domain の summarizeIncidents に委譲する。 */
export async function listIncidents(): Promise<Incident[]> {
  return collection().list();
}

/**
 * 障害を登録する（破壊的操作。#83 AC7）。呼び出し側は **JIT 昇格ゲート（assertElevated）と監査**を
 * 通した後に呼ぶこと。id は呼び出し側で採番済み（buildIncident 済みの Incident を渡す）。
 */
export async function createIncident(incident: Incident): Promise<void> {
  await collection().put(incident);
}

/** テスト/seed 用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetIncidents(): Promise<void> {
  await collection().reset();
}
