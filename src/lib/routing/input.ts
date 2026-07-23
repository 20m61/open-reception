/**
 * 信頼できない JSON をルーティングポリシー本体へ正規化・検証する (issue #374, 残 increment)。
 *
 * ドメイン（`@/domain/routing/policy`）の型ガード（isRouteAction / isRouteResult）に乗り、
 * step 列・nextOn 遷移を厳格に検証する。**構造検証はここ**、Endpoint 参照整合や循環検出は
 * service 層が `validateRoutingPolicySet` で行う（責務分離）。ドメイン型は変更しない。
 *
 * エラーにはアドレス等の機微値を含めない（そもそも policy 本体はアドレスを持たない）。
 */
import {
  isRouteAction,
  isRouteResult,
  type RouteTransition,
  type RoutingStep,
} from '@/domain/routing/policy';

export type ParseError = { code: 'invalid_input'; message: string };
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ParseError };

/**
 * 入力サイズ上限 (issue #374, 第5wave 申し送りの nit)。信頼できない入力が肥大化して
 * 保存/検証/描画を圧迫するのを防ぐ。値は運用に十分な余裕を持たせた保守的な上限。
 *   - name: ルート名の最大文字数。
 *   - steps: 1 ポリシーあたりの最大手順数（描画・循環検出コストの上限）。
 *   - id/endpointId: 1 識別子あたりの最大文字数。
 */
export const MAX_POLICY_NAME_LENGTH = 120;
export const MAX_STEPS_PER_POLICY = 50;
export const MAX_STEP_ID_LENGTH = 120;

/** 作成/更新で受け取るポリシー本体（永続化フィールド・tenantId・id を除く可変部）。 */
export type ParsedRoutingPolicyBody = {
  name: string;
  siteId?: string;
  enabled: boolean;
  fallbackPolicyId?: string;
  steps: RoutingStep[];
};

function fail(message: string): ParseResult<never> {
  return { ok: false, error: { code: 'invalid_input', message } };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function parseTransition(raw: unknown): ParseResult<RouteTransition> {
  const o = asRecord(raw);
  if (!o) return fail('transition must be an object');
  switch (o.kind) {
    case 'stop':
      return { ok: true, value: { kind: 'stop' } };
    case 'goto_step': {
      const stepId = typeof o.stepId === 'string' ? o.stepId.trim() : '';
      if (stepId === '') return fail('goto_step requires stepId');
      return { ok: true, value: { kind: 'goto_step', stepId } };
    }
    case 'fallback_policy': {
      const policyId = typeof o.policyId === 'string' ? o.policyId.trim() : '';
      if (policyId === '') return fail('fallback_policy requires policyId');
      return { ok: true, value: { kind: 'fallback_policy', policyId } };
    }
    default:
      return fail('transition kind is invalid');
  }
}

function parseNextOn(raw: unknown): ParseResult<RoutingStep['nextOn']> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  const o = asRecord(raw);
  if (!o) return fail('nextOn must be an object');
  const nextOn: RoutingStep['nextOn'] = {};
  for (const [key, value] of Object.entries(o)) {
    if (!isRouteResult(key)) return fail(`nextOn has invalid result key "${key}"`);
    const t = parseTransition(value);
    if (!t.ok) return t;
    nextOn[key] = t.value;
  }
  return { ok: true, value: nextOn };
}

/** 信頼できない値を RoutingStep[] へ正規化・検証する。 */
export function parseRoutingSteps(raw: unknown): ParseResult<RoutingStep[]> {
  if (!Array.isArray(raw)) return fail('steps must be an array');
  if (raw.length > MAX_STEPS_PER_POLICY) return fail('too many steps');
  const steps: RoutingStep[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o) return fail('step must be an object');

    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (id === '') return fail('step id is required');
    if (id.length > MAX_STEP_ID_LENGTH) return fail('step id is too long');

    const endpointId = typeof o.endpointId === 'string' ? o.endpointId.trim() : '';
    if (endpointId === '') return fail('step endpointId is required');
    if (endpointId.length > MAX_STEP_ID_LENGTH) return fail('step endpointId is too long');

    if (!isRouteAction(o.action)) return fail('step action is invalid');

    if (typeof o.timeoutSeconds !== 'number' || !Number.isInteger(o.timeoutSeconds) || o.timeoutSeconds <= 0) {
      return fail('step timeoutSeconds must be a positive integer');
    }

    const nextOn = parseNextOn(o.nextOn);
    if (!nextOn.ok) return nextOn;

    steps.push({ id, endpointId, action: o.action, timeoutSeconds: o.timeoutSeconds, nextOn: nextOn.value });
  }
  return { ok: true, value: steps };
}

function parseName(raw: unknown): ParseResult<string> {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') return fail('policy name is required');
  if (name.length > MAX_POLICY_NAME_LENGTH) return fail('policy name is too long');
  return { ok: true, value: name };
}

/** 作成本体を検証する（name・steps 必須）。 */
export function parseRoutingPolicyBody(raw: unknown): ParseResult<ParsedRoutingPolicyBody> {
  const o = asRecord(raw);
  if (!o) return fail('policy body must be an object');

  const name = parseName(o.name);
  if (!name.ok) return name;

  const steps = parseRoutingSteps(o.steps);
  if (!steps.ok) return steps;

  const siteId = typeof o.siteId === 'string' && o.siteId.trim() !== '' ? o.siteId.trim() : undefined;
  const fallbackPolicyId =
    typeof o.fallbackPolicyId === 'string' && o.fallbackPolicyId.trim() !== '' ? o.fallbackPolicyId.trim() : undefined;
  const enabled = typeof o.enabled === 'boolean' ? o.enabled : true;

  return { ok: true, value: { name: name.value, siteId, enabled, fallbackPolicyId, steps: steps.value } };
}

/** 更新 patch を検証する（指定されたフィールドのみ返す）。 */
export function parseRoutingPolicyPatch(raw: unknown): ParseResult<Partial<ParsedRoutingPolicyBody>> {
  const o = asRecord(raw);
  if (!o) return fail('policy patch must be an object');

  const patch: Partial<ParsedRoutingPolicyBody> = {};

  if (o.name !== undefined) {
    const name = parseName(o.name);
    if (!name.ok) return name;
    patch.name = name.value;
  }
  if (o.steps !== undefined) {
    const steps = parseRoutingSteps(o.steps);
    if (!steps.ok) return steps;
    patch.steps = steps.value;
  }
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') return fail('enabled must be a boolean');
    patch.enabled = o.enabled;
  }
  if (o.siteId !== undefined) {
    patch.siteId = typeof o.siteId === 'string' && o.siteId.trim() !== '' ? o.siteId.trim() : undefined;
  }
  // fallbackPolicyId は null/空で「解除」を明示できるようにする（キーが在れば patch に載せる）。
  if ('fallbackPolicyId' in o) {
    patch.fallbackPolicyId =
      typeof o.fallbackPolicyId === 'string' && o.fallbackPolicyId.trim() !== '' ? o.fallbackPolicyId.trim() : undefined;
  }

  return { ok: true, value: patch };
}
