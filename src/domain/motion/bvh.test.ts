import { describe, expect, it } from 'vitest';
import { deriveBvhQaMetrics, normalizeBvhFrames, parseBvh, type NormalizedBvhFrame } from './bvh';

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
    expect(parsed.joints[2].parent).toBe('Neck');
    expect(parsed.frames).toHaveLength(4);
    expect(parsed.frameTimeSec).toBe(0.1);
  });

  it('retains diagnostic XYZ rotations while composing a quaternion in declared channel order', () => {
    const normalized = normalizeBvhFrames(parseBvh(SAMPLE));
    expect(normalized[1].Hips.rotationDeg).toEqual([2, 0, 0]);
    expect(normalized[1].Neck.rotationDeg).toEqual([1, 0, 0]);
    expect(normalized[1].Head.rotationDeg).toEqual([2, 0, 0]);
    expect(normalized[1].Head.rotationQuaternion).toBeDefined();
  });

  it('derives deterministic Motion Lab metrics without pretending unavailable measurements exist', () => {
    const metrics = deriveBvhQaMetrics(parseBvh(SAMPLE), {
      stillnessVelocityDegPerSec: 5,
      gazeAnimatedVelocityDegPerSec: 5,
    });
    expect(metrics.durationSec).toBeCloseTo(0.3);
    expect(metrics.neutralStartErrorDeg).toBeUndefined();
    expect(metrics.neutralEndErrorDeg).toBeUndefined();
    expect(metrics.loopSeamErrorDeg).toBeCloseTo(0);
    expect(metrics.maxJointAngleDeg).toBeCloseTo(4);
    expect(metrics.peakJerkDegPerSec3).toBeGreaterThan(0);
    expect(metrics.headNeckAnimatedRatio).toBeGreaterThan(0);
    expect(metrics.framingOverflowRatio).toBeUndefined();
  });

  it('computes neutral errors only when a calibrated reference is supplied', () => {
    const parsed = parseBvh(SAMPLE);
    const first = normalizeBvhFrames(parsed)[0];
    const neutralReference: NormalizedBvhFrame = first;
    const metrics = deriveBvhQaMetrics(parsed, { neutralReference });
    expect(metrics.neutralStartErrorDeg).toBeCloseTo(0);
    expect(metrics.neutralEndErrorDeg).toBeCloseTo(0);
  });

  it('resolves vendor-prefixed head and neck joint names semantically', () => {
    const vendorNamed = SAMPLE.replaceAll('Neck', 'J_Bip_C_Neck').replaceAll('Head', 'J_Bip_C_Head');
    const metrics = deriveBvhQaMetrics(parseBvh(vendorNamed), { gazeAnimatedVelocityDegPerSec: 5 });
    expect(metrics.headNeckAnimatedRatio).toBeGreaterThan(0);
  });

  it('rejects malformed frame channel counts', () => {
    expect(() => parseBvh(SAMPLE.replace('0 0 0 0 2 0 0 1 0 0 2 0', '0 0 0'))).toThrow(
      /channel mismatch/,
    );
  });
});
