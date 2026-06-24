import { describe, it, expect } from 'vitest';
import { AVATAR_EXPRESSIONS } from './guidance';
import { VRM_EMOTION_PRESETS, vrmEmotionPreset, emotionExpressionValues } from './vrm-expression';

describe('vrm-expression (#31)', () => {
  it('全ての論理表情が VRM preset に写像される', () => {
    for (const e of AVATAR_EXPRESSIONS) {
      const preset = vrmEmotionPreset(e);
      expect(VRM_EMOTION_PRESETS).toContain(preset);
    }
  });

  it('対応する preset があるものは素直に写像する', () => {
    expect(vrmEmotionPreset('happy')).toBe('happy');
    expect(vrmEmotionPreset('relaxed')).toBe('relaxed');
    expect(vrmEmotionPreset('neutral')).toBe('neutral');
  });

  it('VRM に無い表情は近い preset へ寄せる', () => {
    expect(vrmEmotionPreset('concerned')).toBe('sad');
    expect(vrmEmotionPreset('thinking')).toBe('neutral');
  });

  it('emotionExpressionValues は対象 preset のみ 1.0・他は 0', () => {
    const values = emotionExpressionValues('happy');
    expect(values).toHaveLength(VRM_EMOTION_PRESETS.length);
    const active = values.filter((v) => v.value === 1);
    expect(active).toHaveLength(1);
    expect(active[0]?.name).toBe('happy');
    // 残りは全て 0。
    expect(values.filter((v) => v.value !== 0 && v.value !== 1)).toHaveLength(0);
  });
});
