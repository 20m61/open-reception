import { describe, expect, it } from 'vitest';

import { DEFAULT_NEAR_END_CLASSIFIER_CONFIG, classifyNearEnd, shouldStopPlayback } from './near-end-classifier';

describe('classifyNearEnd', () => {
  it('継続時間が最低閾値未満は pending（まだ判断材料が無い）', () => {
    expect(classifyNearEnd({ text: '', sustainedMs: 50 })).toBe('pending');
    expect(classifyNearEnd({ text: 'は', sustainedMs: 50 })).toBe('pending');
  });

  it('原則継続フレーズは短い継続時間なら backchannel', () => {
    for (const text of ['はい', 'ええ', 'うん', 'なるほど', 'そうですね']) {
      expect(classifyNearEnd({ text, sustainedMs: 200 })).toBe('backchannel');
    }
  });

  it('強制停止フレーズは継続時間を待たず即座に interruption', () => {
    for (const text of ['違います', 'ちょっと待って', 'ストップ', '戻って', 'もう一度', '聞こえません']) {
      expect(classifyNearEnd({ text, sustainedMs: 10 })).toBe('interruption');
    }
  });

  it('「AではなくB」型訂正パターンは interruption', () => {
    expect(classifyNearEnd({ text: '山田さんではなく佐藤さんです', sustainedMs: 10 })).toBe('interruption');
  });

  it('エコー尤度が閾値以上なら echo（相づちフレーズや訂正パターンより優先）', () => {
    expect(classifyNearEnd({ text: '違います', sustainedMs: 500, echoLikelihood: 0.9 })).toBe('echo');
  });

  it('エコー尤度が未指定/低ければ echo と判定しない', () => {
    expect(classifyNearEnd({ text: 'はい', sustainedMs: 200, echoLikelihood: 0.1 })).toBe('backchannel');
    expect(classifyNearEnd({ text: 'はい', sustainedMs: 200 })).toBe('backchannel');
  });

  it('継続時間が十分あり認識テキストが空/空白なら noise（環境音）', () => {
    expect(classifyNearEnd({ text: '', sustainedMs: 400 })).toBe('noise');
    expect(classifyNearEnd({ text: '   ', sustainedMs: 400 })).toBe('noise');
  });

  it('相づちでも空でもない十分な継続発話は interruption（安全側）', () => {
    expect(classifyNearEnd({ text: 'すみません、佐藤さんでした', sustainedMs: 400 })).toBe('interruption');
  });

  it('相づちフレーズでも継続時間が長すぎれば backchannel の上限を外れ interruption 側になる', () => {
    const overMax = DEFAULT_NEAR_END_CLASSIFIER_CONFIG.maxSustainedMsForBackchannel + 50;
    expect(classifyNearEnd({ text: 'はい、そうなんですけど実は違っていて', sustainedMs: overMax })).toBe('interruption');
  });
});

describe('shouldStopPlayback', () => {
  it('true interruption のみ true', () => {
    expect(shouldStopPlayback('interruption')).toBe(true);
    expect(shouldStopPlayback('backchannel')).toBe(false);
    expect(shouldStopPlayback('noise')).toBe(false);
    expect(shouldStopPlayback('echo')).toBe(false);
    expect(shouldStopPlayback('pending')).toBe(false);
  });
});
