import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAiGuidanceConfig,
  getAiGuidanceConfig,
  updateAiGuidanceConfig,
} from './config-store';

beforeEach(async () => {
  await __resetAiGuidanceConfig();
});

describe('ai-guidance config-store (#104)', () => {
  it('既定では無効・許可トピックなし', async () => {
    const c = await getAiGuidanceConfig();
    expect(c.enabled).toBe(false);
    expect(c.allowedTopics).toEqual([]);
  });

  it('有効化と許可トピックを更新できる（正規化される）', async () => {
    const c = await updateAiGuidanceConfig({ enabled: true, allowedTopics: 'FAQ, 施設案内, FAQ' });
    expect(c.enabled).toBe(true);
    expect(c.allowedTopics).toEqual(['FAQ', '施設案内']);
  });

  it('未指定フィールドは現状維持する', async () => {
    await updateAiGuidanceConfig({ enabled: true, allowedTopics: ['x'] });
    const c = await updateAiGuidanceConfig({ allowedTopics: ['y'] });
    expect(c.enabled).toBe(true);
    expect(c.allowedTopics).toEqual(['y']);
  });
});
