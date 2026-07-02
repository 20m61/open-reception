/**
 * platform 系リポジトリの契約テスト（#274 ③: 6 store の repository 標準化）。
 *
 * §9.2（docs/persistence-design.md）の標準どおり、実装は getBackend() 委譲の 1 つだけ。
 * memory backend（DATA_BACKEND 既定）で round-trip・seed/reset・updateIf CAS の契約を検証する。
 * elevation-jti の fail-closed / 冪等 revoke は互換 API 側のテスト
 * （elevation-jti-store.test.ts）も引き続き固定している（本テストは実装を直接叩く）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Incident } from '@/domain/platform/incident';
import { __resetBackend } from '@/lib/data';
import {
  DataBackedElevationJtiRepository,
  DataBackedPlatformRecordRepository,
  DataBackedTenantFeatureFlagRepository,
  PLATFORM_INCIDENT_COLLECTION,
} from './repository';

const NOW = 1_000_000_000_000;

afterEach(() => {
  __resetBackend();
});

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    scope: 'platform',
    severity: 'minor',
    status: 'monitoring',
    title: 'テスト障害',
    message: 'テスト用',
    startedAt: '2026-07-01T00:00:00.000Z',
    updatedBy: 'platform:test',
    ...over,
  };
}

describe('DataBackedPlatformRecordRepository (#274 ③)', () => {
  function makeRepo(seed?: Incident[]) {
    __resetBackend();
    return new DataBackedPlatformRecordRepository<Incident>(
      PLATFORM_INCIDENT_COLLECTION,
      seed ? () => seed.map((i) => ({ ...i })) : undefined,
    );
  }

  it('seed が memory backend に投入され list で返る', async () => {
    const repo = makeRepo([incident()]);
    expect((await repo.list()).map((i) => i.id)).toEqual(['inc-1']);
  });

  it('create → list が round-trip する（同一 id は上書き）', async () => {
    const repo = makeRepo();
    await repo.create(incident());
    await repo.create(incident({ status: 'resolved' }));
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('resolved');
  });

  it('reset で seed 状態へ戻る（テスト導線）', async () => {
    const repo = makeRepo([incident()]);
    await repo.create(incident({ id: 'inc-extra' }));
    await repo.reset();
    expect((await repo.list()).map((i) => i.id)).toEqual(['inc-1']);
  });
});

describe('DataBackedTenantFeatureFlagRepository (#274 ③)', () => {
  function makeRepo() {
    __resetBackend();
    return new DataBackedTenantFeatureFlagRepository();
  }

  it('putRecord → getRecord / listRecords が round-trip し、未作成は undefined', async () => {
    const repo = makeRepo();
    expect(await repo.getRecord('tenant-a')).toBeUndefined();
    await repo.putRecord({
      id: 'tenant-a',
      flags: { voiceSynthesis: false },
      updatedAt: '2026-07-01T00:00:00.000Z',
      updatedBy: 'platform:test',
    });
    expect((await repo.getRecord('tenant-a'))?.flags).toEqual({ voiceSynthesis: false });
    expect((await repo.listRecords()).map((r) => r.id)).toEqual(['tenant-a']);
  });

  it('reset で空へ戻る（seed なしが既定状態）', async () => {
    const repo = makeRepo();
    await repo.putRecord({
      id: 'tenant-a',
      flags: {},
      updatedAt: '2026-07-01T00:00:00.000Z',
      updatedBy: 'platform:test',
    });
    await repo.reset();
    expect(await repo.listRecords()).toEqual([]);
  });
});

describe('DataBackedElevationJtiRepository (#274 ③ — 挙動不変のセキュリティ経路)', () => {
  function makeRepo() {
    __resetBackend();
    return new DataBackedElevationJtiRepository();
  }

  it('register → state が active、未登録は unknown（fail-closed）', async () => {
    const repo = makeRepo();
    await repo.register({ jti: 'j1', sub: 'dev@example.com', expiresAt: NOW + 60_000 });
    expect(await repo.state('j1', NOW)).toBe('active');
    expect(await repo.state('nope', NOW)).toBe('unknown');
  });

  it('revoke は CAS で最初の revokedAt を保持し、冪等に true を返す', async () => {
    const repo = makeRepo();
    await repo.register({ jti: 'j1', sub: 'dev@example.com', expiresAt: NOW + 60_000 });
    expect(await repo.revoke('j1', NOW)).toBe(true);
    expect(await repo.revoke('j1', NOW + 1)).toBe(true);
    expect(await repo.state('j1', NOW)).toBe('revoked');
  });

  it('未登録 jti の revoke は false（何もしない）、期限切れは expired', async () => {
    const repo = makeRepo();
    expect(await repo.revoke('nope', NOW)).toBe(false);
    await repo.register({ jti: 'j2', sub: 'dev@example.com', expiresAt: NOW - 1 });
    expect(await repo.state('j2', NOW)).toBe('expired');
  });
});
