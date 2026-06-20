/**
 * カスタムフロー入力値の純ヘルパ (issue #100, increment 1)。
 *
 * 受付端末のフォーム入力（FlowFieldValues）について、初期値生成・必須充足判定を純関数で
 * 提供する。UI（React）から切り離してユニットテストできるようにする。
 */
import type { FlowField } from '@/domain/reception/custom-flow';
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
