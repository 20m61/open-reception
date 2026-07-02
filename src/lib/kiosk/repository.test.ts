/**
 * KioskRepository の契約テスト（#274 ②: kiosk-store の repository 標準化）。
 *
 * §9.2（docs/persistence-design.md）の標準どおり、実装は getBackend() 委譲の 1 つだけ。
 * memory backend（DATA_BACKEND 既定）で round-trip と seed / reset の契約を検証する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Kiosk } from '@/domain/kiosk/types';
import { __resetBackend } from '@/lib/data';
import { DataBackedKioskRepository } from './repository';

afterEach(() => {
  __resetBackend();
});

const seedKiosks: Kiosk[] = [
  { id: 'kiosk-dev', displayName: '受付端末1', location: '1F', enabled: true },
];

function makeRepo(seed?: Kiosk[]) {
  __resetBackend();
  return new DataBackedKioskRepository(seed ? () => seed.map((k) => ({ ...k })) : undefined);
}

describe('DataBackedKioskRepository (#274)', () => {
  it('seed が memory backend に投入され listKiosks で返る', async () => {
    const repo = makeRepo(seedKiosks);
    expect((await repo.listKiosks()).map((k) => k.id)).toEqual(['kiosk-dev']);
  });

  it('putKiosk → getKiosk が round-trip する', async () => {
    const repo = makeRepo();
    await repo.putKiosk({ id: 'k1', displayName: '端末', enabled: true });
    expect(await repo.getKiosk('k1')).toMatchObject({ id: 'k1', displayName: '端末' });
    expect(await repo.getKiosk('nope')).toBeUndefined();
  });

  it('putKiosk は同一 id を上書きする（enabled 切替）', async () => {
    const repo = makeRepo(seedKiosks);
    const cur = await repo.getKiosk('kiosk-dev');
    await repo.putKiosk({ ...cur!, enabled: false });
    expect((await repo.getKiosk('kiosk-dev'))?.enabled).toBe(false);
  });

  it('reset で seed 状態へ戻る（テスト導線）', async () => {
    const repo = makeRepo(seedKiosks);
    await repo.putKiosk({ id: 'extra', displayName: '追加', enabled: true });
    await repo.reset();
    expect((await repo.listKiosks()).map((k) => k.id)).toEqual(['kiosk-dev']);
  });
});
