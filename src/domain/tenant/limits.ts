/**
 * テナント別の保持期間などの運用制限値 (issue #313)。
 *
 * requirements 4.6/5.2: 個人情報は最小限にし「保存期間を設定できる」こと。ReceptionLog /
 * AuditLog の TTL は、ここで解決した保持日数から算出する。**新規に書き込むレコードにのみ適用し、
 * 既存レコードへの遡及適用（backfill）はしない**（docs/audit-logging.md「保存期間・削除方針」参照）。
 *
 * このモジュールは純関数のみ（I/O を持たない）。永続化は `@/lib/tenant/limits-store`、
 * 実際の TTL 付与は `@/lib/data-stores/log-retention` が担う。
 */
import type { TenantId } from './types';

/** 受付履歴（ReceptionLog）の既定保持日数。テナント設定が無いときに使う。 */
export const DEFAULT_RECEPTION_LOG_RETENTION_DAYS = 180;

/**
 * 監査ログ（AuditLog）の既定保持日数。受付履歴より長め
 * （コンプライアンス上、運用操作の追跡証跡を長く残す要件を想定）。
 */
export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 365;

/**
 * 監査ログの下限保持日数。テナント設定でこれより短い値を指定しても、実効値はこの下限に
 * 切り上げる（コンプライアンス上の safety net）。運用者は
 * `OPEN_RECEPTION_AUDIT_LOG_MIN_RETENTION_DAYS` env でこの下限を引き上げられる
 * （テナント自身は下限を下げられない — resolveAuditLogRetentionDays 参照）。
 */
export const MIN_AUDIT_LOG_RETENTION_DAYS = 90;

/**
 * テナントごとの保持期間設定（1 テナント 1 レコード、id = tenantId）。
 * 未設定フィールドは既定値を使う（欠落 = 上書きなし。フラグ設定 `TenantFeatureFlagRecord` と
 * 同じ「上書きのみ保存」パターン）。
 */
export type TenantLimits = {
  /** tenantId をそのまま id に使う。 */
  id: string;
  /** 受付履歴の保持日数の上書き。未設定・0 以下は既定値を使う。 */
  receptionLogRetentionDays?: number;
  /** 監査ログの保持日数の上書き。未設定・0 以下は既定値を使う。下限より短い値は下限へ切り上げる。 */
  auditLogRetentionDays?: number;
  updatedAt: string;
  /** 最終更新の操作者 identity（監査が正、これは補助）。 */
  updatedBy?: string;
};

function positiveOrUndefined(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 受付履歴の実効保持日数（テナント設定 > 既定値）。 */
export function resolveReceptionLogRetentionDays(
  limits?: Pick<TenantLimits, 'receptionLogRetentionDays'>,
): number {
  return positiveOrUndefined(limits?.receptionLogRetentionDays) ?? DEFAULT_RECEPTION_LOG_RETENTION_DAYS;
}

/**
 * 監査ログの実効保持日数（テナント設定 > 既定値）。`floorDays`
 * （既定 MIN_AUDIT_LOG_RETENTION_DAYS）を下回る値は下限へ切り上げる。
 */
export function resolveAuditLogRetentionDays(
  limits?: Pick<TenantLimits, 'auditLogRetentionDays'>,
  floorDays: number = MIN_AUDIT_LOG_RETENTION_DAYS,
): number {
  const requested = positiveOrUndefined(limits?.auditLogRetentionDays) ?? DEFAULT_AUDIT_LOG_RETENTION_DAYS;
  const floor = positiveOrUndefined(floorDays) ?? MIN_AUDIT_LOG_RETENTION_DAYS;
  return Math.max(requested, floor);
}

/**
 * 保持日数を、`anchorMs`（既定は現在時刻。ログの createdAt を渡せばそこからの失効時刻になる）を
 * 起点にした epoch 秒の ttl に変換する。DynamoDB TTL 属性（`ttl`、docs/persistence-design.md §4）
 * にそのまま使える。
 */
export function retentionDaysToTtl(days: number, anchorMs: number = Date.now()): number {
  const safeDays = Number.isFinite(days) && days > 0 ? days : 0;
  return Math.floor(anchorMs / 1000) + safeDays * 24 * 60 * 60;
}

/** 文字列を TenantId へ畳み込む（TenantLimits.id を型付きで扱いたい呼び出し側向けの補助）。 */
export function tenantLimitsIdOf(tenantId: TenantId): string {
  return tenantId;
}
