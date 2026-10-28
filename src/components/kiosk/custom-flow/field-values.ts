/**
 * カスタムフロー入力値の純ヘルパ (issue #100, increment 1)。
 *
 * 受付端末のフォーム入力（FlowFieldValues）について、初期値生成・必須充足判定を純関数で
 * 提供する。UI（React）から切り離してユニットテストできるようにする。
 */
import type { FlowField } from '@/domain/reception/custom-flow';
import { isVisitorNameWithinLimit, normalizeVisitorNameInput } from '@/domain/reception/session';
import type { FlowFieldValues } from './types';

/** フィールド定義から初期入力値を作る（text/select は空文字、checkbox は false）。 */
export function initialFieldValues(fields: readonly FlowField[]): FlowFieldValues {
  const values: FlowFieldValues = {};
  for (const f of fields) {
    values[f.key] = f.type === 'checkbox' ? false : '';
  }
  return values;
}

/** 単一フィールドが必須を満たすか（required=false は常に true）。 */
export function isFieldSatisfied(field: FlowField, value: string | boolean | undefined): boolean {
  if (!field.required) return true;
  if (field.type === 'checkbox') return value === true;
  return typeof value === 'string' && value.trim() !== '';
}

/** 必須フィールドがすべて入力済みか（送信可否の判定）。 */
export function areRequiredFieldsSatisfied(
  fields: readonly FlowField[],
  values: FlowFieldValues,
): boolean {
  return fields.every((f) => isFieldSatisfied(f, values[f.key]));
}

/** 未充足の必須フィールド key 一覧を返す（UI のエラー表示用）。 */
export function unsatisfiedRequiredKeys(
  fields: readonly FlowField[],
  values: FlowFieldValues,
): string[] {
  return fields.filter((f) => !isFieldSatisfied(f, values[f.key])).map((f) => f.key);
}

/** 氏名として扱う欄の key（`flowValuesToVisitorInfo` が `VisitorInfo.name` へ写す欄）。 */
export const VISITOR_NAME_FIELD_KEY = 'name';

/**
 * 氏名の欄が上限（`VISITOR_NAME_MAX_LENGTH`）を超えているか (#1290)。音声とキーボードに
 * 同じ上限を課す（ADR 0011 §3-e）。数え方は `isVisitorNameWithinLimit`（code point、前後の
 * 空白・ゼロ幅文字を除く）。HTML の `maxLength` は UTF-16 単位なので使わない。
 */
export function isNameFieldTooLong(fields: readonly FlowField[], values: FlowFieldValues): boolean {
  if (!fields.some((f) => f.key === VISITOR_NAME_FIELD_KEY)) return false;
  const value = values[VISITOR_NAME_FIELD_KEY];
  return typeof value === 'string' && !isVisitorNameWithinLimit(normalizeVisitorNameInput(value));
}

/** 送信できるか: 必須がすべて埋まり、氏名が上限以内。 */
export function canSubmitFlowValues(fields: readonly FlowField[], values: FlowFieldValues): boolean {
  return areRequiredFieldsSatisfied(fields, values) && !isNameFieldTooLong(fields, values);
}

/**
 * 音声で確定した氏名を欄へ入れる（ADR 0011 §5、#1290）。`name` 以外の欄は変えない。
 * `complete` は、入れた後に送信できる（必須がすべて埋まった）か。埋まっていなければ
 * 呼び出し側は送信せず、残りの欄の入力を案内する。
 */
export function applyVoiceName(
  fields: readonly FlowField[],
  values: FlowFieldValues,
  name: string,
): { values: FlowFieldValues; complete: boolean } {
  if (!fields.some((f) => f.key === VISITOR_NAME_FIELD_KEY)) return { values, complete: false };
  const next = { ...values, [VISITOR_NAME_FIELD_KEY]: normalizeVisitorNameInput(name) };
  return { values: next, complete: canSubmitFlowValues(fields, next) };
}
