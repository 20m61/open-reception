import { describe, expect, it } from 'vitest';
import { deriveBvhQaMetrics, normalizeBvhFrames, parseBvh } from './bvh';

const SAMPLE = `HIERARCHY
ROOT Hips
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Neck
  {
    OFFSET 0 10 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT Head
    {
      OFFSET 0 5 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      End Site
      {
        OFFSET 0 5 0
      }
    }
  }
}
MOTION
Frames: 4
Frame Time: 0.1
0 0 0 0 0 0 0 0 0 0 0 0
0 0 0 0 2 0 0 1 0 0 2 0
0 0 0 0 4 0 0 2 0 0 4 0
0 0 0 0 0 0 0 0 0 0 0 0
`;

describe('parseBvh', () => {
  it('parses hierarchy, frame metadata and channel values', () => {
    const parsed = parseBvh(SAMPLE);
    expect(parsed.joints.map((joint) => joint.name)).toEqual(['Hips', 'Neck', 'Head']);
    expect(parsed.joints[1].parent).toBe('Hips');
    expect(parsed.frames).toHaveLength(4);
    expect(parsed.frameTimeSec).toBe(0.1);
  });

  it('normalizes rotation channel order into XYZ', () => {
    const normalized = normalizeBvhFrames(parseBvh(SAMPLE));
    expect(normalized[1].Hips.rotationDeg).toEqual([2, 0, 0]);
    expect(normalized[1].Neck.rotationDeg).toEqual([1, 0, 0]);
    expect(normalized[1].Head.rotationDeg).toEqual([2, 0, 0]);
  });

  it('derives deterministic Motion Lab metrics', () => {
    const metrics = deriveBvhQaMetrics(parseBvh(SAMPLE), {
      stillnessVelocityDegPerSec: 5,
      gazeAnimatedVelocityDegPerSec: 5,
    });
    expect(metrics.durationSec).toBeCloseTo(0.4);
    expect(metrics.neutralStartErrorDeg).toBe(0);
    expect(metrics.neutralEndErrorDeg).toBe(0);
    expect(metrics.loopSeamErrorDeg).toBe(0);
    expect(metrics.maxJointAngleDeg).toBeCloseTo(4);
    expect(metrics.peakJerkDegPerSec3).toBeGreaterThan(0);
    expect(metrics.headNeckAnimatedRatio).toBeGreaterThan(0);
    expect(metrics.framingOverflowRatio).toBe(0);
  });

  it('rejects malformed frame channel counts', () => {
    expect(() => parseBvh(SAMPLE.replace('0 0 0 0 2 0 0 1 0 0 2 0', '0 0 0'))).toThrow(
      /channel mismatch/,
    );
  });
});
