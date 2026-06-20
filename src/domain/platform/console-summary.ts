/**
 * プラットフォーム運用コンソールの概況集計 (issue #90, increment 1)。
 *
 * 総合開発者・プラットフォーム運用者が最初に知りたいのは個々の設定値ではなく
 * 「全テナントがいま安全に動いているか」である。本モジュールは全テナントの一覧
 * （Tenant）から、その横断概況を導く純関数群。
 *
 * I/O は持たない（テスト可能な純粋ロジックに閉じる）。データ取得と API 配線は
 * src/lib/platform / src/app/api/platform に置く。
 *
 * 実データが未接続の指標（直近エラー・外部連携エラー・認証エラー・総利用量・
 * コスト概算・メンテナンス状況）は本増分では集計せず、API 側で「未接続（pending）」
 * のプレースホルダとして明示する（docs/platform-console-design.md §increment 計画）。
 * ここで集計するのは Tenant ストアから確実に読める範囲（テナント数・稼働/停止）に限る。
 */
import type { Tenant } from '@/domain/tenant/types';

/** 全テナントの稼働状況の横断集計。 */
export type TenantFleetSummary = {
  /** 全テナント数。 */
  total: number;
  /** 稼働中（status==='active'）テナント数。 */
  active: number;
  /** 停止中（status==='suspended'）テナント数。停止は「異常」ではなく運用上の意図的状態。 */
  suspended: number;
};

/**
 * 全テナント一覧からフリート概況を集計する。
 * 来訪者・担当者などの PII は一切含めない（テナントのメタ情報のみ）。
 */
export function summarizeTenantFleet(tenants: readonly Tenant[]): TenantFleetSummary {
  let active = 0;
  let suspended = 0;
  for (const t of tenants) {
    if (t.status === 'active') active += 1;
    else if (t.status === 'suspended') suspended += 1;
  }
  return { total: tenants.length, active, suspended };
}

/** テナント一覧行（テナント横断 read 用の最小表示形。機密値・PII は含めない）。 */
export type TenantRow = {
  id: string;
  name: string;
  slug: string;
  status: Tenant['status'];
  updatedAt: string;
};

/**
 * Tenant を一覧行に射影する。
 * 表示に不要な内部情報は落とし、名前順（次いで id 順）で安定ソートする。
 */
export function toTenantRows(tenants: readonly Tenant[]): TenantRow[] {
  return tenants
    .map((t) => ({ id: t.id, name: t.name, slug: t.slug, status: t.status, updatedAt: t.updatedAt }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
