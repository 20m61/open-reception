import { describe, expect, it } from 'vitest';
import {
  defaultReceptionFlow,
  enabledFlowsForDisplay,
  isFieldType,
  isFlowStepKind,
  sortFlowsForDisplay,
  validateCallRouteId,
  validateField,
  validateFields,
  validateReceptionFlow,
  validateSteps,
  type ReceptionFlowDraft,
} from './custom-flow';

const baseDraft = (over: Partial<ReceptionFlowDraft> = {}): ReceptionFlowDraft => ({
  purposeKey: 'interview',
  displayName: '面接',
  order: 1,
  steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
  fields: [{ key: 'name', label: 'お名前', type: 'text', required: true }],
  ...over,
});

describe('custom-flow type guards (#100)', () => {
  it('isFlowStepKind / isFieldType', () => {
    expect(isFlowStepKind('confirm')).toBe(true);
    expect(isFlowStepKind('nope')).toBe(false);
    expect(isFieldType('select')).toBe(true);
    expect(isFieldType('radio')).toBe(false);
  });
});

describe('validateSteps (#100)', () => {
  it('必須ステップ confirm/call を含む並びは有効', () => {
    const r = validateSteps(['purpose', 'confirm', 'call']);
    expect(r.ok).toBe(true);
  });
  it('confirm が無いと無効', () => {
    const r = validateSteps(['purpose', 'call']);
    expect(r.ok).toBe(false);
  });
  it('未知のステップは無効', () => {
    expect(validateSteps(['purpose', 'foo', 'confirm', 'call']).ok).toBe(false);
  });
  it('重複ステップは無効', () => {
    expect(validateSteps(['confirm', 'confirm', 'call']).ok).toBe(false);
  });
  it('confirm は call より前でなければ無効', () => {
    expect(validateSteps(['call', 'confirm']).ok).toBe(false);
  });
  it('空配列は無効', () => {
    expect(validateSteps([]).ok).toBe(false);
  });
});

describe('validateField (#100)', () => {
  it('text フィールドを正規化する', () => {
    const r = validateField({ key: 'name', label: '  お名前 ', type: 'text', required: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ key: 'name', label: 'お名前', type: 'text', required: true });
  });
  it('select は options 必須', () => {
    expect(validateField({ key: 'x', label: 'X', type: 'select' }).ok).toBe(false);
    const r = validateField({ key: 'x', label: 'X', type: 'select', options: ['a', 'b'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.options).toEqual(['a', 'b']);
  });
  it('空 options の select は無効', () => {
    expect(validateField({ key: 'x', label: 'X', type: 'select', options: [] }).ok).toBe(false);
  });
  it('不正な key は無効', () => {
    expect(validateField({ key: 'Bad Key', label: 'X', type: 'text' }).ok).toBe(false);
  });
  it('required 未指定は false 扱い', () => {
    const r = validateField({ key: 'k', label: 'L', type: 'text' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.required).toBe(false);
  });
});

describe('validateFields (#100)', () => {
  it('未指定は空配列', () => {
    const r = validateFields(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
  it('key 重複は無効', () => {
    const r = validateFields([
      { key: 'name', label: 'A', type: 'text' },
      { key: 'name', label: 'B', type: 'text' },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe('validateReceptionFlow (#100)', () => {
  it('正常なドラフトを正規化し enabled=true を付ける', () => {
    const r = validateReceptionFlow(baseDraft());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.purposeKey).toBe('interview');
      expect(r.value.enabled).toBe(true);
      expect(r.value.order).toBe(1);
    }
  });
  it('displayName 空は無効', () => {
    expect(validateReceptionFlow(baseDraft({ displayName: '   ' })).ok).toBe(false);
  });
  it('purposeKey 不正は無効', () => {
    expect(validateReceptionFlow(baseDraft({ purposeKey: 'BAD' })).ok).toBe(false);
  });
  it('order 負数は無効', () => {
    expect(validateReceptionFlow(baseDraft({ order: -1 })).ok).toBe(false);
  });
  it('空文字 description は undefined に正規化', () => {
    const r = validateReceptionFlow(baseDraft({ description: '   ' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.description).toBeUndefined();
  });
});

describe('validateCallRouteId (#100)', () => {
  it('未指定・空文字は割り当てなし(undefined)', () => {
    expect(validateCallRouteId(undefined)).toEqual({ ok: true, value: undefined });
    expect(validateCallRouteId(null)).toEqual({ ok: true, value: undefined });
    expect(validateCallRouteId('   ')).toEqual({ ok: true, value: undefined });
  });

  it('有効な ID は trim して採用する', () => {
    expect(validateCallRouteId(' route-abc ')).toEqual({ ok: true, value: 'route-abc' });
  });

  it('文字列以外・長すぎる ID は不正', () => {
    expect(validateCallRouteId(123).ok).toBe(false);
    expect(validateCallRouteId('x'.repeat(129)).ok).toBe(false);
  });

  it('validateReceptionFlow は callRouteId を取り込み、不正なら失敗する', () => {
    const ok = validateReceptionFlow(baseDraft({ callRouteId: 'route-1' }));
    expect(ok.ok && ok.value.callRouteId).toBe('route-1');
    const cleared = validateReceptionFlow(baseDraft({ callRouteId: '' }));
    expect(cleared.ok && cleared.value.callRouteId).toBeUndefined();
    expect(validateReceptionFlow(baseDraft({ callRouteId: 123 })).ok).toBe(false);
  });
});

describe('default & sorting helpers (#100)', () => {
  it('defaultReceptionFlow は全ステップを含む', () => {
    const f = defaultReceptionFlow();
    expect(f.steps).toEqual(['purpose', 'target', 'visitorInfo', 'confirm', 'call']);
    expect(f.enabled).toBe(true);
  });
  it('sortFlowsForDisplay は order → 表示名で安定整列', () => {
    const sorted = sortFlowsForDisplay([
      { order: 2, displayName: 'B' },
      { order: 1, displayName: 'Z' },
      { order: 1, displayName: 'A' },
    ]);
    expect(sorted.map((f) => f.displayName)).toEqual(['A', 'Z', 'B']);
  });
  it('enabledFlowsForDisplay は無効を除外し整列', () => {
    const r = enabledFlowsForDisplay([
      { order: 1, displayName: 'A', enabled: false },
      { order: 0, displayName: 'B', enabled: true },
    ]);
    expect(r.map((f) => f.displayName)).toEqual(['B']);
  });
});
