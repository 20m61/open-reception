/**
 * 対象テナントによる read スコープ絞り込みの純関数テスト (issue #83 inc3b-2 / #90)。
 */
import { describe, expect, it } from 'vitest';
import { filterToSelectedTenant, scopeIncludesSelectedTenant } from './tenant-scope';

const items = [
  { id: 'p', scope: 'platform' as const },
  { id: 't-acme', scope: 'tenant' as const, tenantId: 'acme' },
  { id: 't-internal', scope: 'tenant' as const, tenantId: 'internal' },
  { id: 's-acme', scope: 'site' as const, tenantId: 'acme' },
];

describe('scopeIncludesSelectedTenant', () => {
  it('未選択は常に含む', () => {
    expect(scopeIncludesSelectedTenant({ scope: 'tenant', tenantId: 'acme' }, null)).toBe(true);
  });
  it('platform スコープは選択時も常に含む（全体影響）', () => {
    expect(scopeIncludesSelectedTenant({ scope: 'platform' }, 'acme')).toBe(true);
  });
  it('tenantId 一致のみ含む', () => {
    expect(scopeIncludesSelectedTenant({ scope: 'tenant', tenantId: 'acme' }, 'acme')).toBe(true);
    expect(scopeIncludesSelectedTenant({ scope: 'tenant', tenantId: 'internal' }, 'acme')).toBe(false);
  });
});

describe('filterToSelectedTenant', () => {
  it('未選択は全件（順序保持）', () => {
    expect(filterToSelectedTenant(items, null).map((i) => i.id)).toEqual([
      'p',
      't-acme',
      't-internal',
      's-acme',
    ]);
  });
  it('選択時は platform + 選択テナント（site も tenantId 一致で含む）', () => {
    expect(filterToSelectedTenant(items, 'acme').map((i) => i.id)).toEqual(['p', 't-acme', 's-acme']);
  });
});
