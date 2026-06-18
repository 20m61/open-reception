import { describe, expect, it } from 'vitest';
import { canWrite, parseAllowedRoles, resolveAdminRole } from './roles';

describe('resolveAdminRole (#70)', () => {
  it('App Role 文字列を管理ロールへ写像する', () => {
    expect(resolveAdminRole(['OpenReception.Admin'])).toBe('Admin');
    expect(resolveAdminRole(['OpenReception.SiteManager'])).toBe('SiteManager');
    expect(resolveAdminRole(['Viewer'])).toBe('Viewer');
  });
  it('複数ロールでは最も強い権限を採る', () => {
    expect(resolveAdminRole(['Viewer', 'OpenReception.Admin'])).toBe('Admin');
    expect(resolveAdminRole(['Viewer', 'SiteManager'])).toBe('SiteManager');
  });
  it('未知ロール・非配列・空は拒否（null）', () => {
    expect(resolveAdminRole(['Unknown'])).toBeNull();
    expect(resolveAdminRole([])).toBeNull();
    expect(resolveAdminRole('Admin')).toBeNull();
    expect(resolveAdminRole(undefined)).toBeNull();
  });
});

describe('parseAllowedRoles (#70)', () => {
  it('カンマ区切りを解釈する', () => {
    const s = parseAllowedRoles('OpenReception.Admin,Viewer');
    expect(s.has('Admin')).toBe(true);
    expect(s.has('Viewer')).toBe(true);
    expect(s.has('SiteManager')).toBe(false);
  });
  it('未設定/空は全ロール許可', () => {
    expect(parseAllowedRoles(undefined).size).toBe(3);
    expect(parseAllowedRoles('').size).toBe(3);
    expect(parseAllowedRoles('  ').size).toBe(3);
  });
  it('未知のみの指定はフェイルセーフで全ロール許可', () => {
    expect(parseAllowedRoles('Nope').size).toBe(3);
  });
});

describe('canWrite (#70)', () => {
  it('Viewer は読み取り専用', () => {
    expect(canWrite('Viewer')).toBe(false);
    expect(canWrite('SiteManager')).toBe(true);
    expect(canWrite('Admin')).toBe(true);
  });
});
