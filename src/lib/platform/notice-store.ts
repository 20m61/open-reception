/**
 * プラットフォームお知らせ（Notice）のストア (issue #83 §8 / #90 increment 3e)。
 *
 * 永続化は data backend の collection に委譲する。`seed` は **memory バックエンド専用**（dev/test/
 * デモ）であり、DynamoDB（本番）は無視する。したがって本番では実際に公開されたお知らせのみが
 * 見え、デモ用のダミーは出ない。公開/更新（書き込み）は破壊的操作のため後段増分（JIT 昇格・
 * 理由入力・監査つき）で実装する。本モジュールは read のみを公開する。
 */
import type { Notice } from '@/domain/platform/notice';
import { getBackend } from '@/lib/data';
import { PLATFORM_LIST_LIMIT } from './store-limits';

/** memory バックエンド専用のデモ用サンプル（本番 DynamoDB では無視される）。 */
function seed(): Notice[] {
  return [
    {
      id: 'notice-demo-1',
      scope: 'platform',
      level: 'info',
      status: 'published',
      title: '定期メンテナンスのお知らせ',
      body: '7/1 0:00-1:00（JST）に定期メンテナンスを実施します。受付は一時的に読み取り専用になります。',
      publishedAt: '2026-06-20T00:00:00.000Z',
      createdBy: 'platform:demo',
      updatedAt: '2026-06-20T00:00:00.000Z',
    },
    {
      id: 'notice-demo-2',
      scope: 'tenant',
      tenantId: 'internal',
      level: 'warning',
      status: 'archived',
      title: '通話機能の一時不具合（復旧済み）',
      body: '担当者呼び出しが一時的に失敗していましたが復旧しました。',
      publishedAt: '2026-06-18T00:00:00.000Z',
      createdBy: 'platform:demo',
      updatedAt: '2026-06-20T04:30:00.000Z',
    },
  ];
}

const collection = () => getBackend().collection<Notice>('platform_notices', { seed });

/** 全お知らせを返す（read-only）。並べ替え・集計は domain の summarizeNotices に委譲する。 */
export async function listNotices(): Promise<Notice[]> {
  return collection().list({ limit: PLATFORM_LIST_LIMIT });
}

/**
 * お知らせを登録する（破壊的操作。#83 お知らせ）。呼び出し側は **JIT 昇格ゲート（assertElevated）と
 * 監査**を通した後に呼ぶこと。id は呼び出し側で採番済み。
 */
export async function createNotice(notice: Notice): Promise<void> {
  await collection().put(notice);
}

/** テスト/seed 用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetNotices(): Promise<void> {
  await collection().reset();
}
