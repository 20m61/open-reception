import { describe, expect, it } from 'vitest';
import { AVATAR_BEHAVIOR_PHASES, type AvatarBehaviorPhase } from '@/domain/avatar/behavior';
import { composeGazeOffsets, naturalGazeOffset } from './vrm-natural-gaze';

describe('vrm-natural-gaze (#1100)', () => {
  it('same time/seed/phase なら完全に再現でき、seed が違えば軌跡が変わる', () => {
    const options = { seed: 42, behaviorPhase: 'ambient' as const, semanticGazeActive: false };
    const a = naturalGazeOffset(17.16, options);
    const b = naturalGazeOffset(17.16, options);
    const c = naturalGazeOffset(17.16, { ...options, seed: 43 });
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
  });

  it('phase profile は listening < speaking < ambient < thinking の倍率をそのまま適用する', () => {
    const elapsed = 17.16;
    const seed = 42;
    const sample = (behaviorPhase: AvatarBehaviorPhase) =>
      naturalGazeOffset(elapsed, { seed, behaviorPhase, semanticGazeActive: false });

    const ambient = sample('ambient');
    expect(Math.abs(ambient.yaw) + Math.abs(ambient.pitch)).toBeGreaterThan(0);

    const listening = sample('listening');
    const speaking = sample('speaking');
    const thinking = sample('thinking');
    expect(listening.yaw).toBeCloseTo(ambient.yaw * 0.2, 10);
    expect(listening.pitch).toBeCloseTo(ambient.pitch * 0.2, 10);
    expect(speaking.yaw).toBeCloseTo(ambient.yaw * 0.45, 10);
    expect(speaking.pitch).toBeCloseTo(ambient.pitch * 0.45, 10);
    expect(thinking.yaw).toBeCloseTo(ambient.yaw * 1.1, 10);
    expect(thinking.pitch).toBeCloseTo(ambient.pitch * 1.1, 10);
  });

  it('semantic gaze が有効なら同じ natural overlay を 0.35 倍へ抑える', () => {
    const options = { seed: 42, behaviorPhase: 'ambient' as const };
    const free = naturalGazeOffset(17.16, { ...options, semanticGazeActive: false });
    const guided = naturalGazeOffset(17.16, { ...options, semanticGazeActive: true });
    expect(guided.yaw).toBeCloseTo(free.yaw * 0.35, 10);
    expect(guided.pitch).toBeCloseTo(free.pitch * 0.35, 10);
  });

  it('deterministic gaze-break が micro-saccade 単独の上限を超える時刻を持つ', () => {
    // default seed の第2cycle。yaw micro-saccade単独は最大 ±0.005rad。
    // ここでは gaze-break envelope がほぼ最大になり、追加offsetが実際に存在することを固定する。
    const offset = naturalGazeOffset(17.16, { behaviorPhase: 'ambient' });
    expect(Math.abs(offset.yaw)).toBeGreaterThan(0.005);
  });

  it('semantic base + natural overlay の順で加算し、baseを失わない', () => {
    const base = { yaw: 0.22, pitch: 0.05 };
    const overlay = { yaw: -0.01, pitch: 0.006 };
    const composed = composeGazeOffsets(base, overlay);
    expect(composed.yaw).toBeCloseTo(0.21, 12);
    expect(composed.pitch).toBeCloseTo(0.056, 12);
    expect(base).toEqual({ yaw: 0.22, pitch: 0.05 });
  });

  it('合成後も既存 semantic gaze の安全可動域で clamp する', () => {
    expect(composeGazeOffsets({ yaw: 0.49, pitch: 0.34 }, { yaw: 0.03, pitch: 0.03 })).toEqual({
      yaw: 0.5,
      pitch: 0.35,
    });
    expect(composeGazeOffsets({ yaw: -0.49, pitch: -0.34 }, { yaw: -0.03, pitch: -0.03 })).toEqual({
      yaw: -0.5,
      pitch: -0.35,
    });
  });

  it('全phase / semantic有無 / 長時間サンプルで natural overlay の安全上限を超えない', () => {
    for (const behaviorPhase of AVATAR_BEHAVIOR_PHASES) {
      for (const semanticGazeActive of [false, true]) {
        for (let step = 0; step <= 1_800; step += 1) {
          const elapsed = step * 0.37;
          const offset = naturalGazeOffset(elapsed, {
            seed: 0x51f15e,
            behaviorPhase,
            semanticGazeActive,
          });
          expect(Number.isFinite(offset.yaw)).toBe(true);
          expect(Number.isFinite(offset.pitch)).toBe(true);
          expect(Math.abs(offset.yaw)).toBeLessThanOrEqual(0.03);
          expect(Math.abs(offset.pitch)).toBeLessThanOrEqual(0.02);
        }
      }
    }
  });

  it('caller-owned target を更新し、natural生成/合成とも hot path object identity を維持できる', () => {
    const overlayTarget = { yaw: 0, pitch: 0 };
    const composedTarget = { yaw: 0, pitch: 0 };
    const base = { yaw: 0.2, pitch: 0.05 };
    const first = naturalGazeOffset(0, { seed: 42 }, overlayTarget);
    expect(first).toBe(overlayTarget);
    expect(composeGazeOffsets(base, first, composedTarget)).toBe(composedTarget);

    for (let frame = 1; frame <= 1_000; frame += 1) {
      const behaviorPhase = AVATAR_BEHAVIOR_PHASES[frame % AVATAR_BEHAVIOR_PHASES.length]!;
      const overlay = naturalGazeOffset(
        frame / 60,
        { seed: 42, behaviorPhase, semanticGazeActive: frame % 2 === 0 },
        overlayTarget,
      );
      expect(overlay).toBe(overlayTarget);
      expect(composeGazeOffsets(base, overlay, composedTarget)).toBe(composedTarget);
    }
  });
});
