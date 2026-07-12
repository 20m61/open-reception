/**
 * 受付履歴・監査ログの保持期間 → TTL 解決 (issue #313)。
 *
 * `ReceptionLog` / `AuditLog`（`src/domain/reception/log.ts`）は現状テナント境界を持たない
 * 共有ログである（kiosk→tenant の実写像は #284 の残課題として未接続）。本増分では、単一テナント
 * 運用の実体である「既定テナント」（`resolveDefaultScope`／`OPEN_RECEPTION_DEFAULT_TENANT_ID`）の
 * `TenantLimits` を全書き込みへ適用する。真の per-tenant 分離（ログへの tenantId 付与）は、
 * kiosk→tenant 写像が入った後続増分で行う（docs/audit-logging.md に明記）。
 *
 * TTL は既存の DynamoDB `ttl`（epoch 秒）属性の仕組みをそのまま流用する
 * （`src/lib/data/dynamodb.ts` の TTL 属性、受付セッションと同じ機構）。ここで計算した
 * `ttl` を各ログ item に載せるだけで、DynamoLogStore.put() がそのまま書き込む。
 * memory backend は `src/lib/data/memory.ts` の MemoryLogStore が読み取り時に同じ `ttl`
 * フィールドで期限判定する（`platform/repository.ts` の expiresAt 方式に倣う, #313）。
 *
 * 新規に書き込まれるレコードにのみ適用する。**既存レコードへの遡及適用（backfill）はしない**
 * （docs/audit-logging.md「保存期間・削除方針」参照）。
 */
import {
  resolveAuditLogRetentionDays,
  resolveReceptionLogRetentionDays,
  retentionDaysToTtl,
  type TenantLimits,
} from '@/domain/tenant/limits';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';
import { getTenantLimitsRepository } from '@/lib/tenant/limits-store';

/** 運用者が監査ログの下限保持日数を引き上げるための env（既定は MIN_AUDIT_LOG_RETENTION_DAYS）。 */
const AUDIT_LOG_MIN_RETENTION_DAYS_ENV = 'OPEN_RECEPTION_AUDIT_LOG_MIN_RETENTION_DAYS';

function auditLogFloorDaysFrom(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env[AUDIT_LOG_MIN_RETENTION_DAYS_ENV];
  const n = raw ? Number(raw) : undefined;
  return n && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 「既定テナント」の TenantLimits を読む（未設定ならすべて既定値扱いの undefined）。 */
async function effectiveTenantLimits(): Promise<TenantLimits | undefined> {
  const tenantId = defaultTenantIdFrom();
  return getTenantLimitsRepository().get(tenantId);
}

/**
 * ReceptionLog に付与する ttl（epoch 秒）を返す。`anchorMs` にログの `createdAt` を渡すと、
 * put() で再書き込み（fallbackUsed 更新など）しても失効時刻が起点からずれない。
 */
export async function resolveReceptionLogTtl(anchorMs: number = Date.now()): Promise<number> {
  const limits = await effectiveTenantLimits();
  const days = resolveReceptionLogRetentionDays(limits);
  return retentionDaysToTtl(days, anchorMs);
}

/**
 * AuditLog に付与する ttl（epoch 秒）を返す。テナント設定があっても
 * 下限（MIN_AUDIT_LOG_RETENTION_DAYS、env で引き上げ可）より短くはならない。
 */
export async function resolveAuditLogTtl(anchorMs: number = Date.now()): Promise<number> {
  const limits = await effectiveTenantLimits();
  const days = resolveAuditLogRetentionDays(limits, auditLogFloorDaysFrom());
  return retentionDaysToTtl(days, anchorMs);
}
