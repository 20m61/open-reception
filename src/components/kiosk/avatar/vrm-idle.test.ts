import { describe, expect, it } from 'vitest';
import {
  IDLE_REST_POSE,
  breathingRotation,
  expDecay,
  naturalMicroMotion,
  smoothValueNoise,
  swayRotation,
} from './vrm-idle';

describe('vrm-idle (#31 / #1085)', () => {
  it('rest pose は左右対称に腕を下ろす（上腕 Z が反転）', () => {
    // VRM 正規化空間で腕を下ろす向き: 左上腕 +Z / 右上腕 -Z（dev 実描画で確認）。
    expect(IDLE_REST_POSE.leftUpperArm?.z).toBeGreaterThan(0);
    expect(IDLE_REST_POSE.rightUpperArm?.z).toBeLessThan(0);
    expect(IDLE_REST_POSE.leftUpperArm?.z).toBeCloseTo(-(IDLE_REST_POSE.rightUpperArm?.z ?? 0));
  });

  it('breathing は ±0.025rad に収まり 0 を跨いで振動する', () => {
    const samples = Array.from({ length: 120 }, (_, i) => breathingRotation(i * 0.2));
    expect(Math.max(...samples)).toBeLessThanOrEqual(0.025 + 1e-9);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-0.025 - 1e-9);
    expect(Math.max(...samples)).toBeGreaterThan(0);
    expect(Math.min(...samples)).toBeLessThan(0);
  });

  it('breathing は t=0 で 0', () => {
    expect(breathingRotation(0)).toBeCloseTo(0);
  });

  it('breathing は旧固定周期ぶん進めても完全なループにはならない', () => {
    const oldPeriod = (Math.PI * 2) / 1.4;
    expect(breathingRotation(2.1)).not.toBeCloseTo(breathingRotation(2.1 + oldPeriod), 6);
  });

  it('sway は ±0.015rad に収まる', () => {
    const samples = Array.from({ length: 120 }, (_, i) => swayRotation(i * 0.5));
    expect(Math.max(...samples)).toBeLessThanOrEqual(0.015 + 1e-9);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-0.015 - 1e-9);
  });

  it('smooth noise は同じ seed/time なら決定論的で、seed が違えば軌跡が変わる', () => {
    const a = Array.from({ length: 20 }, (_, i) => smoothValueNoise(i * 0.17, 1234));
    const b = Array.from({ length: 20 }, (_, i) => smoothValueNoise(i * 0.17, 1234));
    const c = Array.from({ length: 20 }, (_, i) => smoothValueNoise(i * 0.17, 5678));
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
    for (const value of a) {
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('naturalMicroMotion は seed で再現でき、全軸が極小範囲に留まる', () => {
    const a = naturalMicroMotion(12.34, 42);
    const b = naturalMicroMotion(12.34, 42);
    expect(a).toEqual(b);
    expect(Math.abs(a.headX)).toBeLessThanOrEqual(0.006 + 1e-9);
    expect(Math.abs(a.headY)).toBeLessThanOrEqual(0.008 + 1e-9);
    expect(Math.abs(a.neckX)).toBeLessThanOrEqual(0.003 + 1e-9);
    expect(Math.abs(a.neckY)).toBeLessThanOrEqual(0.004 + 1e-9);
    expect(Math.abs(a.chestY)).toBeLessThanOrEqual(0.006 + 1e-9);
  });

  it('expDecay はフレーム刻みが違っても同じ経過時間なら同じ結果になる', () => {
    const oneStep = expDecay(0, 1, 5, 1);
    let sixtySteps = 0;
    for (let i = 0; i < 60; i += 1) {
      sixtySteps = expDecay(sixtySteps, 1, 5, 1 / 60);
    }
    expect(sixtySteps).toBeCloseTo(oneStep, 12);
  });

  it('expDecay は delta/rate が無効なら current を変えない', () => {
    expect(expDecay(0.4, 1, 5, 0)).toBe(0.4);
    expect(expDecay(0.4, 1, 0, 1)).toBe(0.4);
  });
});
