import { describe, expect, it } from 'vitest';
import { conversationTurnFor, RECEPTION_STATES } from '@/domain/reception/ui-contract';
import { DICTIONARIES, type MessageKey as I18nMessageKey } from '@/lib/i18n';
import { screenTitleFor, STATES_WITH_SCREEN_TITLE } from './conversation-turn';

function ja(key: I18nMessageKey): string {
  const value = DICTIONARIES.ja[key];
  if (value === undefined) throw new Error(`ja 辞書に ${key} が無い`);
  return value;
}

describe('kiosk conversation-turn: 主指示の解決 (#422 inc5-b)', () => {
  it('主指示を持つ画面は、現行の見出しと同じ訳文を返す（配線しても文言は変わらない）', () => {
    // 移行前の `<h1 className="screen__title">` が使っていた i18n キーそのもの。
    // ここがズレると配線した時点で見出しが変わる（挙動不変の担保）。
    expect(screenTitleFor('idle', 'ja')).toBe(ja('reception.purposePrompt'));
    expect(screenTitleFor('selectingPurpose', 'ja')).toBe(ja('reception.purposeDetailPrompt'));
    expect(screenTitleFor('selectingTarget', 'ja')).toBe(ja('reception.targetPrompt'));
    expect(screenTitleFor('inputVisitorInfo', 'ja')).toBe(ja('reception.visitorInfoPrompt'));
    expect(screenTitleFor('confirming', 'ja')).toBe(ja('reception.confirm'));
  });

  it('主指示を持たない画面は null を返す（結果系は ResultPanel の message が担う）', () => {
    // 結果系の文言は `{target}` の差し込みを含み、契約の静的文言とは対応づかない。
    // 見出しが無い画面に空の <h1> を生やさないため、無いことを明示する。
    for (const state of RECEPTION_STATES) {
      if (STATES_WITH_SCREEN_TITLE.has(state)) continue;
      expect(screenTitleFor(state, 'ja'), state).toBeNull();
    }
  });

  it('主指示を持つ画面はちょうど 5 つ（勝手に増減していない）', () => {
    const withTitle = RECEPTION_STATES.filter((s) => screenTitleFor(s, 'ja') !== null);
    expect(withTitle).toEqual([
      'idle',
      'selectingPurpose',
      'selectingTarget',
      'inputVisitorInfo',
      'confirming',
    ]);
  });

  it('契約の既定 message（ja）と一致する（契約と表示で二重管理しない）', () => {
    // これが本増分の要点。従来この対応は `ui-contract.test.ts` の中にしか無く、**本番コードに
    // 経路が無いまま「一致している」ことだけを検証していた**。契約側の既定文言を直したのに
    // 画面が別の i18n キーを引き続けている、という乖離をここで落とす。
    for (const state of RECEPTION_STATES) {
      const title = screenTitleFor(state, 'ja');
      if (title === null) continue;
      expect(conversationTurnFor(state).message.displayText, state).toBe(title);
    }
  });

  it('locale を変えるとその言語の訳文になる（多言語の主指示が契約経由で出る）', () => {
    const en = screenTitleFor('confirming', 'en');
    expect(en).toBe(DICTIONARIES.en['reception.confirm']);
    expect(en).not.toBe(screenTitleFor('confirming', 'ja'));
  });
});
