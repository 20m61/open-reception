import { describe, expect, it } from 'vitest';
import { turnAnswersFor } from './conversation-turn';
import {
  DEFAULT_TARGET_TAB,
  DEPARTMENT_ENTRY_ID,
  TARGET_TABS,
  initialTargetTabFor,
  nextTabFor,
  targetPanelFor,
  type TargetPanel,
} from './target-view-state';

function panel(over: Partial<Parameters<typeof targetPanelFor>[0]> = {}): TargetPanel {
  return targetPanelFor({
    tab: 'staff',
    staffResultCount: 3,
    selectableStaffCount: 3,
    departmentCount: 2,
    searching: false,
    chatAvailable: true,
    ...over,
  });
}

describe('相手選択の表示モード (#776)', () => {
  it('既定タブは担当者（開いた直後の主要な意思決定は「誰を呼ぶか」1 種類）', () => {
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
});

describe('0 件からの回復 (#776 / #322 AC3)', () => {
  it('検索して 0 件なら recovery パネル 1 つに集約する（警告と案内を重ねない）', () => {
    expect(panel({ staffResultCount: 0, searching: true })).toEqual({
      kind: 'recovery',
      messageKey: 'reception.searchNoResultsGuidance',
      actions: ['department', 'chat'],
    });
  });

  it('検索していないのに 0 件（名簿が空）なら「別の名前で」ではなく不在案内を出す', () => {
    expect(panel({ staffResultCount: 0, searching: false })).toEqual({
      kind: 'recovery',
      messageKey: 'reception.staffNotFound',
      actions: ['department', 'chat'],
    });
  });

  it('次の一手は他方のタブが先、チャットが後（主導線と競合させない）', () => {
    const result = panel({ staffResultCount: 0, searching: true });
    expect(result.kind === 'recovery' && result.actions[0]).toBe('department');
  });

  it('チャットを出せなければチャットの次の一手を出さない', () => {
    expect(panel({ staffResultCount: 0, searching: true, chatAvailable: false })).toEqual({
      kind: 'recovery',
      messageKey: 'reception.searchNoResultsGuidance',
      actions: ['department'],
    });
  });

  it('部署が 1 つも無ければ「部署から選ぶ」を出さない（空パネルへ送らない）', () => {
    // 出したら押せてしまい、押した先には何も無い。行き止まりを作らない。
    expect(panel({ staffResultCount: 0, searching: true, departmentCount: 0 })).toEqual({
      kind: 'recovery',
      messageKey: 'reception.searchNoResultsGuidance',
      actions: ['chat'],
    });
  });

  it('部署タブで部署が 0 件なら、空の枠ではなく recovery を出す', () => {
    expect(panel({ tab: 'department', departmentCount: 0 })).toEqual({
      kind: 'recovery',
      messageKey: 'reception.departmentNotFound',
      actions: ['staff', 'chat'],
    });
  });

  it('部署タブの recovery は、担当者が選べるときだけ担当者へ戻す', () => {
    // 検索語のせいで担当者も 0 件なら、戻しても同じ recovery に着く。
    expect(
      panel({ tab: 'department', departmentCount: 0, staffResultCount: 0, selectableStaffCount: 0 }),
    ).toEqual({
      kind: 'recovery',
      messageKey: 'reception.departmentNotFound',
      actions: ['chat'],
    });
  });

  it('担当者が全員不在なら「担当者から選ぶ」を出さない（押せないカードの前に置かない）', () => {
    // カードは出るが 1 枚も選べない。件数ではなく「選べる件数」で判断する。
    expect(
      panel({ tab: 'department', departmentCount: 0, staffResultCount: 4, selectableStaffCount: 0 }),
    ).toEqual({
      kind: 'recovery',
      messageKey: 'reception.departmentNotFound',
      actions: ['chat'],
    });
  });

  it('部署を出せないなら「部署または代表窓口をお選びください」と言わない', () => {
    // 次の一手から部署を外したのに文言だけ部署を指していると、消したはずの
    // 行き止まりへ言葉で案内することになる。
    expect(panel({ staffResultCount: 0, searching: false, departmentCount: 0 })).toEqual({
      kind: 'recovery',
      messageKey: 'reception.fallbackBody',
      actions: ['chat'],
    });
  });

  it('次の一手が 1 つも無いときは有人支援へ振る（何も出さない画面を作らない）', () => {
    expect(
      panel({
        staffResultCount: 0,
        selectableStaffCount: 0,
        departmentCount: 0,
        searching: true,
        chatAvailable: false,
      }),
    ).toEqual({
      kind: 'recovery',
      messageKey: 'reception.fallbackBody',
      actions: [],
    });
  });

  it('担当者タブが返すのは results か recovery のどちらか一方だけ', () => {
    for (const count of [0, 1, 2, 10]) {
      for (const searching of [true, false]) {
        const result = panel({ tab: 'staff', staffResultCount: count, searching });
        expect(result.kind).toBe(count > 0 ? 'staff-results' : 'recovery');
      }
    }
  });
});

describe('入口カードからの初期タブ (#776)', () => {
  it('「部署から選ぶ」で入ったら部署タブに着地する（押した導線と着地を一致させる）', () => {
    expect(initialTargetTabFor(DEPARTMENT_ENTRY_ID)).toBe('department');
  });

  it('それ以外の入口・入口不明は担当者タブ', () => {
    expect(initialTargetTabFor('callStaff')).toBe('staff');
    expect(initialTargetTabFor('delivery')).toBe('staff');
    expect(initialTargetTabFor(undefined)).toBe('staff');
  });

  it('参照している入口 id が待機画面の契約に実在する（rename でずれない）', () => {
    const ids = turnAnswersFor('idle', 'ja').map((a) => a.id);
    expect(ids).toContain(DEPARTMENT_ENTRY_ID);
  });
});

describe('tablist のキーボード操作 (#776 / WAI-ARIA APG)', () => {
  it('左右キーで隣のタブへ移り、端では巻き戻る', () => {
    expect(nextTabFor('staff', 'ArrowRight')).toBe('department');
    expect(nextTabFor('department', 'ArrowRight')).toBe('staff');
    expect(nextTabFor('department', 'ArrowLeft')).toBe('staff');
    expect(nextTabFor('staff', 'ArrowLeft')).toBe('department');
  });

  it('Home / End は端のタブへ移る', () => {
    expect(nextTabFor('department', 'Home')).toBe('staff');
    expect(nextTabFor('staff', 'End')).toBe('department');
  });

  it('関係ないキーは null（既定動作を妨げない）', () => {
    for (const key of ['Enter', ' ', 'ArrowDown', 'a', 'Tab']) {
      expect(nextTabFor('staff', key), `key=${key}`).toBeNull();
    }
  });
});
