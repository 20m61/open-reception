/**
 * プラットフォームお知らせ（Notice）のストア (issue #83 §8 / #90 increment 3e)。
 *
 * #274 ③ で §9 標準（docs/persistence-design.md）へ統合: 永続化は PlatformRecordRepository
 * （./repository.ts、getBackend() 委譲の単一実装）に閉じ、本ファイルはプロセス共有ファクトリ
 * （getNoticeRepository）と互換 API を担う。呼び出し側 route の変更は不要。
 *
 * `seed` は **memory バックエンド専用**（dev/test/デモ）であり、DynamoDB（本番）は無視する。
 * したがって本番では実際に公開されたお知らせのみが見え、デモ用のダミーは出ない。
 */
import type { Notice } from '@/domain/platform/notice';
import {
  DataBackedPlatformRecordRepository,
  PLATFORM_NOTICE_COLLECTION,
  type PlatformRecordRepository,
} from './repository';

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

let repository: PlatformRecordRepository<Notice> | undefined;

/** プロセス共有の Notice リポジトリ（§9.2 のファクトリ）。 */
export function getNoticeRepository(): PlatformRecordRepository<Notice> {
  if (!repository) {
    repository = new DataBackedPlatformRecordRepository<Notice>(PLATFORM_NOTICE_COLLECTION, seed);
  }
  return repository;
}

/** 全お知らせを返す（read-only）。並べ替え・集計は domain の summarizeNotices に委譲する。 */
export async function listNotices(): Promise<Notice[]> {
  return getNoticeRepository().list();
}

/**
 * お知らせを登録する（破壊的操作。#83 お知らせ）。呼び出し側は **JIT 昇格ゲート（assertElevated）と
 * 監査**を通した後に呼ぶこと。id は呼び出し側で採番済み。
 */
export async function createNotice(notice: Notice): Promise<void> {
  await getNoticeRepository().create(notice);
}

/** テスト/seed 用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetNotices(): Promise<void> {
  await getNoticeRepository().reset();
}
