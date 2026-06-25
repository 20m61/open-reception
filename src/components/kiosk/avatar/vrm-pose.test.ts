import { describe, it, expect } from 'vitest';
import { AVATAR_STATES } from '@/domain/reception/ui-contract';
import { resolveStatePose } from './vrm-pose';
import { IDLE_REST_POSE } from './vrm-idle';

describe('vrm-pose (#31 motion variations)', () => {
  it('全ての avatarState でポーズを解決でき、腕（rest）が含まれる', () => {
    for (const state of AVATAR_STATES) {
      const pose = resolveStatePose(state, 1.2);
      expect(pose.leftUpperArm).toBeDefined();
      expect(pose.rightUpperArm).toBeDefined();
      // 回転値はラジアンとして妥当な範囲（破綻しない控えめさ）。
      for (const e of Object.values(pose)) {
        for (const v of Object.values(e)) {
          expect(Math.abs(v as number)).toBeLessThan(2);
        }
      }
    }
  });

  it('idle は rest pose + 呼吸（spine.x が rest に加算される）', () => {
    const pose = resolveStatePose('idle', 0); // t=0 は呼吸 0
    expect(pose.leftUpperArm?.z).toBeCloseTo(IDLE_REST_POSE.leftUpperArm?.z ?? 0);
    expect(pose.rightUpperArm?.z).toBeCloseTo(IDLE_REST_POSE.rightUpperArm?.z ?? 0);
  });

  it('状態によって所作が異なる（greeting は右腕が rest より上がる）', () => {
    const idle = resolveStatePose('idle', 1);
    const greeting = resolveStatePose('greeting', 1);
    // rest では右上腕 z は約 -1.25（下ろす）。greeting は上げ気味＝より 0 に近い（> rest）。
    expect(greeting.rightUpperArm?.z ?? 0).toBeGreaterThan(idle.rightUpperArm?.z ?? 0);
  });

  it('apologizing/farewell は前傾（spine.x>0）でお辞儀になる', () => {
    expect(resolveStatePose('apologizing', 0).spine?.x ?? 0).toBeGreaterThan(0);
    expect(resolveStatePose('farewell', 0).spine?.x ?? 0).toBeGreaterThan(0);
  });

  it('greeting は時間で右手の振りが変化する（動的）', () => {
    const a = resolveStatePose('greeting', 0.0).rightLowerArm?.z ?? 0;
    const b = resolveStatePose('greeting', 0.26).rightLowerArm?.z ?? 0; // sin(6t) が変化
    expect(a).not.toBeCloseTo(b);
  });
});
