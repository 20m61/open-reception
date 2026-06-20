import { describe, expect, it } from 'vitest';
import type { FlowField } from '@/domain/reception/custom-flow';
import {
  areRequiredFieldsSatisfied,
  initialFieldValues,
  isFieldSatisfied,
  unsatisfiedRequiredKeys,
} from './field-values';

const nameField: FlowField = { key: 'name', label: 'お名前', type: 'text', required: true };
const noteField: FlowField = { key: 'note', label: 'メモ', type: 'textarea', required: false };
const agreeField: FlowField = { key: 'agree', label: '同意', type: 'checkbox', required: true };
const deptField: FlowField = {
  key: 'dept',
  label: '部署',
  type: 'select',
  required: false,
  options: ['総務', '営業'],
};
const fields: FlowField[] = [nameField, noteField, agreeField, deptField];

describe('initialFieldValues (#100)', () => {
  it('checkbox は false、その他は空文字', () => {
    expect(initialFieldValues(fields)).toEqual({ name: '', note: '', agree: false, dept: '' });
  });
});

describe('isFieldSatisfied (#100)', () => {
  it('必須 text は空白のみだと不足', () => {
    expect(isFieldSatisfied(nameField, '   ')).toBe(false);
    expect(isFieldSatisfied(nameField, '山田')).toBe(true);
  });
  it('任意フィールドは常に満たす', () => {
    expect(isFieldSatisfied(noteField, '')).toBe(true);
  });
  it('必須 checkbox は true が必要', () => {
    expect(isFieldSatisfied(agreeField, false)).toBe(false);
    expect(isFieldSatisfied(agreeField, true)).toBe(true);
  });
});

describe('areRequiredFieldsSatisfied / unsatisfiedRequiredKeys (#100)', () => {
  it('必須未充足を検出', () => {
    const values = { name: '', note: '', agree: false, dept: '' };
    expect(areRequiredFieldsSatisfied(fields, values)).toBe(false);
    expect(unsatisfiedRequiredKeys(fields, values).sort()).toEqual(['agree', 'name']);
  });
  it('必須充足で送信可', () => {
    const values = { name: '山田', note: '', agree: true, dept: '' };
    expect(areRequiredFieldsSatisfied(fields, values)).toBe(true);
    expect(unsatisfiedRequiredKeys(fields, values)).toEqual([]);
  });
});
