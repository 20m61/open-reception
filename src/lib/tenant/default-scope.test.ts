import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SITE_ID,
  DEFAULT_TENANT_ID,
  defaultSiteIdFrom,
  defaultTenantIdFrom,
  resolveDefaultScope,
} from './default-scope';

describe('default-scope', () => {
  it('env 未指定なら seed テナント（internal / default-site）に倒れる', () => {
    expect(defaultTenantIdFrom({})).toBe('internal');
    expect(defaultSiteIdFrom({})).toBe('default-site');
    expect(DEFAULT_TENANT_ID).toBe('internal');
    expect(DEFAULT_SITE_ID).toBe('default-site');
  });

  it('env で上書きできる', () => {
    const env = { OPEN_RECEPTION_DEFAULT_TENANT_ID: 'acme', OPEN_RECEPTION_DEFAULT_SITE_ID: 'hq' };
    expect(defaultTenantIdFrom(env)).toBe('acme');
    expect(defaultSiteIdFrom(env)).toBe('hq');
  });

  it('resolveDefaultScope は branded な tenantId/siteId を返す', () => {
    const scope = resolveDefaultScope({});
    expect(scope).toEqual({ tenantId: 'internal', siteId: 'default-site' });
  });
});
