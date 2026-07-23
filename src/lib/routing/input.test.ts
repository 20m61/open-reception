import { describe, expect, it } from 'vitest';
import {
  MAX_POLICY_NAME_LENGTH,
  MAX_STEPS_PER_POLICY,
  MAX_STEP_ID_LENGTH,
  parseRoutingPolicyBody,
  parseRoutingPolicyPatch,
  parseRoutingSteps,
} from './input';

function step(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {}, ...over };
}

describe('parseRoutingSteps', () => {
  it('正常な step 列を正規化する（trim・順序保持）', () => {
    const r = parseRoutingSteps([
      { id: ' s1 ', endpointId: ' ep-1 ', action: 'notify', timeoutSeconds: 20, nextOn: {} },
      {
        id: 's2',
        endpointId: 'ep-2',
        action: 'announce_and_bridge',
        timeoutSeconds: 30,
        nextOn: { no_answer: { kind: 'goto_step', stepId: 's1' }, busy: { kind: 'stop' } },
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.value[0]).toEqual({ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} });
    expect(r.value[1]?.nextOn).toEqual({
      no_answer: { kind: 'goto_step', stepId: 's1' },
      busy: { kind: 'stop' },
    });
  });

  it('steps が配列でなければ invalid_input', () => {
    const r = parseRoutingSteps('nope');
    expect(r.ok).toBe(false);
  });

  it('action が不正なら invalid_input', () => {
    const r = parseRoutingSteps([{ id: 's1', endpointId: 'e', action: 'call', timeoutSeconds: 5, nextOn: {} }]);
    expect(r.ok).toBe(false);
  });

  it('timeoutSeconds が非正/非整数なら invalid_input', () => {
    expect(parseRoutingSteps([{ id: 's1', endpointId: 'e', action: 'notify', timeoutSeconds: 0, nextOn: {} }]).ok).toBe(
      false,
    );
    expect(
      parseRoutingSteps([{ id: 's1', endpointId: 'e', action: 'notify', timeoutSeconds: 1.5, nextOn: {} }]).ok,
    ).toBe(false);
  });

  it('id/endpointId が空なら invalid_input', () => {
    expect(parseRoutingSteps([{ id: '', endpointId: 'e', action: 'notify', timeoutSeconds: 5, nextOn: {} }]).ok).toBe(
      false,
    );
    expect(parseRoutingSteps([{ id: 's', endpointId: '  ', action: 'notify', timeoutSeconds: 5, nextOn: {} }]).ok).toBe(
      false,
    );
  });

  it('入力サイズ上限: steps 件数が上限超過なら invalid_input（第5wave nit）', () => {
    const many = Array.from({ length: MAX_STEPS_PER_POLICY + 1 }, (_, i) => step({ id: `s${i}` }));
    expect(parseRoutingSteps(many).ok).toBe(false);
    const atLimit = Array.from({ length: MAX_STEPS_PER_POLICY }, (_, i) => step({ id: `s${i}` }));
    expect(parseRoutingSteps(atLimit).ok).toBe(true);
  });

  it('入力サイズ上限: step id / endpointId が長すぎると invalid_input（第5wave nit）', () => {
    const long = 'x'.repeat(MAX_STEP_ID_LENGTH + 1);
    expect(parseRoutingSteps([step({ id: long })]).ok).toBe(false);
    expect(parseRoutingSteps([step({ endpointId: long })]).ok).toBe(false);
  });

  it('nextOn のキーが RouteResult でなければ invalid_input', () => {
    const r = parseRoutingSteps([
      { id: 's', endpointId: 'e', action: 'notify', timeoutSeconds: 5, nextOn: { nope: { kind: 'stop' } } },
    ]);
    expect(r.ok).toBe(false);
  });

  it('nextOn の transition が不正な kind なら invalid_input', () => {
    const r = parseRoutingSteps([
      { id: 's', endpointId: 'e', action: 'notify', timeoutSeconds: 5, nextOn: { busy: { kind: 'jump' } } },
    ]);
    expect(r.ok).toBe(false);
  });

  it('goto_step は stepId 文字列必須、fallback_policy は policyId 文字列必須', () => {
    expect(
      parseRoutingSteps([
        { id: 's', endpointId: 'e', action: 'notify', timeoutSeconds: 5, nextOn: { busy: { kind: 'goto_step' } } },
      ]).ok,
    ).toBe(false);
    expect(
      parseRoutingSteps([
        {
          id: 's',
          endpointId: 'e',
          action: 'notify',
          timeoutSeconds: 5,
          nextOn: { busy: { kind: 'fallback_policy', policyId: 'p2' } },
        },
      ]).ok,
    ).toBe(true);
  });
});

describe('parseRoutingPolicyBody (作成)', () => {
  it('name と steps から本体を組む（enabled 既定 true）', () => {
    const r = parseRoutingPolicyBody({
      name: ' 標準ルート ',
      steps: [{ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe('標準ルート');
    expect(r.value.enabled).toBe(true);
    expect(r.value.siteId).toBeUndefined();
    expect(r.value.fallbackPolicyId).toBeUndefined();
  });

  it('siteId・fallbackPolicyId・enabled=false を受け付ける', () => {
    const r = parseRoutingPolicyBody({
      name: 'x',
      siteId: 'site-a1',
      enabled: false,
      fallbackPolicyId: 'p-fallback',
      steps: [{ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.siteId).toBe('site-a1');
    expect(r.value.enabled).toBe(false);
    expect(r.value.fallbackPolicyId).toBe('p-fallback');
  });

  it('name 空は invalid_input', () => {
    const r = parseRoutingPolicyBody({ name: '  ', steps: [] });
    expect(r.ok).toBe(false);
  });

  it('入力サイズ上限: name が長すぎると invalid_input（第5wave nit）', () => {
    const longName = 'あ'.repeat(MAX_POLICY_NAME_LENGTH + 1);
    const r = parseRoutingPolicyBody({ name: longName, steps: [step()] });
    expect(r.ok).toBe(false);
  });

  it('steps 欠落は invalid_input', () => {
    const r = parseRoutingPolicyBody({ name: 'x' });
    expect(r.ok).toBe(false);
  });
});

describe('parseRoutingPolicyPatch (更新)', () => {
  it('指定フィールドのみ返す', () => {
    const r = parseRoutingPolicyPatch({ name: '新名称' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ name: '新名称' });
  });

  it('steps を含む patch を検証する', () => {
    const r = parseRoutingPolicyPatch({
      steps: [{ id: 's1', endpointId: 'ep-1', action: 'notify', timeoutSeconds: 20, nextOn: {} }],
      enabled: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.steps).toHaveLength(1);
    expect(r.value.enabled).toBe(false);
  });

  it('不正な steps を含む patch は invalid_input', () => {
    const r = parseRoutingPolicyPatch({ steps: [{ id: '', endpointId: 'e', action: 'notify', timeoutSeconds: 1, nextOn: {} }] });
    expect(r.ok).toBe(false);
  });

  it('fallbackPolicyId を null で送ると解除（undefined）になる', () => {
    const r = parseRoutingPolicyPatch({ fallbackPolicyId: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('fallbackPolicyId' in r.value).toBe(true);
    expect(r.value.fallbackPolicyId).toBeUndefined();
  });
});
