import { describe, expect, it } from 'vitest';
import {
  TRANSITION_KIND_OPTIONS,
  buildTransition,
  gotoStepChoices,
  transitionKindOf,
} from './transition-options';

describe('transition-options (goto_step 遷移編集 UI ロジック / #374)', () => {
  it('選択肢に goto_step（別の手順へ進む）を含む', () => {
    expect(TRANSITION_KIND_OPTIONS.map((o) => o.value)).toEqual([
      'default',
      'stop',
      'goto_step',
      'fallback_policy',
    ]);
  });

  it('transitionKindOf は未設定を default に、各 kind をそのまま読む', () => {
    expect(transitionKindOf(undefined)).toBe('default');
    expect(transitionKindOf({ kind: 'stop' })).toBe('stop');
    expect(transitionKindOf({ kind: 'goto_step', stepId: 's2' })).toBe('goto_step');
    expect(transitionKindOf({ kind: 'fallback_policy', policyId: 'p2' })).toBe('fallback_policy');
  });

  it('buildTransition: default は undefined（nextOn からキーを消す）', () => {
    expect(buildTransition('default')).toBeUndefined();
  });

  it('buildTransition: goto_step は選択した stepId を載せて往復する', () => {
    expect(buildTransition('goto_step', { stepId: 's3' })).toEqual({ kind: 'goto_step', stepId: 's3' });
  });

  it('buildTransition: goto_step で対象未選択は空 stepId（保存時に API 検証で弾く）', () => {
    expect(buildTransition('goto_step')).toEqual({ kind: 'goto_step', stepId: '' });
  });

  it('buildTransition: stop / fallback_policy も組み立てる', () => {
    expect(buildTransition('stop')).toEqual({ kind: 'stop' });
    expect(buildTransition('fallback_policy', { policyId: 'p9' })).toEqual({
      kind: 'fallback_policy',
      policyId: 'p9',
    });
  });

  it('gotoStepChoices: 全手順（自分含む）を接続先ラベルで返し、未解決は手順番号にフォールバック', () => {
    const steps = [
      { id: 's1', endpointId: 'ep-1' },
      { id: 's2', endpointId: 'ep-x' },
    ];
    const labelFor = (id: string) => (id === 'ep-1' ? '個人携帯' : undefined);
    expect(gotoStepChoices(steps, labelFor)).toEqual([
      { stepId: 's1', label: '個人携帯' },
      { stepId: 's2', label: '手順 2' },
    ]);
  });
});
