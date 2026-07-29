import { describe, expect, it } from 'vitest';
import { conversationTurnFor, RECEPTION_STATES } from '@/domain/reception/ui-contract';
import { RECEPTION_PURPOSES } from '@/domain/reception/session';
import { DICTIONARIES, type MessageKey as I18nMessageKey } from '@/lib/i18n';
import { screenTitleFor, STATES_WITH_SCREEN_TITLE, turnAnswersFor } from './conversation-turn';

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

describe('kiosk conversation-turn: 回答候補の解決 (#422 inc5-b 増分 2)', () => {
  it('確認・通話中の CTA は現行と同じラベル / testId を返す（配線しても見た目は変わらない）', () => {
    expect(turnAnswersFor('confirming', 'ja')).toEqual([
      { id: 'confirm', label: ja('reception.callWithThis'), intent: 'confirm', testId: 'confirm-call' },
    ]);
    expect(turnAnswersFor('connected', 'ja')).toEqual([
      { id: 'complete', label: ja('reception.finishReception'), intent: 'complete', testId: 'complete' },
    ]);
  });

  it('未応答は理由に依らず代替導線を出す（呼び出し自体は到達している）', () => {
    for (const reason of ['network', 'server', undefined] as const) {
      const answers = turnAnswersFor('timeout', 'ja', reason ? { callFailureReason: reason } : undefined);
      expect(answers.map((a) => a.testId), String(reason)).toEqual(['use-fallback']);
    }
  });

  it('**通信断の失敗では代替導線を出さない**（果たせない約束を押させない）', () => {
    // ここが本増分の要点。従来この判断は ResultView が自前で
    // `shouldOfferAlternativeContact` を呼んで持っており、契約側（#489 で修正）と
    // 二重実装だった。#486 で逃げ道について潰したのと同じ形。
    expect(turnAnswersFor('failed', 'ja', { callFailureReason: 'network' })).toEqual([]);
    // 通信断以外は従来どおり出す。
    expect(turnAnswersFor('failed', 'ja', { callFailureReason: 'server' }).map((a) => a.testId)).toEqual([
      'use-fallback',
    ]);
    expect(turnAnswersFor('failed', 'ja').map((a) => a.testId)).toEqual(['use-fallback']);
  });

  it('代替導線を出すかの判断は契約に従う（画面側が独自判断を持たない）', () => {
    for (const reason of ['network', 'server', undefined] as const) {
      const context = reason ? { callFailureReason: reason } : undefined;
      const shown = turnAnswersFor('failed', 'ja', context).length > 0;
      expect(shown, String(reason)).toBe(conversationTurnFor('failed', context).answers.length > 0);
    }
  });

  it('回答を持たない画面は空配列（CTA を勝手に生やさない）', () => {
    // fallback は #325 で CTA を撤去済み。calling / completed / cancelled も CTA を持たない。
    for (const state of ['fallback', 'calling', 'completed', 'cancelled', 'inputVisitorInfo'] as const) {
      expect(turnAnswersFor(state, 'ja'), state).toEqual([]);
    }
  });

  it('契約が返す回答はすべて表示定義を持つ（黙って消える回答が無い）', () => {
    // 契約に回答を足したのに表示定義を忘れると、その回答は画面から静かに消える。
    // 増分 3a で用件カードを寄せたので、未対応はもう無い。
    const unmapped = new Set<string>();
    for (const state of RECEPTION_STATES) {
      const resolved = new Set(turnAnswersFor(state, 'ja').map((a) => a.id));
      for (const answer of conversationTurnFor(state).answers) {
        if (!resolved.has(answer.id)) unmapped.add(answer.id);
      }
    }
    expect([...unmapped]).toEqual([]);
  });

  it('locale を変えると CTA の文言もその言語になる', () => {
    expect(turnAnswersFor('confirming', 'en')[0]?.label).toBe(DICTIONARIES.en['reception.callWithThis']);
  });
});

describe('kiosk conversation-turn: 用件カードの解決 (#422 inc5-b 増分 3a)', () => {
  it('4 つの用件を契約の順で返し、現行の testId を保つ', () => {
    const answers = turnAnswersFor('selectingPurpose', 'ja');
    expect(answers.map((a) => a.id)).toEqual(RECEPTION_PURPOSES.map((p) => p.id));
    expect(answers.map((a) => a.testId)).toEqual(RECEPTION_PURPOSES.map((p) => `purpose-${p.id}`));
    for (const answer of answers) expect(answer.intent).toBe('selectPurpose');
  });

  it('ラベルは i18n 辞書から解決する（契約の生リテラルを画面へ出さない）', () => {
    // 契約の `RECEPTION_PURPOSES.label` は生の日本語リテラルで、画面は
    // `reception.purpose.<id>` を引いていた。**同じ文言の二重管理**（ja では一致していたが、
    // 辞書だけ直すとズレる形）。表示は辞書を正とする。
    expect(turnAnswersFor('selectingPurpose', 'ja').map((a) => a.label)).toEqual([
      ja('reception.purpose.meeting'),
      ja('reception.purpose.delivery'),
      ja('reception.purpose.interview'),
      ja('reception.purpose.other'),
    ]);
  });

  it('多言語でも用件カードが訳される（生リテラルが漏れない）', () => {
    const en = turnAnswersFor('selectingPurpose', 'en').map((a) => a.label);
    expect(en).toEqual([
      DICTIONARIES.en['reception.purpose.meeting'],
      DICTIONARIES.en['reception.purpose.delivery'],
      DICTIONARIES.en['reception.purpose.interview'],
      DICTIONARIES.en['reception.purpose.other'],
    ]);
    // 日本語リテラルがそのまま出ていないこと（#327 の翻訳漏れ検査と同じ関心）。
    for (const label of en) {
      expect(RECEPTION_PURPOSES.map((p) => p.label)).not.toContain(label);
    }
  });

  it('契約の既定ラベル（ja）は辞書と一致する（二重管理のズレを検出する）', () => {
    // 表示は辞書を正にしたが、契約側の既定ラベルが残っている以上ズレは起こりうる。
    // #487 が message / answers でやったのと同じ突き合わせをここでも掛ける。
    for (const purpose of RECEPTION_PURPOSES) {
      expect(purpose.label, purpose.id).toBe(ja(`reception.purpose.${purpose.id}` as I18nMessageKey));
    }
  });
});
