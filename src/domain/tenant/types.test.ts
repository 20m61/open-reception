import { describe, expect, it } from 'vitest';
import {
  asDeviceId,
  asSiteId,
  asTenantId,
  isTenantRole,
  TENANT_ROLES,
} from './types';

describe('isTenantRole (#80)', () => {
  it.each(TENANT_ROLES)('既知ロール "%s" を受理する', (role) => {
    expect(isTenantRole(role)).toBe(true);
  });
  it('未知・非文字列は拒否', () => {
    expect(isTenantRole('Admin')).toBe(false);
    expect(isTenantRole('')).toBe(false);
    expect(isTenantRole(undefined)).toBe(false);
    expect(isTenantRole(123)).toBe(false);
  });
});

describe('ID ヘルパ (#80)', () => {
  it('文字列をブランド ID へ畳み込む（実行時は素の文字列）', () => {
    expect(asTenantId('t1')).toBe('t1');
    expect(asSiteId('s1')).toBe('s1');
    expect(asDeviceId('d1')).toBe('d1');
  });
});
