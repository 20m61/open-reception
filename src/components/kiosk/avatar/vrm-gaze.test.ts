import { describe, expect, it } from 'vitest';
import { GAZE_TARGETS, gazeTargetFor, RECEPTION_STATES } from '@/domain/reception/ui-contract';
import { KIOSK_LAYOUTS } from '../layout';
import { gazeOffsetFor } from './vrm-gaze';

describe('vrm-gaze: 視線先 → 頭部オフセット (#422 inc5-c 増分 3)', () => {
  it('全 視線先 × 全レイアウト で有限値を返す（NaN や undefined を作らない）', () => {
    for (const target of GAZE_TARGETS) {
      for (const layout of KIOSK_LAYOUTS) {
        const offset = gazeOffsetFor(target, layout);
        expect(Number.isFinite(offset.yaw), `${target}/${layout}`).toBe(true);
        expect(Number.isFinite(offset.pitch), `${target}/${layout}`).toBe(true);
      }
    }
  });

  it('誘導なし(none)はどのレイアウトでも中立（操作を急かさない局面）', () => {
    for (const layout of KIOSK_LAYOUTS) {
      expect(gazeOffsetFor('none', layout), layout).toEqual({ yaw: 0, pitch: 0 });
    }
  });

  it('横向きは右レールへ首を振る（操作が右 65% に在る）', () => {
    // 横向き/大型は 35%/65% レール。アバターは左、操作は右。
    for (const layout of ['ipad-landscape', 'large-display'] as const) {
      for (const target of ['answers', 'form', 'confirmCta', 'fallbackCta'] as const) {
        expect(gazeOffsetFor(target, layout).yaw, `${target}/${layout}`).toBeGreaterThan(0);
      }
    }
  });

  it('縦向きは首を振らず下を見る（操作がアバターの真下に在る）', () => {
    // 同じ視線先でも向く方向が違う。ここがレイアウトを引数に取る理由。
    for (const target of ['answers', 'form', 'confirmCta', 'fallbackCta'] as const) {
      const portrait = gazeOffsetFor(target, 'ipad-portrait');
      expect(portrait.yaw, target).toBe(0);
      expect(portrait.pitch, target).toBeGreaterThan(0);
    }
  });

  it('入力欄・CTA は回答一覧より深く見下ろす（画面下方に在る）', () => {
    for (const layout of KIOSK_LAYOUTS) {
      const answers = gazeOffsetFor('answers', layout).pitch;
      expect(gazeOffsetFor('form', layout).pitch, layout).toBeGreaterThan(answers);
      expect(gazeOffsetFor('confirmCta', layout).pitch, layout).toBeGreaterThan(answers);
    }
  });

  it('首の可動域を超えない（人としてありえない角度にしない）', () => {
    // ラジアン。横 ±0.5(≒29°) / 縦 ±0.35(≒20°) を上限とする。
    for (const target of GAZE_TARGETS) {
      for (const layout of KIOSK_LAYOUTS) {
        const { yaw, pitch } = gazeOffsetFor(target, layout);
        expect(Math.abs(yaw), `${target}/${layout}`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(pitch), `${target}/${layout}`).toBeLessThanOrEqual(0.35);
      }
    }
  });

  it('契約の全 screenState から解決できる（導出の消費者になる）', () => {
    // #489 で実挙動へ突き合わせた gazeTarget が、ここで初めて消費者を得る。
    for (const state of RECEPTION_STATES) {
      for (const layout of KIOSK_LAYOUTS) {
        expect(() => gazeOffsetFor(gazeTargetFor(state), layout)).not.toThrow();
      }
    }
  });
});
