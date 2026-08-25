/**
 * ServiceOperatingPolicy のストア (issue #367)。
 *
 * テナント/サイト単位に 1 件のポリシーを持つ（`security-store.ts` の singleton 方針に近いが、
 * スコープがテナント横断ではなくサイト単位のため `getBackend().collection()` に
 * `id = "<tenantId>:<siteId>"` で1件だけ書く決定論的キーを使う）。永続化は data backend
 * （memory / dynamodb, docs/persistence-design.md）に委譲する。
 *
 * 監査 (`.claude/rules/pii-secret-minimization.md` / `appendAdminAudit`):
 *   専用 action `operating_policy.updated`（`src/domain/reception/log.ts`, issue #363/#367 申し送り
 *   で追加）を使う。以前は最も意味が近い既存 action `site.updated` を暫定で使い
 *   `metadata.resource='operating_policy'` で対象を区別していたが、専用 action へ差し替えた。
 *   `resource` フィールドは互換のため引き続き付与する（対象種別の明示に使える）。
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

export type StoreError = {
  code: 'invalid_input' | 'conflict';
  message: string;
  issues: PolicyValidationIssue[];
};
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
function conflictError(message: string): Result<ServiceOperatingPolicy> {
  return { ok: false, error: { code: 'conflict', message, issues: [] } };
}

/**
 * `expectedVersion` の型不正は**競合ではない**。409 は「読み直して再試行せよ」という意味
 * だが、型が違うリクエストは何度やっても成功しない——**永久に直らない指示**になる。
 * 他の型不正フィールドと同じく 400 + issues で返す。
 */
function invalidExpectedVersion(): Result<ServiceOperatingPolicy> {
  return {
    ok: false,
    error: {
      code: 'invalid_input',
      message: 'operating policy is invalid',
      issues: [{ field: 'expectedVersion', message: 'must be a non-negative integer' }],
    },
  };
}

/** body の `expectedVersion` を読む。未指定は undefined、型不正は 'invalid'。 */
function readExpectedVersion(raw: unknown): number | undefined | 'invalid' {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as Record<string, unknown>).expectedVersion;
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 'invalid';
}

export async function upsertOperatingPolicy(
  tenantId: string,
  siteId: string,
  updatedBy: string,
  raw: unknown,
): Promise<Result<ServiceOperatingPolicy>> {
  const validated: ValidationResult = validatePolicyInput(raw);
  if (!validated.ok) return { ok: false, error: validated.error };

  /*
   * 楽観ロック (#367)。
   *
   * 🔴 従来は `get` → `put` の read-modify-write で、**同時更新が黙って後勝ちになる**。
   * 2 人の運用者が同じ version を読んで保存すると、先に保存した側の変更が痕跡なく消える
   * （営業時間は EC2 の起動時間＝実費と、営業時間外の発信抑止に直結する）。
   *
   * 既存レコードの更新には `expectedVersion` を**必須**にする。省略を許すと後勝ちの経路が
   * 残り、AC「競合更新で後勝ち上書きしない」を満たせない。
   */
  const id = operatingPolicyKey(tenantId, siteId);
  const requested = readExpectedVersion(raw);
  if (requested === 'invalid') return invalidExpectedVersion();
  const expectedVersion = requested;
  const existing = await collection().get(id);

  if (existing === null || existing === undefined) {
    if (expectedVersion !== undefined) {
      // 「更新のつもり」で来たのに実体が無い＝別経路で消された等。作成へ倒さない。
      return conflictError('operating policy does not exist (expectedVersion was given)');
    }
  } else if (expectedVersion === undefined) {
    return conflictError('expectedVersion is required to update an existing operating policy');
  } else if (existing.version !== expectedVersion) {
    return conflictError('operating policy was updated by someone else');
  }

  const stored: StoredOperatingPolicy = {
    id,
    tenantId,
    siteId,
    ...validated.value,
    version: (existing?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  if (existing) {
    /*
     * 🔴 **`updateIf` はマージ、`put` は置換。**
     *
     * `validatePolicyInput` は空の任意フィールドを**キーごと落とす**ので、`put` では
     * 「キーが無い＝削除」だった。そのまま `updateIf` へ渡すと旧値が残り、API は
     * 「消えた」と答えるのに永続状態には古い値が居座る。営業時間外画面は
     * `emergencyContactLabel` を来訪者への**唯一の頼れる連絡先**として出すので、
     * 廃止した内線が iPad に残り続ける。任意フィールドは省略せず `undefined` を明示し、
     * 両バックエンドで削除が成立するようにする（memory は上書き、dynamo は REMOVE）。
     */
    const changes = { ...stored, emergencyContactLabel: validated.value.emergencyContactLabel };
    // 読んでから書くまでの隙間も塞ぐ（CAS）。false = その間に誰かが書いた。
    const applied = await collection().updateIf(id, changes, { version: expectedVersion });
    if (!applied) return conflictError('operating policy was updated by someone else');
  } else {
    await collection().put(stored);
  }
  // PII/機微値は残さない: 時間帯の具体値は載せず件数・timezone・version のみ（rules/pii-secret-minimization.md）。
  await appendAdminAudit(
    'operating_policy.updated',
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
