import { afterEach, describe, expect, it } from 'vitest';
import type { DemoScenario } from './scenario';
import {
  __resetDemoScenarios,
  deleteSavedDemoScenario,
  getSavedDemoScenario,
  listSavedDemoScenarios,
  resolveDemoScenario,
  saveDemoScenario,
} from './store';

function custom(id: string, name = 'カスタム'): DemoScenario {
  return {
    id,
    name,
    initialMode: 'reception',
    visitorInputs: [{ mode: 'touch', value: 'meeting' }],
    simulatedResults: { call: ['answered'], runtime: 'ready' },
  };
}

afterEach(async () => {
  await __resetDemoScenarios();
});

describe('demo-studio store (Inc2 永続化)', () => {
  it('保存→一覧→取得ができる', async () => {
    await saveDemoScenario(custom('custom-a'));
    await saveDemoScenario(custom('custom-b'));
    const list = await listSavedDemoScenarios();
    expect(list.map((s) => s.id).sort()).toEqual(['custom-a', 'custom-b']);
    expect((await getSavedDemoScenario('custom-a'))?.id).toBe('custom-a');
    expect(await getSavedDemoScenario('nope')).toBeUndefined();
  });

  it('resolveDemoScenario は 保存済み→組込 の順で解決する', async () => {
    // 組込 id は保存が無ければ組込を返す。
    expect((await resolveDemoScenario('normal-visit'))?.name).toBe('担当者への通常訪問');
    // カスタム id は保存済みを返す。
    await saveDemoScenario(custom('custom-x', 'マイシナリオ'));
    expect((await resolveDemoScenario('custom-x'))?.name).toBe('マイシナリオ');
    // 未知 id は undefined。
    expect(await resolveDemoScenario('ghost')).toBeUndefined();
  });

  it('保存済みが組込 id を上書きする（保存が優先）', async () => {
    await saveDemoScenario(custom('normal-visit', '上書き済み'));
    expect((await resolveDemoScenario('normal-visit'))?.name).toBe('上書き済み');
  });

  it('削除できる', async () => {
    await saveDemoScenario(custom('custom-del'));
    await deleteSavedDemoScenario('custom-del');
    expect(await getSavedDemoScenario('custom-del')).toBeUndefined();
  });
});
