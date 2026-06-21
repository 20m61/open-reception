/**
 * 担当者応答設定リポジトリの単体テスト (issue #99 inc2)。
 * tenant/site 境界（別テナント・別サイトの設定を返さない）と put/get の往復を検証する。
 */
import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import {
  MemoryStaffResponseConfigRepository,
  staffResponseConfigId,
} from './repository';
import type { StoredStaffResponseConfig } from './types';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_A1 = asSiteId('site-a1');
const S_A2 = asSiteId('site-a2');

function config(tenantId = T_A, siteId = S_A1): StoredStaffResponseConfig {
  return {
    id: staffResponseConfigId(tenantId, siteId),
    tenantId,
    siteId,
    overrides: { coming: { enabled: false } },
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
  };
}

describe('MemoryStaffResponseConfigRepository (#99 inc2)', () => {
  it('保存した設定をサイト単位で取得する', async () => {
    const repo = new MemoryStaffResponseConfigRepository([config()]);
    const got = await repo.get(T_A, S_A1);
    expect(got?.overrides.coming?.enabled).toBe(false);
  });

  it('別サイト / 別テナントの設定は返さない', async () => {
    const repo = new MemoryStaffResponseConfigRepository([config(T_A, S_A1)]);
    expect(await repo.get(T_A, S_A2)).toBeUndefined();
    expect(await repo.get(T_B, S_A1)).toBeUndefined();
  });

  it('put は同じ id を上書きする（防御的コピー）', async () => {
    const repo = new MemoryStaffResponseConfigRepository();
    const c = config();
    await repo.put(c);
    c.overrides = {}; // 返り値が内部状態を共有しないこと（クローン）。
    const got = await repo.get(T_A, S_A1);
    expect(got?.overrides.coming?.enabled).toBe(false);
  });
});
