/**
 * runtime policy（サービス単位の稼働ポリシー）のストア (#367)。
 *
 * **共通営業時間（`operating_policy`）とは別コレクションに置く。** `RuntimeOperatingPolicy` は
 * `commonSchedule` を内包する形なので 1 レコードに寄せたくなるが、`operating_policy` には
 * 稼働中の kiosk consumer（`kiosk-gate` / `call-guard`）が付いているので移行なしには統合できない。
 * 2 コレクションへ書き分ける案は、片方だけ成功した状態（営業時間だけ更新されてサービス設定が
 * 古い）を作れてしまうので採らない。**合成は読み出し時に行う**。
 *
 * 監査は専用 action `runtime_policy.updated`。時間帯の具体値は残さず、
 * 「誰がどのサービスを触ったか」までに留める（`.claude/rules/pii-secret-minimization.md`）。
 */
import type { PolicyValidationIssue } from '@/domain/operating-policy/types';
import { DEFAULT_TIMEZONE } from '@/domain/operating-policy/tz';
import {
  resolveServiceStates,
  type CommonSchedule,
  type RuntimeOperatingPolicy,
  type RuntimeStateResolution,
} from '@/domain/runtime-policy/resolve';
import { validateRuntimePolicyInput } from '@/domain/runtime-policy/validate';
import { getBackend } from '@/lib/data';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { getOperatingPolicy } from '@/lib/operating-policy/store';

/** 永続化する部分。共通営業時間は持たない（読み出し時に合成する）。 */
export type RuntimePolicyDocument = Pick<RuntimeOperatingPolicy, 'services' | 'breakGlass'>;

export type RuntimePolicyRecord = RuntimePolicyDocument & {
  tenantId: string;
  siteId: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
};

type StoredRuntimePolicy = RuntimePolicyRecord & { id: string };

const COLLECTION = 'runtime_policy';

function collection() {
  return getBackend().collection<StoredRuntimePolicy>(COLLECTION);
}

// 区切り文字の混入で別 (tenant, site) 組と衝突しないよう、キー成分を制限する
// （`a:b`+`c` と `a`+`b:c` の衝突防止。`operating-policy/store.ts` と同じ規則）。
const KEY_PART_PATTERN = /^[A-Za-z0-9_-]+$/;

export function runtimePolicyKey(tenantId: string, siteId: string): string {
  if (!KEY_PART_PATTERN.test(tenantId) || !KEY_PART_PATTERN.test(siteId)) {
    throw new Error('runtime-policy: invalid tenantId/siteId for policy key');
  }
  return `${tenantId}:${siteId}`;
}

export type StoreError = {
  code: 'invalid_input' | 'conflict';
  message: string;
  issues: PolicyValidationIssue[];
};
export type Result<T> = { ok: true; value: T } | { ok: false; error: StoreError };

/** 保存済みのサービス設定。未設定なら null（＝ registry の既定 mode で動く）。 */
export async function getRuntimePolicy(tenantId: string, siteId: string): Promise<RuntimePolicyRecord | null> {
  const found = await collection().get(runtimePolicyKey(tenantId, siteId));
  return found ? stripId(found) : null;
}

function stripId(stored: StoredRuntimePolicy): RuntimePolicyRecord {
  const { id: _id, ...rest } = stored;
  return rest;
}

/*
 * 🔴 **route 層の封筒はここで剥がす（#798 AC5）。** 隣接する `operating-policy` の route/store は
 * `tenantId` / `siteId` / `expectedVersion` を**同じ body に載せて** validator へ渡す作法だが、
 * `validateRuntimePolicyInput` はポリシー文書だけを受け取り未知キーを拒否する。剥がさずに
 * 渡すと、同じ形で繋いだ瞬間に全リクエストが 400 になる。
 */
const ENVELOPE_FIELDS = ['tenantId', 'siteId', 'expectedVersion'] as const;

function splitEnvelope(raw: Record<string, unknown>): Record<string, unknown> {
  const document: Record<string, unknown> = { ...raw };
  for (const field of ENVELOPE_FIELDS) delete document[field];
  return document;
}

function fail(code: StoreError['code'], message: string, issues: PolicyValidationIssue[] = []): Result<never> {
  return { ok: false, error: { code, message, issues } };
}

/**
 * `expectedVersion` の型不正は**競合ではない**。409 は「読み直して再試行せよ」の意味だが、
 * 型が違う要求は何度やっても成功しない——永久に直らない指示になる。400 + issues で返す。
 */
function readExpectedVersion(raw: Record<string, unknown>): number | undefined | 'invalid' {
  const value = raw.expectedVersion;
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 'invalid';
}

/**
 * 検証のときだけ被せる共通営業時間。**実物は読まない。**
 *
 * `validateRuntimePolicyInput` は文書全体を要求するが、サービス個別の契約（mode の整合・
 * 区間ゼロ・例外日の形・未知キー）は共通側の値に依存しない。実物を読んで合成しても
 * 受理集合は変わらず（変異で確認）、代わりに「営業時間を先に設定しないとサービス設定を
 * 保存できない」という**保存の順序の強制**が生まれるだけになる。運用者がどちらを先に
 * 触るかは決められないので、ここは固定値で通し、解決だけが実物を読む。
 */
const VALIDATION_PLACEHOLDER_SCHEDULE: CommonSchedule = {
  timezone: DEFAULT_TIMEZONE,
  weeklySchedule: {},
  fixedHolidays: [],
  exceptionDates: [],
};

export async function upsertRuntimePolicy(
  tenantId: string,
  siteId: string,
  updatedBy: string,
  raw: unknown,
): Promise<Result<RuntimePolicyRecord>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('invalid_input', 'runtime policy is invalid', [{ field: 'body', message: 'must be an object' }]);
  }
  const body = raw as Record<string, unknown>;
  const requested = readExpectedVersion(body);
  if (requested === 'invalid') {
    return fail('invalid_input', 'runtime policy is invalid', [
      { field: 'expectedVersion', message: 'must be a non-negative integer' },
    ]);
  }
  const document = splitEnvelope(body);

  /*
   * 共通営業時間はこの経路で書かせない。黙って無視すると「設定したのに効かない」になり、
   * しかも運用者は営業時間を変えたつもりでいる。専用の endpoint へ誘導する。
   */
  if (document.commonSchedule !== undefined) {
    return fail('invalid_input', 'runtime policy is invalid', [
      { field: 'commonSchedule', message: 'is managed by the operating-policy endpoint' },
    ]);
  }

  const validated = validateRuntimePolicyInput({
    ...document,
    commonSchedule: VALIDATION_PLACEHOLDER_SCHEDULE,
  });
  if (!validated.ok) return { ok: false, error: validated.error };

  const id = runtimePolicyKey(tenantId, siteId);
  const expectedVersion = requested;
  const existing = await collection().get(id);
  if (existing === null || existing === undefined) {
    // 「更新のつもり」で来たのに実体が無い＝別経路で消された等。作成へ倒さない。
    if (expectedVersion !== undefined) {
      return fail('conflict', 'runtime policy does not exist (expectedVersion was given)');
    }
  } else if (expectedVersion === undefined) {
    return fail('conflict', 'expectedVersion is required to update an existing runtime policy');
  }
  /*
   * version の一致判定はここでは**しない**。読んでから書くまでの隙間があるので、権威は下の
   * CAS（`updateIf`）1 か所に置く。事前判定を足しても同じ結果・同じ文言になるだけで、
   * 「先に読んだ値で判断する」経路を 2 本持つことになる。
   */

  /*
   * 🔴 **`updateIf` はマージ、`put` は置換。** 省略された任意フィールドは**キーごと落とさず
   * `undefined` を明示する**。落とすと更新時に旧値が残り、API は「消えた」と答えるのに
   * 永続状態には古い設定が居座る。break-glass が消えないと、解除したはずの緊急停止が
   * 毎分の解決で復活する（memory は上書き、dynamo は REMOVE で削除が成立する）。
   */
  const stored: StoredRuntimePolicy = {
    id,
    tenantId,
    siteId,
    services: validated.value.services,
    breakGlass: validated.value.breakGlass,
    version: (existing?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  if (existing) {
    // 読んでから書くまでの隙間も塞ぐ（CAS）。false = その間に誰かが書いた。
    const applied = await collection().updateIf(id, stored, { version: expectedVersion });
    if (!applied) return fail('conflict', 'runtime policy was updated by someone else');
  } else {
    await collection().put(stored);
  }

  await appendAdminAudit(
    'runtime_policy.updated',
    { type: 'runtime_policy', id: stored.id },
    {
      resource: 'runtime_policy',
      tenantId,
      siteId,
      version: String(stored.version),
      // 「誰がどのサービスを触ったか」まで。時間帯の具体値は残さない。
      serviceKeys: Object.keys(stored.services ?? {}).sort().join(','),
      breakGlass: stored.breakGlass ? (stored.breakGlass.active ? 'active' : 'inactive') : 'unset',
    },
  );
  return { ok: true, value: stripId(stored) };
}

/**
 * 保存済みのポリシーから各サービスの状態を解決する。
 *
 * 共通営業時間が未設定なら **undefined**（判定不能）。ここで「停止」に倒すと、営業時間を
 * まだ設定していない拠点で受付が上がらない。呼び出し側（Reconciler）は undefined を
 * 「現状を変えない」として扱う（#798 AC1）。
 */
export async function resolveRuntimeStatesFor(
  tenantId: string,
  siteId: string,
  atMs: number = Date.now(),
): Promise<RuntimeStateResolution | undefined> {
  try {
    const common = await getOperatingPolicy(tenantId, siteId);
    if (!common) return undefined;
    const runtime = await getRuntimePolicy(tenantId, siteId);
    const policy: RuntimeOperatingPolicy = {
      commonSchedule: {
        timezone: common.timezone,
        weeklySchedule: common.weeklySchedule,
        fixedHolidays: common.fixedHolidays,
        exceptionDates: common.exceptionDates,
      },
      ...(runtime?.services ? { services: runtime.services } : {}),
      ...(runtime?.breakGlass ? { breakGlass: runtime.breakGlass } : {}),
    };
    return resolveServiceStates({ policy, now: atMs });
  } catch {
    return undefined;
  }
}

/** テスト用: ストアを空へ戻す。 */
export async function __resetRuntimePolicyStore(): Promise<void> {
  await collection().reset();
}
