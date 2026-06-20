/**
 * プラットフォーム概況集計の単体テスト (issue #90, increment 1)。
 */
import { describe, expect, it } from 'vitest';
import { asTenantId, type Tenant } from '@/domain/tenant/types';
import { summarizeTenantFleet, toTenantRows } from './console-summary';

function tenant(args: {
  id: string;
  name: string;
  slug: string;
  status: Tenant['status'];
}): Tenant {
  return {
    id: asTenantId(args.id),
    name: args.name,
    slug: args.slug,
    status: args.status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

describe('summarizeTenantFleet', () => {
  it('counts total / active / suspended', () => {
    const summary = summarizeTenantFleet([
      tenant({ id: 'a', name: 'A', slug: 'a', status: 'active' }),
      tenant({ id: 'b', name: 'B', slug: 'b', status: 'active' }),
      tenant({ id: 'c', name: 'C', slug: 'c', status: 'suspended' }),
    ]);
    expect(summary).toEqual({ total: 3, active: 2, suspended: 1 });
  });

  it('handles empty fleet', () => {
    expect(summarizeTenantFleet([])).toEqual({ total: 0, active: 0, suspended: 0 });
  });
});

describe('toTenantRows', () => {
  it('projects only non-sensitive metadata and sorts by name then id', () => {
    const rows = toTenantRows([
      tenant({ id: 'z', name: 'Zebra', slug: 'zebra', status: 'active' }),
      tenant({ id: 'a', name: 'Alpha', slug: 'alpha', status: 'suspended' }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Zebra']);
    const first = rows[0];
    expect(first).toEqual({
      id: 'a',
      name: 'Alpha',
      slug: 'alpha',
      status: 'suspended',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    // PII/機密値や createdAt 等の内部情報を含めない。
    expect(Object.keys(first ?? {}).sort()).toEqual(['id', 'name', 'slug', 'status', 'updatedAt']);
  });
});
