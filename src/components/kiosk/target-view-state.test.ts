import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TARGET_TAB,
  TARGET_TABS,
  targetPanelFor,
  type TargetPanel,
} from './target-view-state';

function panel(over: Partial<Parameters<typeof targetPanelFor>[0]> = {}): TargetPanel {
  return targetPanelFor({
    tab: 'staff',
    staffResultCount: 3,
    searching: false,
    chatAvailable: true,
    ...over,
  });
}

describe('相手選択の表示モード (#776)', () => {
  it('初期タブは担当者（開いた直後の主要な意思決定は「誰を呼ぶか」1 種類）', () => {
    expect(DEFAULT_TARGET_TAB).toBe('staff');
    expect(TARGET_TABS).toEqual(['staff', 'department']);
  });

  it('担当者タブでヒットが有れば担当者グリッドだけを出す', () => {
    expect(panel({ tab: 'staff', staffResultCount: 1 })).toEqual({ kind: 'staff-results' });
  });

  it('部署タブは部署グリッドだけを出す（担当者グリッドと同時に主表示しない）', () => {
    expect(panel({ tab: 'department', staffResultCount: 5 })).toEqual({ kind: 'departments' });
  });

  it('部署タブでは担当者が 0 件でも recovery ではなく部署グリッドを出す', () => {
    // 担当者側の 0 件判定がタブ判定を追い越すと、部署を選びに来た来訪者に
    // 「担当者が見つかりません」と言うことになる。
    expect(panel({ tab: 'department', staffResultCount: 0, searching: true })).toEqual({
      kind: 'departments',
    });
  });

  it('検索して 0 件なら recovery パネル 1 つに集約する（警告と案内を重ねない）', () => {
    const result = panel({ staffResultCount: 0, searching: true, chatAvailable: true });
    expect(result).toEqual({
      kind: 'staff-recovery',
      messageKey: 'reception.searchNoResultsGuidance',
      actions: ['department', 'chat'],
    });
  });

  it('次の一手は部署が先、チャットが後（主導線と競合させない）', () => {
    const result = panel({ staffResultCount: 0, searching: true });
    expect(result.kind === 'staff-recovery' && result.actions[0]).toBe('department');
  });

  it('チャットを出せないときはチャットを約束する文言を使わない', () => {
    expect(panel({ staffResultCount: 0, searching: true, chatAvailable: false })).toEqual({
      kind: 'staff-recovery',
      messageKey: 'reception.staffNotFound',
      actions: ['department'],
    });
  });

  it('検索していないのに 0 件（名簿が空）なら「別の名前で」ではなく不在案内を出す', () => {
    expect(panel({ staffResultCount: 0, searching: false, chatAvailable: true })).toEqual({
      kind: 'staff-recovery',
      messageKey: 'reception.staffNotFound',
      actions: ['department', 'chat'],
    });
  });

  it('担当者タブが返すのは results か recovery のどちらか一方だけ', () => {
    for (const count of [0, 1, 2, 10]) {
      for (const searching of [true, false]) {
        const result = panel({ tab: 'staff', staffResultCount: count, searching });
        expect(result.kind).toBe(count > 0 ? 'staff-results' : 'staff-recovery');
      }
    }
  });
});
