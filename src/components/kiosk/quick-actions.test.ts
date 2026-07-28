import { describe, expect, it } from 'vitest';
import { RECEPTION_STATES, type ReceptionState } from '@/domain/reception/state';
import {
  availableActions,
  escapeHatchActionsFor,
  isActionAllowed,
  REQUIRES_CONFIRMATION_ACTIONS,
} from '@/domain/reception/ui-contract';
import { DICTIONARIES, SUPPORTED_LOCALES, makeT } from '@/lib/i18n';
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
  it('どのアクションを出すかは全状態で契約と一致する（真実源は 1 つ・#422 地ならし）', () => {
    // 層は意図的に分かれている: **どの後退アクションか**は契約（domain）、
    // label/variant/testId は UI 側（本ファイル）。比較するのはアクションの集合だけ。
    //
    // かつてその「どのアクションか」の判断が二重実装され、`confirming` の back 抑制
    // （#240/#325）が契約側に無いという食い違いがあった。片方を直してももう片方に
    // 伝播しないため、判断を契約へ寄せたうえで一致をここで固定する。これが崩れると、
    // 画面を ConversationTurnView へ配線した時点で挙動が変わる。
    for (const state of RECEPTION_STATES) {
      const ui = escapeHatchesFor(state).map((h) => h.action);
      const contract = escapeHatchActionsFor(state).map((h) => h.action);
      expect(ui, state).toEqual(contract);
    }
  });

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

  it('後退語彙は 戻る(back)・最初に戻る(reset) の 2 語だけ（キャンセル/人に繋ぐは出さない・#325）', () => {
    // #325: 後退系コントロールを 2 語に集約。cancel は最初に戻る(reset)へ統合、
    // useFallback（人に繋ぐ/代替連絡先）は前進系の主 CTA としてコンテンツ側に置く。
    for (const state of RECEPTION_STATES) {
      const actions = escapeHatchesFor(state).map((h) => h.action);
      expect(actions).not.toContain('cancel');
      expect(actions).not.toContain('useFallback');
      for (const a of actions) {
        expect(['back', 'reset']).toContain(a);
      }
    }
  });

  it('selectingTarget では 戻る・最初に戻る を出す（内容がビューポートを超え得るため常設 back を残す）', () => {
    const actions = escapeHatchesFor('selectingTarget').map((h) => h.action);
    expect(actions).toContain('back');
    expect(actions).toContain('reset');
  });

  it('confirming はバーに back を出さない（フッターの修正するに集約・#240/#325）', () => {
    // 確認画面は短い要約でフッターの confirm-back（修正する）が常に到達可能なため、二重の 戻る を整理する。
    // バーに残る後退系は 最初に戻る(reset) のみ。
    const actions = escapeHatchesFor('confirming').map((h) => h.action);
    expect(actions).not.toContain('back');
    expect(actions).toEqual(['reset']);
  });

  it('failed/timeout のバーは 最初に戻る(reset) のみ（人に繋ぐはコンテンツの主 CTA・#325）', () => {
    for (const state of ['failed', 'timeout'] as ReceptionState[]) {
      const actions = escapeHatchesFor(state).map((h) => h.action);
      expect(actions).toEqual(['reset']);
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

/**
 * 逃げ道バーは**全画面に常設**される唯一の後退導線 (#325)。ここが日本語固定だと、
 * 言語を選んだ来訪者が受付中ずっと日本語のボタンを見続けることになる（#327 の受入条件
 * 「English/한국어/中文 で待機→受付→退館の全導線に未翻訳文言が出ない」に反する）。
 */
describe('逃げ道の文言は i18n カタログ経由 (#327)', () => {
  it('生の文字列ではなくメッセージキーを持つ', () => {
    const hatches = escapeHatchesFor('selectingTarget');
    expect(hatches.map((h) => h.labelKey)).toEqual(['reception.back', 'reception.reset']);
  });

  it('全ロケールに訳が実在する（ja へフォールバックしていない）', () => {
    // `makeT` は未訳キーを ja へフォールバックするため、`tr()` の戻り値が非空でも
    // 「訳が在る」ことにはならない。辞書を直接見る。
    for (const locale of SUPPORTED_LOCALES) {
      for (const hatch of escapeHatchesFor('selectingTarget')) {
        const value = DICTIONARIES[locale][hatch.labelKey];
        expect(value, `${locale}/${hatch.action}`).toBeTruthy();
      }
    }
    // 英語で日本語が出ないことを具体値で固定する（キーの取り違えを検出する）。
    const en = makeT('en');
    expect(escapeHatchesFor('selectingTarget').map((h) => en(h.labelKey))).toEqual([
      'Back',
      'Start over',
    ]);
  });

  it('クイックアクションは表示文言を持たない（表示は呼び出し側が i18n で解決する）', () => {
    // 以前は未使用の日本語 label/description を持っており、`action.label` を描画すると
    // 多言語が崩れる罠になっていた。型から消して罠ごと無くす。
    for (const action of quickActionsFor('idle')) {
      expect(action).not.toHaveProperty('label');
      expect(action).not.toHaveProperty('description');
    }
  });
});
