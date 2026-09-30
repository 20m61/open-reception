import { describe, expect, it } from 'vitest';
import { DEFAULT_MOTION_QA_PROFILE, evaluateMotionQa, type MotionQaMetrics } from './qa';

const goodMetrics: MotionQaMetrics = {
  durationSec: 2.5,
  neutralStartErrorDeg: 1.2,
  neutralEndErrorDeg: 1.8,
  maxJointAngleDeg: 85,
  peakJerkDegPerSec3: 420,
  stillnessRatio: 0.5,
  framingOverflowRatio: 0,
  headNeckAnimatedRatio: 0.1,
};

describe('evaluateMotionQa', () => {
  it('passes a clean one-shot motion', () => {
    const report = evaluateMotionQa(goodMetrics);
    expect(report.automatedDecision).toBe('pass');
    expect(report.gates.find((g) => g.id === 'loop-seam')?.status).toBe('not-applicable');
  });

  it('does not treat unmeasured framing or neutral calibration as a pass', () => {
    const report = evaluateMotionQa({
      ...goodMetrics,
      neutralStartErrorDeg: undefined,
      neutralEndErrorDeg: undefined,
      framingOverflowRatio: undefined,
    });
    expect(report.gates.find((g) => g.id === 'neutral-start')?.status).toBe('not-applicable');
    expect(report.gates.find((g) => g.id === 'neutral-end')?.status).toBe('not-applicable');
    expect(report.gates.find((g) => g.id === 'framing')?.status).toBe('not-applicable');
  });

  it('requires a seam metric for loop motions', () => {
    const report = evaluateMotionQa(goodMetrics, {
      ...DEFAULT_MOTION_QA_PROFILE,
      loop: true,
    });
    expect(report.automatedDecision).toBe('reject');
    expect(report.gates.find((g) => g.id === 'loop-seam')?.status).toBe('fail');
  });

  it('marks warnings as needs-tuning instead of rejecting', () => {
    const report = evaluateMotionQa({ ...goodMetrics, neutralEndErrorDeg: 6 });
    expect(report.automatedDecision).toBe('needs-tuning');
  });

  it('rejects excessive framing overflow', () => {
    const report = evaluateMotionQa({ ...goodMetrics, framingOverflowRatio: 0.08 });
    expect(report.automatedDecision).toBe('reject');
    expect(report.gates.find((g) => g.id === 'framing')?.status).toBe('fail');
  });

  it('rejects excessive head/neck ownership that would fight runtime gaze', () => {
    const report = evaluateMotionQa({ ...goodMetrics, headNeckAnimatedRatio: 0.8 });
    expect(report.automatedDecision).toBe('reject');
    expect(report.gates.find((g) => g.id === 'gaze-conflict')?.status).toBe('fail');
  });
});
