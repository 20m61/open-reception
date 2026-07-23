import { describe, expect, it } from 'vitest';
import { readOperatingScope } from './request';

describe('readOperatingScope', () => {
  it('URLSearchParams から tenantId/siteId を取り出す', () => {
    const result = readOperatingScope(new URLSearchParams({ tenantId: 't1', siteId: 's1' }));
    expect(result).toEqual({ ok: true, tenantId: 't1', siteId: 's1' });
  });

  it('body オブジェクトから tenantId/siteId を取り出す', () => {
    const result = readOperatingScope({ tenantId: 't1', siteId: 's1', other: 1 });
    expect(result).toEqual({ ok: true, tenantId: 't1', siteId: 's1' });
  });

  it('tenantId 未指定は invalid_input', () => {
    const result = readOperatingScope(new URLSearchParams({ siteId: 's1' }));
    expect(result).toEqual({ ok: false, error: { code: 'invalid_input', message: 'tenantId is required' } });
  });

  it('siteId 未指定は invalid_input（営業時間ポリシーはサイト単位のため必須）', () => {
    const result = readOperatingScope(new URLSearchParams({ tenantId: 't1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/siteId/);
  });
});
