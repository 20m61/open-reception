import { describe, expect, it } from 'vitest';
import { feedbackMeta } from './Feedback';
import { color } from './tokens';

describe('feedbackMeta: 保存フィードバックの見た目/a11y ロール (issue #330)', () => {
  it('success は role="status" / aria-live="polite" / success 色', () => {
    const meta = feedbackMeta('success');
    expect(meta.role).toBe('status');
    expect(meta.ariaLive).toBe('polite');
    expect(meta.color).toBe(color.success);
  });

  it('error は role="alert" / aria-live="assertive" / danger 色（読み上げ優先度を上げる）', () => {
    const meta = feedbackMeta('error');
    expect(meta.role).toBe('alert');
    expect(meta.ariaLive).toBe('assertive');
    expect(meta.color).toBe(color.danger);
  });
});
