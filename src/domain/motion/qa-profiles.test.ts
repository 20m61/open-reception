import { describe, expect, it } from 'vitest';
import { MOTION_KEYS } from './types';
import { MOTION_QA_PROFILES, motionQaProfileFor } from './qa-profiles';

describe('motion QA profiles', () => {
  it('covers every MotionKey', () => {
    expect(Object.keys(MOTION_QA_PROFILES).sort()).toEqual([...MOTION_KEYS].sort());
  });

  it('expects calm states to contain more stillness than short gestures', () => {
    expect(motionQaProfileFor('connected').stillness.minWarnRatio)
      .toBeGreaterThan(motionQaProfileFor('greeting').stillness.minWarnRatio);
    expect(motionQaProfileFor('calling').stillness.minWarnRatio)
      .toBeGreaterThan(motionQaProfileFor('success').stillness.minWarnRatio);
  });

  it('requires seams only for looping behavior profiles', () => {
    expect(motionQaProfileFor('idle').loop).toBe(true);
    expect(motionQaProfileFor('listening').loop).toBe(true);
    expect(motionQaProfileFor('greeting').loop).toBe(false);
    expect(motionQaProfileFor('failed').loop).toBe(false);
  });
});
