import { DEFAULT_MOTION_QA_PROFILE, type MotionQaProfile } from './qa';
import type { MotionKey } from './types';

function profile(
  duration: MotionQaProfile['duration'],
  loop: boolean,
  stillness: MotionQaProfile['stillness'],
): MotionQaProfile {
  return { ...DEFAULT_MOTION_QA_PROFILE, duration, loop, stillness };
}

/**
 * Motion QA is semantic: a calm waiting motion should contain much more stillness
 * than a short greeting gesture. Thresholds here are initial product defaults and
 * must be tuned from recorded takes + iPad UAT rather than treated as universal biomechanics.
 */
export const MOTION_QA_PROFILES: Readonly<Record<MotionKey, MotionQaProfile>> = {
  idle: profile({ minSec: 4, maxSec: 20 }, true, { minWarnRatio: 0.65, minFailRatio: 0.45 }),
  greeting: profile({ minSec: 1.5, maxSec: 4 }, false, { minWarnRatio: 0.05, minFailRatio: 0 }),
  listening: profile({ minSec: 2, maxSec: 15 }, true, { minWarnRatio: 0.45, minFailRatio: 0.25 }),
  thinking: profile({ minSec: 2, maxSec: 10 }, true, { minWarnRatio: 0.5, minFailRatio: 0.3 }),
  selecting: profile({ minSec: 2, maxSec: 8 }, true, { minWarnRatio: 0.3, minFailRatio: 0.15 }),
  calling: profile({ minSec: 4, maxSec: 20 }, true, { minWarnRatio: 0.6, minFailRatio: 0.4 }),
  connected: profile({ minSec: 4, maxSec: 20 }, true, { minWarnRatio: 0.7, minFailRatio: 0.5 }),
  success: profile({ minSec: 1, maxSec: 4 }, false, { minWarnRatio: 0.05, minFailRatio: 0 }),
  failed: profile({ minSec: 1, maxSec: 4 }, false, { minWarnRatio: 0.05, minFailRatio: 0 }),
  timeout: profile({ minSec: 1, maxSec: 4 }, false, { minWarnRatio: 0.05, minFailRatio: 0 }),
  fallback: profile({ minSec: 2, maxSec: 10 }, true, { minWarnRatio: 0.4, minFailRatio: 0.2 }),
};

export function motionQaProfileFor(key: MotionKey): MotionQaProfile {
  return MOTION_QA_PROFILES[key];
}
