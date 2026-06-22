import { describe, expect, it } from 'vitest';
import {
  applyAiGuidanceConfigPatch,
  defaultAiGuidanceConfig,
  normalizeAllowedTopics,
} from './config';

describe('AI 案内設定の既定 (#104)', () => {
  it('既定は無効・許可トピックなし', () => {
    expect(defaultAiGuidanceConfig()).toEqual({ enabled: false, allowedTopics: [] });
  });
});

describe('normalizeAllowedTopics (#104)', () => {
  it('カンマ/改行区切りの文字列を分割し trim・空除去する', () => {
    expect(normalizeAllowedTopics('FAQ, 施設案内\n受付操作 ,')).toEqual([
      'FAQ',
      '施設案内',
      '受付操作',
    ]);
  });

  it('配列を受け取り重複を除去する（初出順）', () => {
    expect(normalizeAllowedTopics(['a', 'b', 'a', ' b '])).toEqual(['a', 'b']);
  });

  it('文字列でも配列でもない入力は空配列', () => {
    expect(normalizeAllowedTopics(undefined)).toEqual([]);
    expect(normalizeAllowedTopics(123)).toEqual([]);
  });

  it('長すぎるトピックは切り詰め、件数は上限まで', () => {
    const long = 'x'.repeat(100);
    expect(normalizeAllowedTopics([long])[0]).toHaveLength(60);
    const many = Array.from({ length: 80 }, (_, i) => `t${i}`);
    expect(normalizeAllowedTopics(many)).toHaveLength(50);
  });
});

describe('applyAiGuidanceConfigPatch (#104)', () => {
  it('enabled は boolean のときだけ反映、他は現状維持', () => {
    const base = { enabled: false, allowedTopics: ['x'] };
    expect(applyAiGuidanceConfigPatch(base, { enabled: true })).toEqual({
      enabled: true,
      allowedTopics: ['x'],
    });
    expect(applyAiGuidanceConfigPatch(base, { enabled: 'yes' })).toEqual(base);
  });

  it('allowedTopics は正規化して置き換える', () => {
    const base = { enabled: true, allowedTopics: ['old'] };
    expect(applyAiGuidanceConfigPatch(base, { allowedTopics: 'a, a, b' })).toEqual({
      enabled: true,
      allowedTopics: ['a', 'b'],
    });
  });

  it('非破壊（入力を変更しない）', () => {
    const base = { enabled: false, allowedTopics: ['x'] };
    applyAiGuidanceConfigPatch(base, { enabled: true, allowedTopics: ['y'] });
    expect(base).toEqual({ enabled: false, allowedTopics: ['x'] });
  });
});
