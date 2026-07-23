import { describe, expect, it } from 'vitest';
import { getDemoScenario } from './scenarios';
import {
  addTurn,
  cloneBuiltinToDraft,
  emptyDraft,
  moveTurn,
  removeTurnAt,
  setSimulatedResults,
  updateTurnAt,
  type DemoScenarioDraft,
} from './editor';

function base(): DemoScenarioDraft {
  return cloneBuiltinToDraft(getDemoScenario('normal-visit')!, 'custom-1');
}

describe('demo-studio editor (Inc2 純関数)', () => {
  it('組込テンプレートを複製すると新 id・複製名・深いコピーになる', () => {
    const src = getDemoScenario('normal-visit')!;
    const draft = cloneBuiltinToDraft(src, 'custom-1');
    expect(draft.id).toBe('custom-1');
    expect(draft.name).toContain(src.name);
    expect(draft.name).not.toBe(src.name);
    expect(draft.visitorInputs).toEqual(src.visitorInputs);
    // 深いコピー: draft を弄っても元テンプレートに波及しない。
    draft.visitorInputs.push({ mode: 'text', value: 'x' });
    expect(src.visitorInputs).toHaveLength(2);
    // simulatedResults.call も独立した配列参照になっている（元テンプレートと共有しない）。
    const tmpl = getDemoScenario('no-answer-escalation')!;
    const d2 = cloneBuiltinToDraft(tmpl, 'c2');
    expect(d2.simulatedResults.call).not.toBe(tmpl.simulatedResults.call);
    expect(d2.simulatedResults.call).toEqual(tmpl.simulatedResults.call);
  });

  it('emptyDraft は最小の編集可能な骨組みを返す', () => {
    const d = emptyDraft('custom-blank', '新規シナリオ');
    expect(d.id).toBe('custom-blank');
    expect(d.initialMode).toBe('reception');
    expect(d.visitorInputs).toEqual([]);
  });

  it('ターンの追加・更新・削除・移動', () => {
    let d = base();
    d = addTurn(d, { mode: 'text', value: '追加' });
    expect(d.visitorInputs.at(-1)).toEqual({ mode: 'text', value: '追加' });

    d = updateTurnAt(d, 0, { value: '変更' });
    expect(d.visitorInputs[0]).toEqual({ mode: 'touch', value: '変更' });

    const before = d.visitorInputs.map((t) => t.value);
    d = moveTurn(d, 0, 1);
    expect(d.visitorInputs.map((t) => t.value)).toEqual([before[1], before[0], before[2]]);

    const count = d.visitorInputs.length;
    d = removeTurnAt(d, 0);
    expect(d.visitorInputs).toHaveLength(count - 1);
  });

  it('境界: 先頭を上へ/末尾を下へ移動しても変化しない', () => {
    const d = base();
    expect(moveTurn(d, 0, -1).visitorInputs).toEqual(d.visitorInputs);
    expect(moveTurn(d, d.visitorInputs.length - 1, 1).visitorInputs).toEqual(d.visitorInputs);
  });

  it('setSimulatedResults は部分更新（他フィールドを保持）', () => {
    let d = base();
    d = setSimulatedResults(d, { qr: 'valid' });
    expect(d.simulatedResults.qr).toBe('valid');
    expect(d.simulatedResults.runtime).toBe('ready');
    d = setSimulatedResults(d, { call: ['no_answer', 'answered'] });
    expect(d.simulatedResults.call).toEqual(['no_answer', 'answered']);
    expect(d.simulatedResults.qr).toBe('valid');
  });

  it('純関数: 入力 draft を破壊変更しない', () => {
    const d = base();
    const snapshot = JSON.stringify(d);
    addTurn(d, { mode: 'text', value: 'x' });
    updateTurnAt(d, 0, { value: 'y' });
    removeTurnAt(d, 0);
    moveTurn(d, 0, 1);
    setSimulatedResults(d, { runtime: 'stopped' });
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});
