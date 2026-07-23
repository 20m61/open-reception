import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TURN_DETECTOR_CONFIG,
  advanceTurnDetector,
  decideTurnEnd,
  initialTurnDetectorState,
  requiredSilenceMs,
} from './turn-detector';

describe('requiredSilenceMs', () => {
  it('短答は既定より短い無音で確定できる', () => {
    expect(requiredSilenceMs('はい', undefined)).toBe(DEFAULT_TURN_DETECTOR_CONFIG.shortAnswerSilenceMs);
    expect(requiredSilenceMs('はい', undefined)).toBeLessThan(requiredSilenceMs('配送でお伺いしました', undefined));
  });

  it('フィラー・接続助詞で終わる発話は待機時間を延長する', () => {
    for (const tail of ['えーと、あの', 'お願いしたいのですが', '伺いたいけど', '確認したいので']) {
      expect(requiredSilenceMs(tail, undefined)).toBeGreaterThan(DEFAULT_TURN_DETECTOR_CONFIG.baseSilenceMs);
    }
  });

  it('自由用件スロットは既定よりやや長く待つ（言い淀みが多いため）', () => {
    expect(requiredSilenceMs('採用の面接で参りました', 'free_form')).toBeGreaterThan(
      requiredSilenceMs('採用の面接で参りました', 'name'),
    );
  });

  it('「はい、ですが」のように短答に見えて続く発話はフィラー延長を優先する', () => {
    expect(requiredSilenceMs('はい、ですが', undefined)).toBe(
      DEFAULT_TURN_DETECTOR_CONFIG.baseSilenceMs + DEFAULT_TURN_DETECTOR_CONFIG.fillerExtensionMs,
    );
  });
});

describe('decideTurnEnd', () => {
  it('必要無音時間に届かなければ確定しない', () => {
    const decision = decideTurnEnd({ text: '営業部の山田さんに', silenceMs: 100 });
    expect(decision.commit).toBe(false);
  });

  it('必要無音時間に届いたら silence トリガーで確定する', () => {
    const decision = decideTurnEnd({ text: '配送でお伺いしました', silenceMs: DEFAULT_TURN_DETECTOR_CONFIG.baseSilenceMs });
    expect(decision).toEqual({ commit: true, trigger: 'silence', requiredSilenceMs: DEFAULT_TURN_DETECTOR_CONFIG.baseSilenceMs });
  });

  it('短答は短い無音で確定する（不要な待機をしない, issue #372 AC）', () => {
    const decision = decideTurnEnd({ text: 'はい', silenceMs: DEFAULT_TURN_DETECTOR_CONFIG.shortAnswerSilenceMs });
    expect(decision.commit).toBe(true);
    expect(decision.requiredSilenceMs).toBeLessThan(DEFAULT_TURN_DETECTOR_CONFIG.baseSilenceMs);
  });

  it('フィラーで終わる発話は base 相当の無音では確定しない（issue #372 AC「早すぎる応答をしない」）', () => {
    const decision = decideTurnEnd({ text: 'えーと、あの', silenceMs: DEFAULT_TURN_DETECTOR_CONFIG.baseSilenceMs });
    expect(decision.commit).toBe(false);
  });

  it('最大待機時間を超えたら他の条件を無視して rule トリガーで強制確定する（永遠に待たない）', () => {
    const decision = decideTurnEnd({ text: 'えーと、あの', silenceMs: DEFAULT_TURN_DETECTOR_CONFIG.maxWaitMs });
    expect(decision).toEqual({
      commit: true,
      trigger: 'rule',
      requiredSilenceMs: DEFAULT_TURN_DETECTOR_CONFIG.baseSilenceMs + DEFAULT_TURN_DETECTOR_CONFIG.fillerExtensionMs,
    });
  });
});

describe('advanceTurnDetector（状態機械）', () => {
  it('speech-ended で POSSIBLE_END へ入り candidate を発行する', () => {
    const { state, emitted } = advanceTurnDetector(initialTurnDetectorState(), { type: 'speech-ended', text: 'はい' });
    expect(state.lifecycle).toBe('possible_end');
    expect(emitted).toEqual([{ type: 'candidate' }]);
  });

  it('必要無音時間に届く前は待ったままイベントを出さない', () => {
    const afterEnd = advanceTurnDetector(initialTurnDetectorState(), { type: 'speech-ended', text: '配送でお伺いしました' });
    const { state, emitted } = advanceTurnDetector(afterEnd.state, { type: 'silence-tick', silenceMs: 100 });
    expect(state.lifecycle).toBe('possible_end');
    expect(emitted).toEqual([]);
  });

  it('必要無音時間に届くと committed を発行し終端状態になる', () => {
    const s = advanceTurnDetector(initialTurnDetectorState(), { type: 'speech-ended', text: 'はい' }).state;
    const result = advanceTurnDetector(s, { type: 'silence-tick', silenceMs: DEFAULT_TURN_DETECTOR_CONFIG.shortAnswerSilenceMs });
    expect(result.emitted).toEqual([{ type: 'committed', trigger: 'silence' }]);
    expect(result.state.lifecycle).toBe('committed');
  });

  it('POSSIBLE_END 中にユーザーが発話を再開すると cancelled を発行して USER_SPEAKING へ戻る', () => {
    const afterEnd = advanceTurnDetector(initialTurnDetectorState(), { type: 'speech-ended', text: 'えーと' });
    const { state, emitted } = advanceTurnDetector(afterEnd.state, { type: 'speech-started' });
    expect(emitted).toEqual([{ type: 'cancelled' }]);
    expect(state.lifecycle).toBe('user_speaking');
  });

  it('committed（終端状態）以降は追加の tick を無視する', () => {
    const initial = advanceTurnDetector(initialTurnDetectorState(), { type: 'speech-ended', text: 'はい' }).state;
    const s = advanceTurnDetector(initial, { type: 'silence-tick', silenceMs: 1000 }).state;
    expect(s.lifecycle).toBe('committed');
    const result = advanceTurnDetector(s, { type: 'silence-tick', silenceMs: 5000 });
    expect(result.emitted).toEqual([]);
    expect(result.state).toBe(s);
  });
});
