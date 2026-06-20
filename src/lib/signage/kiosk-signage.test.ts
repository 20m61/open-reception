import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { asSignageItemId, defaultSignageConfig, type SignageConfig } from '@/domain/signage/types';
import { MemorySignageRepository } from './memory-repository';
import { getKioskSignage } from './kiosk-signage';

const T = asTenantId('tenant-a');
const S = asSiteId('site-1');

function seed(over: Partial<SignageConfig>): MemorySignageRepository {
  const repo = new MemorySignageRepository();
  void repo.put({ ...defaultSignageConfig(T, S, '2026-06-20T00:00:00.000Z'), ...over });
  return repo;
}

describe('getKioskSignage (#101)', () => {
  it('設定なしなら enabled=false + 空配列', async () => {
    const r = await getKioskSignage(T, S, new MemorySignageRepository());
    expect(r).toEqual({ enabled: false, defaultIntervalSeconds: 10, items: [] });
  });

  it('無効な設定は出さない', async () => {
    const repo = seed({ enabled: false, items: [{ id: asSignageItemId('a'), type: 'clock', enabled: true }] });
    const r = await getKioskSignage(T, S, repo);
    expect(r.enabled).toBe(false);
    expect(r.items).toEqual([]);
  });

  it('再生可能項目のみを最小形で返し、秒数を解決する', async () => {
    const repo = seed({
      enabled: true,
      defaultIntervalSeconds: 12,
      items: [
        { id: asSignageItemId('a'), type: 'clock', enabled: true },
        { id: asSignageItemId('b'), type: 'image', enabled: true }, // imageUrl 無し → 除外
        { id: asSignageItemId('c'), type: 'message', enabled: true, message: 'ようこそ', durationSeconds: 20 },
      ],
    });
    const r = await getKioskSignage(T, S, repo);
    expect(r.enabled).toBe(true);
    expect(r.items.map((i) => i.type)).toEqual(['clock', 'message']);
    expect(r.items[0]?.durationSeconds).toBe(12);
    expect(r.items[1]?.durationSeconds).toBe(20);
    // id が漏れない（最小形）。
    expect((r.items[0] as Record<string, unknown>).id).toBeUndefined();
  });
});
