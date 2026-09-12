import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import { describe, expect, it } from 'vitest';
import { AVATAR_BEHAVIOR_PHASES, type AvatarBehaviorPhase } from '@/domain/avatar/behavior';
import { AVATAR_STATES } from '@/domain/reception/ui-contract';
import { IDLE_REST_POSE, type HumanoidBoneName } from './vrm-idle';
import {
  createStatePoseBuffer,
  poseEntries,
  resolveStatePose,
  type ResolveStatePoseOptions,
} from './vrm-pose';

/**
 * 型レベルの固定: 手続き的ポーズが触るボーン名は VRM 仕様の `VRMHumanBoneName` の部分集合。
 * `import type` なので three-vrm は実行時に読まれない。綴りを誤ると typecheck が落ちる
 * （以前は `string` で、誤字は実機で「動かない」としてしか出なかった）。
 */
const _boneNamesAreVrmHumanBones: VRMHumanBoneName = null as unknown as HumanoidBoneName;
void _boneNamesAreVrmHumanBones;

describe('vrm-pose (#31 / #1085 motion variations)', () => {
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

  it('micro-motion は idle より connected の方が静か', () => {
    const elapsed = 7.3;
    const idle = resolveStatePose('idle', elapsed);
    const connected = resolveStatePose('connected', elapsed);
    // head は状態固有 override を持たないため、同一 micro sample × intensity の比較ができる。
    expect(Math.abs(connected.head?.x ?? 0)).toBeLessThan(Math.abs(idle.head?.x ?? 0));
    expect(Math.abs(connected.head?.y ?? 0)).toBeLessThan(Math.abs(idle.head?.y ?? 0));
  });

  it('behaviorPhase 未指定は ambient と完全互換', () => {
    const options = { naturalMotionSeed: 42 } as const;
    const implicit = resolveStatePose('idle', 7.3, options);
    const ambient = resolveStatePose('idle', 7.3, { ...options, behaviorPhase: 'ambient' });
    expect(implicit).toEqual(ambient);
  });

  it('behavior phase は sway / micro-motion を listening < speaking < thinking < ambient に抑え、呼吸は維持する', () => {
    const elapsed = 7.3;
    const naturalMotionSeed = 42;
    const sample = (behaviorPhase: AvatarBehaviorPhase) =>
      resolveStatePose('idle', elapsed, { naturalMotionSeed, behaviorPhase });

    const ambient = sample('ambient');
    const ambientHeadX = ambient.head?.x ?? 0;
    const ambientSwayZ = ambient.chest?.z ?? 0;
    expect(Math.abs(ambientHeadX)).toBeGreaterThan(0);
    expect(Math.abs(ambientSwayZ)).toBeGreaterThan(0);

    const listening = sample('listening');
    const speaking = sample('speaking');
    const thinking = sample('thinking');

    expect(listening.head?.x ?? 0).toBeCloseTo(ambientHeadX * 0.5, 10);
    expect(speaking.head?.x ?? 0).toBeCloseTo(ambientHeadX * 0.65, 10);
    expect(thinking.head?.x ?? 0).toBeCloseTo(ambientHeadX * 0.8, 10);
    expect(listening.chest?.z ?? 0).toBeCloseTo(ambientSwayZ * 0.5, 10);
    expect(speaking.chest?.z ?? 0).toBeCloseTo(ambientSwayZ * 0.65, 10);
    expect(thinking.chest?.z ?? 0).toBeCloseTo(ambientSwayZ * 0.8, 10);
    expect(listening.spine?.x ?? 0).toBeCloseTo(ambient.spine?.x ?? 0, 10);
    expect(speaking.spine?.x ?? 0).toBeCloseTo(ambient.spine?.x ?? 0, 10);
    expect(thinking.spine?.x ?? 0).toBeCloseTo(ambient.spine?.x ?? 0, 10);
  });

  it('behavior phase は greeting の手振り / farewell の会釈を変えない', () => {
    const elapsed = 0.73;
    const naturalMotionSeed = 42;
    const greetingAmbient = resolveStatePose('greeting', elapsed, {
      naturalMotionSeed,
      behaviorPhase: 'ambient',
    });
    const farewellAmbient = resolveStatePose('farewell', elapsed, {
      naturalMotionSeed,
      behaviorPhase: 'ambient',
    });

    for (const behaviorPhase of AVATAR_BEHAVIOR_PHASES) {
      const greeting = resolveStatePose('greeting', elapsed, { naturalMotionSeed, behaviorPhase });
      const farewell = resolveStatePose('farewell', elapsed, { naturalMotionSeed, behaviorPhase });
      expect(greeting.rightLowerArm).toEqual(greetingAmbient.rightLowerArm);
      expect(farewell.spine?.x).toBeCloseTo(farewellAmbient.spine?.x ?? 0, 10);
    }
  });

  it('同じ state/time/seed/behaviorPhase なら procedural pose は完全に再現できる', () => {
    for (const behaviorPhase of AVATAR_BEHAVIOR_PHASES) {
      const options = { naturalMotionSeed: 42, behaviorPhase } as const;
      expect(resolveStatePose('idle', 12.345, options)).toEqual(resolveStatePose('idle', 12.345, options));
    }
  });

  it('natural motion seed は pose の最終軌跡まで再現できる', () => {
    const a = resolveStatePose('idle', 12.345, { naturalMotionSeed: 42 });
    const b = resolveStatePose('idle', 12.345, { naturalMotionSeed: 42 });
    const c = resolveStatePose('idle', 12.345, { naturalMotionSeed: 43 });
    expect(a).toEqual(b);
    expect(c.head).not.toEqual(a.head);
  });

  it('hot path は pose buffer と全 bone rotation を毎フレーム再利用する', () => {
    const buffer = createStatePoseBuffer();
    const options: ResolveStatePoseOptions = {
      buffer,
      naturalMotionSeed: 42,
      behaviorPhase: 'ambient',
    };
    const first = resolveStatePose('confirming', 1, options);
    const boneRefs = new Map(poseEntries(first));

    expect(first.neck?.z).toBeCloseTo(0.13);
    for (let frame = 1; frame <= 1_000; frame += 1) {
      const state = frame % 2 === 0 ? 'idle' : 'connected';
      options.behaviorPhase = AVATAR_BEHAVIOR_PHASES[frame % AVATAR_BEHAVIOR_PHASES.length]!;
      const next = resolveStatePose(state, frame / 60, options);
      expect(next).toBe(first);
      for (const [bone, rotation] of poseEntries(next)) {
        expect(rotation, bone).toBe(boneRefs.get(bone));
      }
    }
    // confirming だけの傾きが、再利用バッファを介して idle へ漏れない。
    expect(first.neck?.z ?? 0).toBe(0);
  });

  it('再利用 buffer は state/time/seed/phase の組み合わせを変えても通常版と同じ結果になる', () => {
    const buffer = createStatePoseBuffer();
    const samples = [
      { state: 'confirming' as const, elapsed: 0, seed: 1, phase: 'ambient' as const },
      { state: 'greeting' as const, elapsed: 0.26, seed: 42, phase: 'listening' as const },
      { state: 'farewell' as const, elapsed: 7.3, seed: -1, phase: 'thinking' as const },
      { state: 'idle' as const, elapsed: 12.345, seed: 2_147_483_647, phase: 'speaking' as const },
      { state: 'connected' as const, elapsed: 86_400, seed: 0, phase: 'ambient' as const },
    ];

    for (const { state, elapsed, seed, phase } of samples) {
      const expected = resolveStatePose(state, elapsed, {
        naturalMotionSeed: seed,
        behaviorPhase: phase,
      });
      const actual = resolveStatePose(state, elapsed, {
        buffer,
        naturalMotionSeed: seed,
        behaviorPhase: phase,
      });
      expect(actual).toEqual(expected);
    }
  });

  it('poseEntries は値のあるボーンだけを、ボーン名の型を保って列挙する', () => {
    const entries = poseEntries({ head: { x: 0.1 }, neck: undefined });
    expect(entries).toEqual([['head', { x: 0.1 }]]);
  });
});
