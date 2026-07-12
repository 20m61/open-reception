import { describe, expect, it } from 'vitest';
import {
  createTracker,
  enterStep,
  finalizeExperience,
  recordBack,
  recordCancel,
  recordInputMethod,
  recordSearchQuery,
  stepForState,
} from './experience-metrics';

describe('stepForState (#319)', () => {
  it('フローの各局面を体験ステップへ写す', () => {
    expect(stepForState('selectingPurpose')).toBe('selectingPurpose');
    expect(stepForState('calling')).toBe('calling');
    expect(stepForState('connected')).toBe('connected');
  });

  it('待機・終端・結果状態はステップではない（null）', () => {
    expect(stepForState('idle')).toBeNull();
    expect(stepForState('timeout')).toBeNull();
    expect(stepForState('failed')).toBeNull();
    expect(stepForState('fallback')).toBeNull();
    expect(stepForState('completed')).toBeNull();
    expect(stepForState('cancelled')).toBeNull();
  });
});

describe('experience tracker (#319)', () => {
  it('ステップ別滞在所要を積算し、最初のステップ入りで受付開始時刻を確定する', () => {
    let t = createTracker();
    t = enterStep(t, 'selectingPurpose', 1000);
    t = enterStep(t, 'selectingTarget', 3000); // purpose に 2000ms 滞在
    t = enterStep(t, 'inputVisitorInfo', 3500); // target に 500ms
    const exp = finalizeExperience(t, { abandoned: false, nowMs: 4000 }); // input に 500ms
    expect(exp.stepDurations).toEqual({
      selectingPurpose: 2000,
      selectingTarget: 500,
      inputVisitorInfo: 500,
    });
  });

  it('呼び出し確定で受付開始からの所要（timeToCallMs）を記録する', () => {
    let t = createTracker();
    t = enterStep(t, 'selectingPurpose', 1000);
    t = enterStep(t, 'selectingTarget', 5000);
    t = enterStep(t, 'confirming', 9000);
    t = enterStep(t, 'calling', 12000); // START(=1000) から 11000ms
    const exp = finalizeExperience(t, { abandoned: false, nowMs: 12000 });
    expect(exp.timeToCallMs).toBe(11000);
  });

  it('戻る・キャンセルの回数を数える（0 のときは省略）', () => {
    let t = createTracker();
    t = enterStep(t, 'selectingPurpose', 0);
    const none = finalizeExperience(t, { abandoned: false, nowMs: 10 });
    expect(none.backCount).toBeUndefined();
    expect(none.cancelCount).toBeUndefined();

    t = recordBack(t);
    t = recordBack(t);
    t = recordCancel(t);
    const exp = finalizeExperience(t, { abandoned: false, nowMs: 20 });
    expect(exp.backCount).toBe(2);
    expect(exp.cancelCount).toBe(1);
  });

  it('入力手段は明示記録が優先され、記録が無ければ touch（進行があれば）', () => {
    let progressed = createTracker();
    progressed = enterStep(progressed, 'selectingPurpose', 0);
    expect(finalizeExperience(progressed, { abandoned: false, nowMs: 1 }).inputMethod).toBe('touch');

    let voice = enterStep(createTracker(), 'selectingTarget', 0);
    voice = recordInputMethod(voice, 'stt');
    expect(finalizeExperience(voice, { abandoned: false, nowMs: 1 }).inputMethod).toBe('stt');

    // 一度も進行していない（受付開始前）の finalize は inputMethod を付けない。
    expect(finalizeExperience(createTracker(), { abandoned: false, nowMs: 1 }).inputMethod).toBeUndefined();
  });

  it('離脱時は到達していた最終ステップを記録し、完遂時は付けない', () => {
    let t = createTracker();
    t = enterStep(t, 'selectingPurpose', 0);
    t = enterStep(t, 'selectingTarget', 100);
    const abandoned = finalizeExperience(t, { abandoned: true, nowMs: 200 });
    expect(abandoned.abandonedAtStep).toBe('selectingTarget');

    const completed = finalizeExperience(t, { abandoned: false, nowMs: 200 });
    expect(completed.abandonedAtStep).toBeUndefined();
  });

  it('PII を含む余分なキーを出力しない（所要/回数/列挙のみ）', () => {
    let t = createTracker();
    t = enterStep(t, 'selectingPurpose', 0);
    t = enterStep(t, 'calling', 5000);
    const exp = finalizeExperience(t, { abandoned: false, nowMs: 5000 });
    const allowed = new Set([
      'stepDurations',
      'timeToCallMs',
      'backCount',
      'cancelCount',
      'inputMethod',
      'abandonedAtStep',
    ]);
    for (const key of Object.keys(exp)) {
      expect(allowed.has(key)).toBe(true);
    }
  });
});

describe('recordSearchQuery (#322) — 担当者検索のヒット率/0件率フック', () => {
  it('検索実行のたびにクエリ数を数え、ヒット無しのときだけ 0 件数を増やす', () => {
    let t = createTracker();
    expect(t.searchQueryCount).toBe(0);
    expect(t.searchZeroHitCount).toBe(0);

    t = recordSearchQuery(t, true); // ヒットあり
    expect(t.searchQueryCount).toBe(1);
    expect(t.searchZeroHitCount).toBe(0);

    t = recordSearchQuery(t, false); // 0 件
    t = recordSearchQuery(t, false); // 0 件
    expect(t.searchQueryCount).toBe(3);
    expect(t.searchZeroHitCount).toBe(2);
  });

  it('検索クエリ文字列や結果（PII になり得る値）を保持しない', () => {
    let t = createTracker();
    t = recordSearchQuery(t, false);
    const keys = Object.keys(t);
    expect(keys).not.toContain('query');
    expect(keys).not.toContain('lastQuery');
    expect(keys).not.toContain('results');
  });
});
