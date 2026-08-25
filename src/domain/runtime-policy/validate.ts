/**
 * runtime policy の入力検証 (#367)。
 *
 * 🔴 **Reconciler は 1 分ごとに走る。** 解決が throw すると「何も収束しないまま繰り返す」
 * ——EC2 が上がりっぱなし、あるいは上がらないまま、どちらにも倒れうる。壊れた入力は
 * 永続層へ入る前に止める。
 *
 * **再実装しない。** スケジュール・例外日・件数上限・重複・日跨ぎの契約は既存の
 * `validatePolicyInput`（`operating-policy/schedule.ts`）が正本なので、そこへ委譲して
 * issue のフィールド名だけ付け替える。独自に書き直したところ、共通側と契約がずれて
 * （`crossesMidnight` の向き・件数上限の欠落）**サービスが 24 時間 running になる**
 * 経路を作っていた。
 */
import { validatePolicyInput } from '@/domain/operating-policy/schedule';
import type { PolicyValidationIssue } from '@/domain/operating-policy/types';
import {
  MANAGED_RUNTIME_SERVICE_KEYS,
  type ManagedRuntimeServiceKey,
  type ServiceOperatingMode,
} from './registry';
import {
  expiresAtMs,
  type CommonSchedule,
  type RuntimeOperatingPolicy,
  type ServicePolicyOverride,
  type TemporaryOverride,
} from './resolve';

export type RuntimePolicyValidation =
  | { ok: true; value: RuntimeOperatingPolicy }
  | { ok: false; error: { code: 'invalid_input'; message: string; issues: PolicyValidationIssue[] } };

const MODES = ['always_on', 'follow_operating_hours', 'custom_schedule', 'manual_only'] as const;
const OVERRIDE_STATES = ['force_running', 'force_stopped', 'draining'] as const;
// 集合が union からずれたらコンパイルで落ちる（文字列リテラルの複製を放置しない）。
const _MODES: readonly ServiceOperatingMode[] = MODES;
const _STATES: readonly TemporaryOverride['state'][] = OVERRIDE_STATES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManagedKey(value: unknown): value is ManagedRuntimeServiceKey {
  return typeof value === 'string' && (MANAGED_RUNTIME_SERVICE_KEYS as readonly string[]).includes(value);
}

/** 共通 validator の issue を、この階層のフィールド名へ付け替える。 */
function reprefix(issues: readonly PolicyValidationIssue[], prefix: string): PolicyValidationIssue[] {
  return issues.map((issue) => ({ ...issue, field: `${prefix}.${issue.field}` }));
}

export function validateRuntimePolicyInput(raw: unknown): RuntimePolicyValidation {
  if (!isRecord(raw)) {
    return fail([{ field: 'root', message: 'must be an object' }]);
  }
  const issues: PolicyValidationIssue[] = [];

  // 共通営業時間は丸ごと既存 validator へ。**正規化済みの値を使う**（素通しにしない）。
  const common = validatePolicyInput(raw.commonSchedule);
  let commonSchedule: CommonSchedule | undefined;
  if (!common.ok) {
    issues.push(...reprefix(common.error.issues, 'commonSchedule'));
    if (common.error.issues.length === 0) {
      issues.push({ field: 'commonSchedule', message: common.error.message });
    }
  } else {
    const { timezone, weeklySchedule, fixedHolidays, exceptionDates } = common.value;
    commonSchedule = { timezone, weeklySchedule, fixedHolidays, exceptionDates };
  }

  const breakGlass = validateBreakGlass(raw.breakGlass, issues);
  const services = validateServices(raw.services, issues);

  if (issues.length > 0 || commonSchedule === undefined) return fail(issues);

  /*
   * 🔴 **入力オブジェクトをそのまま返さない。** 検証したフィールドだけを組み立て直す。
   * 素通しにすると未知キーが残り、永続層へ繋いだ瞬間にクライアントが `version` /
   * `updatedBy` / `tenantId` を body に混ぜられる mass-assignment 経路になる
   * （楽観ロックと監査の両方を壊せる）。
   */
  return {
    ok: true,
    value: {
      commonSchedule,
      ...(breakGlass ? { breakGlass } : {}),
      ...(services ? { services } : {}),
    },
  };
}

function fail(issues: PolicyValidationIssue[]): RuntimePolicyValidation {
  return { ok: false, error: { code: 'invalid_input', message: 'runtime policy is invalid', issues } };
}

function validateBreakGlass(
  value: unknown,
  issues: PolicyValidationIssue[],
): RuntimeOperatingPolicy['breakGlass'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ field: 'breakGlass', message: 'must be an object' });
    return undefined;
  }
  if (typeof value.active !== 'boolean') {
    issues.push({ field: 'breakGlass.active', message: 'must be a boolean' });
  }
  const keys = value.serviceKeys;
  if (keys === undefined) {
    return typeof value.active === 'boolean' ? { active: value.active } : undefined;
  }
  if (!Array.isArray(keys)) {
    issues.push({ field: 'breakGlass.serviceKeys', message: 'must be an array' });
    return undefined;
  }
  const serviceKeys: ManagedRuntimeServiceKey[] = [];
  keys.forEach((key, index) => {
    if (!isManagedKey(key)) {
      issues.push({ field: `breakGlass.serviceKeys[${index}]`, message: 'unknown service key' });
      return;
    }
    serviceKeys.push(key);
  });
  return typeof value.active === 'boolean' ? { active: value.active, serviceKeys } : undefined;
}

function validateServices(
  value: unknown,
  issues: PolicyValidationIssue[],
): RuntimeOperatingPolicy['services'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ field: 'services', message: 'must be an object' });
    return undefined;
  }
  const services: Partial<Record<ManagedRuntimeServiceKey, ServicePolicyOverride>> = {};
  for (const [key, override] of Object.entries(value)) {
    // 🔴 未知のキーを黙って無視しない。typo は「設定したのに効かない」として現れる。
    if (!isManagedKey(key)) {
      issues.push({ field: `services.${key}`, message: 'unknown service key' });
      continue;
    }
    if (!isRecord(override)) {
      issues.push({ field: `services.${key}`, message: 'must be an object' });
      continue;
    }
    const validated = validateOverride(key, override, issues);
    if (validated) services[key] = validated;
  }
  return services;
}

function validateOverride(
  key: ManagedRuntimeServiceKey,
  override: Record<string, unknown>,
  issues: PolicyValidationIssue[],
): ServicePolicyOverride | undefined {
  const before = issues.length;
  const result: {
    mode?: ServiceOperatingMode;
    weeklySchedule?: CommonSchedule['weeklySchedule'];
    exceptionDates?: CommonSchedule['exceptionDates'];
    temporaryOverride?: TemporaryOverride;
  } = {};

  const mode = override.mode;
  if (mode !== undefined) {
    if (!(MODES as readonly string[]).includes(mode as string)) {
      issues.push({ field: `services.${key}.mode`, message: `must be one of ${MODES.join(' | ')}` });
    } else {
      result.mode = mode as ServiceOperatingMode;
    }
  }

  const temporary = override.temporaryOverride;
  if (temporary !== undefined) {
    const validated = validateTemporaryOverride(key, temporary, issues);
    if (validated) result.temporaryOverride = validated;
  }

  /*
   * サービス個別のスケジュール・例外日も共通 validator へ通す。ここを素通しにしていたため、
   * `services.<key>.exceptionDates` が**どんな形でも通り**、解決が TypeError で落ちていた。
   */
  if (override.weeklySchedule !== undefined || override.exceptionDates !== undefined) {
    const nested = validatePolicyInput({
      timezone: 'UTC',
      weeklySchedule: override.weeklySchedule ?? {},
      fixedHolidays: [],
      exceptionDates: override.exceptionDates ?? [],
    });
    if (!nested.ok) {
      issues.push(...reprefix(nested.error.issues, `services.${key}`));
      if (nested.error.issues.length === 0) {
        issues.push({ field: `services.${key}`, message: nested.error.message });
      }
    } else {
      if (override.weeklySchedule !== undefined) result.weeklySchedule = nested.value.weeklySchedule;
      if (override.exceptionDates !== undefined) result.exceptionDates = nested.value.exceptionDates;
    }
  }

  /*
   * issue が 1 つでも積まれれば全体が `fail` になるので、ここで返した値は使われない。
   * それでも「壊れた override を組み立てたまま返す」形は残さない（呼び出し側が将来
   * 部分成功を許した瞬間に、検証を通っていない値が混ざる）。
   */
  return issues.length === before ? result : undefined;
}

function validateTemporaryOverride(
  key: ManagedRuntimeServiceKey,
  value: unknown,
  issues: PolicyValidationIssue[],
): TemporaryOverride | undefined {
  const field = `services.${key}.temporaryOverride`;
  if (!isRecord(value)) {
    issues.push({ field, message: 'must be an object' });
    return undefined;
  }
  const state = value.state;
  if (!(OVERRIDE_STATES as readonly string[]).includes(state as string)) {
    issues.push({ field: `${field}.state`, message: `must be one of ${OVERRIDE_STATES.join(' | ')}` });
  }
  const expiresAt = value.expiresAt;
  if (typeof expiresAt !== 'string' || !isResolvableExpiresAt(expiresAt)) {
    issues.push({ field: `${field}.expiresAt`, message: 'must be a resolvable ISO8601 date or date-time' });
  }
  if (!(OVERRIDE_STATES as readonly string[]).includes(state as string) || typeof expiresAt !== 'string') {
    return undefined;
  }
  return { state: state as TemporaryOverride['state'], expiresAt };
}

/**
 * `expiresAt` は**実際のパーサ**（`expiresAtMs`）だけで確かめる。判定を 2 本持つと受理集合が
 * ずれ、「検証を通ったのに解決時に NaN」や、その逆（`toISOString()` の出力を拒否する）が
 * 起きる。暦のロールオーバー（`2026-13-01` → 2027-01-01）の拒否もパーサ側の責務。
 */
function isResolvableExpiresAt(value: string): boolean {
  // タイムゾーンは**解析できるか**の判定には効かない（オフセットが変わるだけ）。ポリシー側の
  // TZ をここへ引き回すと、TZ が無効な入力で「期限も無効」と二重に落ちて原因が読めなくなる。
  return Number.isFinite(expiresAtMs(value, 'UTC'));
}
