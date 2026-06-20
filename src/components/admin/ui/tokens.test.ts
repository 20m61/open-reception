import { describe, expect, it } from 'vitest';
import { buttonStyle, type ButtonVariant } from './Button';
import {
  SECRET_META,
  STATUS_META,
  TONE_COLOR,
  TONE_SOFT_BG,
  color,
  type SecretPresence,
  type StatusKind,
  type Tone,
} from './tokens';

describe('STATUS_META: 状態語彙 (#92 表示ルール)', () => {
  const ALL: StatusKind[] = ['ok', 'warning', 'critical', 'stopped', 'maintenance'];

  it('5 状態すべてにラベルと色が定義されている', () => {
    for (const s of ALL) {
      expect(STATUS_META[s].label).toBeTruthy();
      expect(STATUS_META[s].color).toMatch(/^var\(--color-/);
    }
  });

  it('業務向けの日本語ラベルに揃っている', () => {
    expect(STATUS_META.ok.label).toBe('正常');
    expect(STATUS_META.critical.label).toBe('異常');
    expect(STATUS_META.maintenance.label).toBe('メンテナンス中');
  });

  it('異常は danger、正常は success の色トークン', () => {
    expect(STATUS_META.critical.color).toBe(color.danger);
    expect(STATUS_META.ok.color).toBe(color.success);
  });
});

describe('SECRET_META: シークレット状態語彙 (#92 機密値非表示)', () => {
  const ALL: SecretPresence[] = ['configured', 'missing', 'needs_rotation'];

  it('登録済み/未設定/要更新 の 3 状態のみ', () => {
    expect(Object.keys(SECRET_META).sort()).toEqual([...ALL].sort());
    expect(SECRET_META.configured.label).toBe('登録済み');
    expect(SECRET_META.missing.label).toBe('未設定');
    expect(SECRET_META.needs_rotation.label).toBe('要更新');
  });
});

describe('TONE_COLOR / TONE_SOFT_BG: トーン語彙', () => {
  it('全トーンに前景色がある', () => {
    const tones: Tone[] = ['neutral', 'success', 'warning', 'danger', 'accent'];
    for (const t of tones) {
      expect(TONE_COLOR[t]).toBeTruthy();
    }
    expect(TONE_COLOR.neutral).toBe(color.text);
  });

  it('soft 背景は neutral 以外の全トーンに rgba で定義', () => {
    for (const t of ['success', 'warning', 'danger', 'accent'] as const) {
      expect(TONE_SOFT_BG[t]).toMatch(/^rgba\(/);
    }
  });
});

describe('buttonStyle: variant 選択ロジック', () => {
  const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];

  it('全 variant が共通の base（cursor:pointer, fontWeight:700）を持つ', () => {
    for (const v of VARIANTS) {
      const s = buttonStyle(v);
      expect(s.cursor).toBe('pointer');
      expect(s.fontWeight).toBe(700);
    }
  });

  it('primary は accent 背景、文字は bg 色（コントラスト確保）', () => {
    const s = buttonStyle('primary');
    expect(s.background).toBe(color.accent);
    expect(s.color).toBe(color.bg);
  });

  it('danger は danger 文字色と danger 罫線（怖く見せる）', () => {
    const s = buttonStyle('danger');
    expect(s.color).toBe(color.danger);
    expect(s.borderColor).toBe(color.danger);
  });

  it('secondary と ghost は同系の落ち着いたトーン', () => {
    expect(buttonStyle('secondary').color).toBe(color.text);
    expect(buttonStyle('ghost').color).toBe(color.text);
  });
});
