/**
 * ServiceOperatingPolicy のストア (issue #367)。
 *
 * テナント/サイト単位に 1 件のポリシーを持つ（`security-store.ts` の singleton 方針に近いが、
 * スコープがテナント横断ではなくサイト単位のため `getBackend().collection()` に
 * `id = "<tenantId>:<siteId>"` で1件だけ書く決定論的キーを使う）。永続化は data backend
 * （memory / dynamodb, docs/persistence-design.md）に委譲する。
 *
 * 監査 (`.claude/rules/pii-secret-minimization.md` / `appendAdminAudit`):
 *   専用の AuditAction（例: `operating_policy.updated`）はまだ `src/domain/reception/log.ts`
 *   に無い（同ファイルは他トラックと共有のため本 increment では編集しない — `lib/admin/audit.ts` の
 *   既存方針と同じ「既存 action だけを使う」）。最も意味が近い既存 action `site.updated`
 *   （拠点＝サイト単位の設定変更）を暫定で使い、`metadata.resource='operating_policy'` で
 *   対象を区別する。専用 action の追加はオーケストレータへの申し送り事項（最終報告参照）。
 */
import type { KioskOperatingStatus } from '@/domain/kiosk/operating-status';
import {
  resolveKioskOperatingStatus,
  validatePolicyInput,
  type ValidationResult,
} from '@/domain/operating-policy/schedule';
import type { PolicyValidationIssue, ServiceOperatingPolicy } from '@/domain/operating-policy/types';
import { getBackend } from '@/lib/data';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';

export type StoredOperatingPolicy = ServiceOperatingPolicy & { id: string };

const COLLECTION = 'operating_policy';

function collection() {
  return getBackend().collection<StoredOperatingPolicy>(COLLECTION);
}

/**
 * テナント/サイトから決定論的な Collection キーを作る（1サイト=1ポリシー）。
 * 区切り文字 `:` の混入で別 (tenant, site) 組と衝突しないよう、キー成分は安全な
 * 文字クラスに制限する（例: `a:b`+`c` と `a`+`b:c` の衝突防止）。
 */
const KEY_PART_PATTERN = /^[A-Za-z0-9_-]+$/;

export function operatingPolicyKey(tenantId: string, siteId: string): string {
  if (!KEY_PART_PATTERN.test(tenantId) || !KEY_PART_PATTERN.test(siteId)) {
    throw new Error('operating-policy: invalid tenantId/siteId for policy key');
  }
  return `${tenantId}:${siteId}`;
}

export type StoreError = { code: 'invalid_input'; message: string; issues: PolicyValidationIssue[] };
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

/** 保存済みポリシーを取得する。未設定なら null（呼び出し側は fail-open=常時営業として扱う）。 */
export async function getOperatingPolicy(tenantId: string, siteId: string): Promise<ServiceOperatingPolicy | null> {
  const found = await collection().get(operatingPolicyKey(tenantId, siteId));
  return found ? stripId(found) : null;
}

function stripId(stored: StoredOperatingPolicy): ServiceOperatingPolicy {
  const { id: _id, ...rest } = stored;
  return rest;
}

/**
 * ポリシーを作成/更新する（tenantId/siteId は呼び出し側で認可済みの前提、#80 は route 側で担保）。
 * `version` は既存があれば +1、無ければ 1（楽観ロック用の単調増加カウンタ）。
 */
export async function upsertOperatingPolicy(
  tenantId: string,
  siteId: string,
  updatedBy: string,
  raw: unknown,
): Promise<Result<ServiceOperatingPolicy>> {
  const validated: ValidationResult = validatePolicyInput(raw);
  if (!validated.ok) return { ok: false, error: validated.error };

  const existing = await collection().get(operatingPolicyKey(tenantId, siteId));
  const stored: StoredOperatingPolicy = {
    id: operatingPolicyKey(tenantId, siteId),
    tenantId,
    siteId,
    ...validated.value,
    version: (existing?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  await collection().put(stored);
  // PII/機微値は残さない: 時間帯の具体値は載せず件数・timezone・version のみ（rules/pii-secret-minimization.md）。
  await appendAdminAudit(
    'site.updated',
    { type: 'operating_policy', id: stored.id },
    {
      resource: 'operating_policy',
      tenantId,
      siteId,
      timezone: stored.timezone,
      version: String(stored.version),
      weeklyDayCount: String(Object.keys(stored.weeklySchedule).length),
      exceptionCount: String(stored.exceptionDates.length),
    },
  );
  return { ok: true, value: stripId(stored) };
}

/**
 * kiosk 向け: 判定済み営業状態を返す。ポリシー未設定・判定失敗は undefined
 * （fail-open。呼び出し側 `operatingStateOf` が undefined を「判定不能」として通常受付に倒す）。
 */
export async function resolveKioskStatusFor(
  tenantId: string,
  siteId: string,
  atMs: number = Date.now(),
): Promise<KioskOperatingStatus | undefined> {
  try {
    const policy = await getOperatingPolicy(tenantId, siteId);
    if (!policy) return undefined;
    return resolveKioskOperatingStatus(policy, atMs);
  } catch {
    return undefined;
  }
}

/** テスト用: ストアを空へ戻す。 */
export async function __resetOperatingPolicyStore(): Promise<void> {
  await collection().reset();
}
