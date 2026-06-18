/**
 * 担当者ドメイン型 (issue #13, #26)。
 */

/** mock 呼び出しの結果分岐。MockCallAdapter のみが参照し、本番 adapter は無視する (issue #20)。 */
export type MockCallOutcome = 'success' | 'no_answer' | 'failure' | 'timeout';

/** 呼び出し先の種別 (issue #26)。 */
export type CallTargetType = 'vonage' | 'email' | 'slack' | 'phone' | 'webhook';

export const CALL_TARGET_TYPES: CallTargetType[] = ['vonage', 'email', 'slack', 'phone', 'webhook'];

export type CallTarget = {
  type: CallTargetType;
  value: string;
  /** 0 始まりの優先順位（小さいほど優先）。 */
  priority: number;
  enabled: boolean;
};

export type Staff = {
  id: string;
  displayName: string;
  kana?: string;
  aliases: string[];
  departmentId: string;
  enabled: boolean;
  available: boolean;
  /** 呼び出し先（優先順位順）。 */
  callTargets: CallTarget[];
  /** 代替担当者の staff id（不在/未応答時の導線）。 */
  fallbackStaffIds: string[];
  /** mock 環境での呼び出し結果。未設定時は success 扱い。 */
  mockCallOutcome?: MockCallOutcome;
};

export function isCallTargetType(value: unknown): value is CallTargetType {
  return typeof value === 'string' && (CALL_TARGET_TYPES as string[]).includes(value);
}

/** 入力配列から callTargets を正規化する（priority を index で再採番）。 */
export function normalizeCallTargets(input: unknown): CallTarget[] {
  if (!Array.isArray(input)) return [];
  const result: CallTarget[] = [];
  input.forEach((item) => {
    if (typeof item !== 'object' || item === null) return;
    const o = item as Record<string, unknown>;
    if (!isCallTargetType(o.type)) return;
    if (typeof o.value !== 'string' || o.value.trim() === '') return;
    result.push({
      type: o.type,
      value: o.value.trim(),
      priority: result.length,
      enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    });
  });
  return result;
}
