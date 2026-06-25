import { describe, it, expect } from 'vitest';
import { flowStepIndex, FLOW_STEP_COUNT } from './FlowStepper';

describe('FlowStepper (UX 進捗, #121)', () => {
  it('入力フロー4状態を 0..3 に対応づける', () => {
    expect(flowStepIndex('selectingPurpose')).toBe(0);
    expect(flowStepIndex('selectingTarget')).toBe(1);
    expect(flowStepIndex('inputVisitorInfo')).toBe(2);
    expect(flowStepIndex('confirming')).toBe(3);
    expect(FLOW_STEP_COUNT).toBe(4);
  });

  it('フロー外の状態は -1（非表示）', () => {
    expect(flowStepIndex('idle')).toBe(-1);
    expect(flowStepIndex('calling')).toBe(-1);
    expect(flowStepIndex('connected')).toBe(-1);
    expect(flowStepIndex('completed')).toBe(-1);
  });
});
