import { describe, expect, it } from 'vitest';
import type { OrganizationUnit } from './types';
import { ORGANIZATION_RELATIONS, isOrganizationRelation, isWithinScope } from './types';

function unit(overrides: Partial<OrganizationUnit> = {}): OrganizationUnit {
  return {
    id: 'org-1',
    tenantId: 'tenant-a',
    officialName: '正式名称',
    publicDisplayName: '公開名',
    aliases: [],
    displayOrder: 0,
    enabled: true,
    publicInDirectory: true,
    ...overrides,
  };
}

describe('isOrganizationRelation', () => {
  it('既知の関係を受理する', () => {
    for (const relation of ORGANIZATION_RELATIONS) {
      expect(isOrganizationRelation(relation)).toBe(true);
    }
  });

  it('未知の値・非文字列を拒否する', () => {
    expect(isOrganizationRelation('owner')).toBe(false);
    expect(isOrganizationRelation(undefined)).toBe(false);
    expect(isOrganizationRelation(1)).toBe(false);
  });
});

describe('isWithinScope', () => {
  it('他テナントの組織を境界外と判定する', () => {
    expect(isWithinScope(unit({ tenantId: 'tenant-b' }), { tenantId: 'tenant-a' })).toBe(false);
  });

  it('site 未指定の scope はテナント内の全組織を含む', () => {
    expect(isWithinScope(unit({ siteId: 'site-9' }), { tenantId: 'tenant-a' })).toBe(true);
  });

  it('site 指定の scope は同一サイトとテナント横断組織のみ含む', () => {
    const scope = { tenantId: 'tenant-a', siteId: 'site-1' };
    expect(isWithinScope(unit({ siteId: 'site-1' }), scope)).toBe(true);
    expect(isWithinScope(unit({ siteId: undefined }), scope)).toBe(true);
    expect(isWithinScope(unit({ siteId: 'site-2' }), scope)).toBe(false);
  });
});
