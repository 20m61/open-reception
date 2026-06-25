import { describe, it, expect } from 'vitest';
import { IDLE_REST_POSE, breathingRotation, swayRotation } from './vrm-idle';

describe('vrm-idle (#31)', () => {
  it('rest pose は左右対称に腕を下ろす（上腕 Z が反転）', () => {
    // VRM 正規化空間で腕を下ろす向き: 左上腕 +Z / 右上腕 -Z（dev 実描画で確認）。
    expect(IDLE_REST_POSE.leftUpperArm?.z).toBeGreaterThan(0);
    expect(IDLE_REST_POSE.rightUpperArm?.z).toBeLessThan(0);
    expect(IDLE_REST_POSE.leftUpperArm?.z).toBeCloseTo(-(IDLE_REST_POSE.rightUpperArm?.z ?? 0));
  });

  it('breathing は ±0.025rad に収まり 0 を跨いで振動する', () => {
    const samples = Array.from({ length: 50 }, (_, i) => breathingRotation(i * 0.3));
    expect(Math.max(...samples)).toBeLessThanOrEqual(0.025 + 1e-9);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-0.025 - 1e-9);
    expect(Math.max(...samples)).toBeGreaterThan(0);
    expect(Math.min(...samples)).toBeLessThan(0);
  });

  it('breathing は t=0 で 0', () => {
    expect(breathingRotation(0)).toBeCloseTo(0);
  });

  it('sway は ±0.015rad に収まる', () => {
    const samples = Array.from({ length: 50 }, (_, i) => swayRotation(i * 0.5));
    expect(Math.max(...samples)).toBeLessThanOrEqual(0.015 + 1e-9);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-0.015 - 1e-9);
  });
});
