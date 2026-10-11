import { describe, expect, it } from 'vitest';
import { MOTION_KEYS } from './types';
import { STANDARD_MOTION_PRESETS, standardMotionPresetFor } from './standard-presets';

describe('STANDARD_MOTION_PRESETS', () => {
  it('covers every MotionKey exactly once', () => {
    expect(Object.keys(STANDARD_MOTION_PRESETS).sort()).toEqual([...MOTION_KEYS].sort());
  });

  it('uses safe transition ranges for kiosk motion changes', () => {
    for (const key of MOTION_KEYS) {
      const preset = standardMotionPresetFor(key);
      expect(preset.fadeInSec).toBeGreaterThanOrEqual(0);
      expect(preset.fadeInSec).toBeLessThanOrEqual(0.5);
      expect(preset.fadeOutSec).toBeGreaterThanOrEqual(0);
      expect(preset.fadeOutSec).toBeLessThanOrEqual(0.5);
    }
  });

  it('keeps user-facing completion/error states non-looping', () => {
    expect(standardMotionPresetFor('success').loop).toBe(false);
    expect(standardMotionPresetFor('failed').loop).toBe(false);
    expect(standardMotionPresetFor('timeout').loop).toBe(false);
  });

  it('uses UI gaze for states whose primary purpose is guidance/confirmation', () => {
    expect(standardMotionPresetFor('selecting').gaze).toBe('ui');
    expect(standardMotionPresetFor('thinking').gaze).toBe('ui');
    expect(standardMotionPresetFor('fallback').gaze).toBe('ui');
  });
});
