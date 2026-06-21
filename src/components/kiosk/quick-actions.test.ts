import { describe, expect, it } from 'vitest';
import { RECEPTION_STATES, type ReceptionState } from '@/domain/reception/state';
import {
  availableActions,
  isActionAllowed,
  REQUIRES_CONFIRMATION_ACTIONS,
} from '@/domain/reception/ui-contract';
import {
  escapeHatchesFor,
  quickActionsFor,
  QUICK_ACTION_INTENTS,
} from './quick-actions';

describe('quickActionsFor', () => {
  it('idle で 5 つの主要 CTA を返す（担当者を呼ぶ/QR/部署/配送・納品/その他）', () => {
    const actions = quickActionsFor('idle');
    expect(actions.map((a) => a.intent)).toEqual([...QUICK_ACTION_INTENTS]);
  });

  it('idle 以外ではクイックアクションを出さない（入口は idle のみ）', () => {
    for (const state of RECEPTION_STATES) {
      if (state === 'idle') continue;
      expect(quickActionsFor(state)).toHaveLength(0);
    }
  });

  it('checkin 以外の CTA は契約上 start が許可される idle でのみ出る', () => {
    expect(isActionAllowed('idle', 'start')).toBe(true);
    const normal = quickActionsFor('idle').filter((a) => !a.isCheckin);
    expect(normal.length).toBeGreaterThan(0);
  });

  it('checkin CTA はモード切替（START を使わない）ので isCheckin で表現する', () => {
    const checkin = quickActionsFor('idle').find((a) => a.intent === 'checkin');
    expect(checkin?.isCheckin).toBe(true);
    expect(checkin?.presetPurpose).toBeUndefined();
  });

  it('配送・納品/その他/部署は目的を preset し、目的選択を短縮できる', () => {
    const find = (intent: string) => quickActionsFor('idle').find((a) => a.intent === intent);
    expect(find('delivery')?.presetPurpose).toBe('delivery');
    expect(find('other')?.presetPurpose).toBe('other');
    expect(find('department')?.presetPurpose).toBe('meeting');
  });

  it('クイックアクションは重要操作（確認必須）を直接起こさない', () => {
    // クイックアクションは preset/checkin/start 由来のみ。confirm/submitVisitorInfo を含まない。
    for (const a of quickActionsFor('idle')) {
      expect(REQUIRES_CONFIRMATION_ACTIONS.has(a.intent as never)).toBe(false);
    }
  });
});

describe('escapeHatchesFor', () => {
  it('idle では逃げ道を出さない（戻る先が無い）', () => {
    expect(escapeHatchesFor('idle')).toHaveLength(0);
  });

  it('表示する逃げ道は必ず契約 availableActions の部分集合（許可外を出さない）', () => {
    for (const state of RECEPTION_STATES) {
      const allowed = availableActions(state);
      for (const hatch of escapeHatchesFor(state)) {
        expect(allowed.has(hatch.action)).toBe(true);
      }
    }
  });

  it('selectingTarget では 戻る・キャンセル を出す（state.ts 遷移表に整合）', () => {
    const actions = escapeHatchesFor('selectingTarget').map((h) => h.action);
    expect(actions).toContain('back');
    expect(actions).toContain('cancel');
  });

  it('confirming では 戻る（修正）・キャンセル を出す', () => {
    const actions = escapeHatchesFor('confirming').map((h) => h.action);
    expect(actions).toContain('back');
    expect(actions).toContain('cancel');
  });

  it('failed/timeout では 人に繋ぐ(useFallback)・最初に戻る(reset) を出す', () => {
    for (const state of ['failed', 'timeout'] as ReceptionState[]) {
      const actions = escapeHatchesFor(state).map((h) => h.action);
      expect(actions).toContain('useFallback');
      expect(actions).toContain('reset');
    }
  });

  it('逃げ道に確認必須の重要操作は含めない', () => {
    for (const state of RECEPTION_STATES) {
      for (const hatch of escapeHatchesFor(state)) {
        expect(REQUIRES_CONFIRMATION_ACTIONS.has(hatch.action)).toBe(false);
      }
    }
  });
});
