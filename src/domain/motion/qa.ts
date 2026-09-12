export type MotionQaGateId =
  | 'duration'
  | 'neutral-start'
  | 'neutral-end'
  | 'loop-seam'
  | 'motion-range'
  | 'jerk'
  | 'stillness'
  | 'framing'
  | 'gaze-conflict';

export type MotionQaGateStatus = 'pass' | 'warn' | 'fail' | 'not-applicable';
export type MotionReviewDecision = 'pending' | 'pass' | 'needs-tuning' | 'reject';

export type MotionQaMetrics = {
  durationSec: number;
  neutralStartErrorDeg: number;
  neutralEndErrorDeg: number;
  loopSeamErrorDeg?: number;
  maxJointAngleDeg: number;
  peakJerkDegPerSec3: number;
  stillnessRatio: number;
  framingOverflowRatio: number;
  headNeckAnimatedRatio: number;
};

export type MotionQaProfile = {
  duration: { minSec: number; maxSec: number };
  loop: boolean;
  neutralError: { warnDeg: number; failDeg: number };
  loopSeamError: { warnDeg: number; failDeg: number };
  maxJointAngle: { warnDeg: number; failDeg: number };
  peakJerk: { warnDegPerSec3: number; failDegPerSec3: number };
  stillness: { minWarnRatio: number; minFailRatio: number };
  framing: { warnOverflowRatio: number; failOverflowRatio: number };
  gazeConflict: { warnAnimatedRatio: number; failAnimatedRatio: number };
};

export type MotionQaGateResult = {
  id: MotionQaGateId;
  status: MotionQaGateStatus;
  value?: number;
  message: string;
};

export type MotionQaReport = {
  gates: MotionQaGateResult[];
  automatedDecision: Exclude<MotionReviewDecision, 'pending'>;
};

export const DEFAULT_MOTION_QA_PROFILE: MotionQaProfile = {
  duration: { minSec: 1.5, maxSec: 12 },
  loop: false,
  neutralError: { warnDeg: 5, failDeg: 10 },
  loopSeamError: { warnDeg: 3, failDeg: 7 },
  maxJointAngle: { warnDeg: 120, failDeg: 150 },
  peakJerk: { warnDegPerSec3: 900, failDegPerSec3: 1600 },
  stillness: { minWarnRatio: 0.35, minFailRatio: 0.15 },
  framing: { warnOverflowRatio: 0.01, failOverflowRatio: 0.05 },
  gazeConflict: { warnAnimatedRatio: 0.25, failAnimatedRatio: 0.6 },
};

function lowerIsBetter(
  id: MotionQaGateId,
  value: number,
  warn: number,
  fail: number,
  unit: string,
): MotionQaGateResult {
  const status: MotionQaGateStatus = value >= fail ? 'fail' : value >= warn ? 'warn' : 'pass';
  return { id, status, value, message: `${value.toFixed(2)}${unit} (warn ${warn}, fail ${fail})` };
}

export function evaluateMotionQa(
  metrics: MotionQaMetrics,
  profile: MotionQaProfile = DEFAULT_MOTION_QA_PROFILE,
): MotionQaReport {
  const gates: MotionQaGateResult[] = [];

  const durationStatus: MotionQaGateStatus =
    metrics.durationSec < profile.duration.minSec || metrics.durationSec > profile.duration.maxSec
      ? 'fail'
      : 'pass';
  gates.push({
    id: 'duration',
    status: durationStatus,
    value: metrics.durationSec,
    message: `${metrics.durationSec.toFixed(2)}s (expected ${profile.duration.minSec}-${profile.duration.maxSec}s)`,
  });

  gates.push(lowerIsBetter('neutral-start', metrics.neutralStartErrorDeg, profile.neutralError.warnDeg, profile.neutralError.failDeg, '°'));
  gates.push(lowerIsBetter('neutral-end', metrics.neutralEndErrorDeg, profile.neutralError.warnDeg, profile.neutralError.failDeg, '°'));

  if (profile.loop) {
    if (metrics.loopSeamErrorDeg == null) {
      gates.push({ id: 'loop-seam', status: 'fail', message: 'loop motion requires loopSeamErrorDeg' });
    } else {
      gates.push(lowerIsBetter('loop-seam', metrics.loopSeamErrorDeg, profile.loopSeamError.warnDeg, profile.loopSeamError.failDeg, '°'));
    }
  } else {
    gates.push({ id: 'loop-seam', status: 'not-applicable', message: 'one-shot motion' });
  }

  gates.push(lowerIsBetter('motion-range', metrics.maxJointAngleDeg, profile.maxJointAngle.warnDeg, profile.maxJointAngle.failDeg, '°'));
  gates.push(lowerIsBetter('jerk', metrics.peakJerkDegPerSec3, profile.peakJerk.warnDegPerSec3, profile.peakJerk.failDegPerSec3, '°/s³'));

  const stillnessStatus: MotionQaGateStatus =
    metrics.stillnessRatio < profile.stillness.minFailRatio
      ? 'fail'
      : metrics.stillnessRatio < profile.stillness.minWarnRatio
        ? 'warn'
        : 'pass';
  gates.push({
    id: 'stillness',
    status: stillnessStatus,
    value: metrics.stillnessRatio,
    message: `${(metrics.stillnessRatio * 100).toFixed(1)}% low-motion frames`,
  });

  gates.push(lowerIsBetter('framing', metrics.framingOverflowRatio, profile.framing.warnOverflowRatio, profile.framing.failOverflowRatio, ' ratio'));
  gates.push(lowerIsBetter('gaze-conflict', metrics.headNeckAnimatedRatio, profile.gazeConflict.warnAnimatedRatio, profile.gazeConflict.failAnimatedRatio, ' ratio'));

  const hasFail = gates.some((gate) => gate.status === 'fail');
  const hasWarn = gates.some((gate) => gate.status === 'warn');
  const automatedDecision: MotionQaReport['automatedDecision'] = hasFail
    ? 'reject'
    : hasWarn
      ? 'needs-tuning'
      : 'pass';

  return { gates, automatedDecision };
}
