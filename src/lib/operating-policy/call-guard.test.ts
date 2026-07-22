import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';

const resolveKioskStatusFor = vi.fn();
vi.mock('./store', () => ({
  resolveKioskStatusFor: (...a: unknown[]) => resolveKioskStatusFor(...a),
}));

import { evaluateCallGuard } from './call-guard';

const TENANT = asTenantId('t1');
const SITE = asSiteId('s1');

beforeEach(() => vi.clearAllMocks());

describe('evaluateCallGuard', () => {
  it('open のとき許可する', async () => {
    resolveKioskStatusFor.mockResolvedValue({ state: 'open' });
    await expect(evaluateCallGuard(TENANT, SITE)).resolves.toEqual({ allowed: true });
  });

  it('closed のとき拒否し reopenAt を返す', async () => {
    resolveKioskStatusFor.mockResolvedValue({ state: 'closed', reopenAt: '2026-07-23T00:00:00.000Z' });
    await expect(evaluateCallGuard(TENANT, SITE)).resolves.toEqual({
      allowed: false,
      reason: 'out_of_hours',
      reopenAt: '2026-07-23T00:00:00.000Z',
    });
  });

  it('ポリシー未設定（undefined）は fail-open で許可する', async () => {
    resolveKioskStatusFor.mockResolvedValue(undefined);
    await expect(evaluateCallGuard(TENANT, SITE)).resolves.toEqual({ allowed: true });
  });

  it('判定が例外でも fail-open で許可する', async () => {
    resolveKioskStatusFor.mockRejectedValue(new Error('boom'));
    await expect(evaluateCallGuard(TENANT, SITE)).resolves.toEqual({ allowed: true });
  });
});
