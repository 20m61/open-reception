import { describe, expect, it } from 'vitest';
import {
  DEFAULT_A11Y_ENABLED_MODES,
  DEFAULT_A11Y_MODE_STATE,
  DEFAULT_FONT_SCALE,
  FONT_SCALES,
  clampA11yModeState,
  isFontScale,
  sanitizeA11yEnabledModes,
  type A11yModeState,
} from './a11y-modes';

describe('isFontScale (#321)', () => {
  it('許容値のみ true', () => {
    for (const scale of FONT_SCALES) expect(isFontScale(scale)).toBe(true);
  });

  it('未対応値・非文字列は false', () => {
    expect(isFontScale('2')).toBe(false);
    expect(isFontScale('')).toBe(false);
    expect(isFontScale(1.3)).toBe(false);
    expect(isFontScale(undefined)).toBe(false);
    expect(isFontScale(null)).toBe(false);
  });
});

describe('DEFAULT_A11Y_MODE_STATE (#321)', () => {
  it('既定は無支援（等倍・非ハイコントラスト・非低位置）', () => {
    expect(DEFAULT_A11Y_MODE_STATE).toEqual({
      fontScale: DEFAULT_FONT_SCALE,
      highContrast: false,
      lowReach: false,
    });
  });
});

describe('sanitizeA11yEnabledModes (#321)', () => {
  it('未設定は既定=全モード有効へ補正する', () => {
    expect(sanitizeA11yEnabledModes(undefined)).toEqual(DEFAULT_A11Y_ENABLED_MODES);
    expect(sanitizeA11yEnabledModes(null)).toEqual(DEFAULT_A11Y_ENABLED_MODES);
    expect(sanitizeA11yEnabledModes({})).toEqual(DEFAULT_A11Y_ENABLED_MODES);
  });

  it('boolean 以外の値は既定=有効へフォールバックする（無効化は明示的な false のみ反映）', () => {
    expect(
      sanitizeA11yEnabledModes({ largeText: 'no', highContrast: 0, lowReach: undefined, simpleJapanese: null }),
    ).toEqual(DEFAULT_A11Y_ENABLED_MODES);
  });

  it('明示的な false はモードごとに個別反映する', () => {
    expect(
      sanitizeA11yEnabledModes({ largeText: false, highContrast: true, lowReach: false, simpleJapanese: true }),
    ).toEqual({ largeText: false, highContrast: true, lowReach: false, simpleJapanese: true });
  });

  it('非オブジェクト入力は既定へ丸める', () => {
    expect(sanitizeA11yEnabledModes('invalid')).toEqual(DEFAULT_A11Y_ENABLED_MODES);
    expect(sanitizeA11yEnabledModes(42)).toEqual(DEFAULT_A11Y_ENABLED_MODES);
  });
});

describe('clampA11yModeState (#321)', () => {
  const chosen: A11yModeState = { fontScale: '1.6', highContrast: true, lowReach: true };

  it('全モード有効なら値をそのまま保つ', () => {
    expect(clampA11yModeState(chosen, DEFAULT_A11Y_ENABLED_MODES)).toEqual(chosen);
  });

  it('無効化されたモードは既定値へ丸める（テナント設定変更後の残留を防ぐ）', () => {
    const enabled = { largeText: false, highContrast: false, lowReach: true, simpleJapanese: true };
    expect(clampA11yModeState(chosen, enabled)).toEqual({
      fontScale: DEFAULT_FONT_SCALE,
      highContrast: false,
      lowReach: true,
    });
  });

  it('全モード無効なら既定状態に一致する', () => {
    const enabled = { largeText: false, highContrast: false, lowReach: false, simpleJapanese: false };
    expect(clampA11yModeState(chosen, enabled)).toEqual(DEFAULT_A11Y_MODE_STATE);
  });
});
