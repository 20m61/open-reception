/**
 * ReceptionSessionRepository の契約テスト（#274 ⑤: reception-store の repository 標準化）。
 *
 * §9.2（docs/persistence-design.md）の標準どおり、実装は getBackend() 委譲の 1 つだけ。
 * memory backend（DATA_BACKEND 既定）で round-trip / reset の契約を検証する。
 * 状態機械・監査・履歴化の挙動は reception-store.test.ts が固定する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ReceptionSession } from '@/domain/reception/session';
import { __resetBackend } from '@/lib/data';
import { DataBackedReceptionSessionRepository } from './reception-repository';

afterEach(() => {
  __resetBackend();
});

function session(over: Partial<ReceptionSession> = {}): ReceptionSession {
  return {
    id: 'rcp-1',
    kioskId: 'kiosk-1',
    state: 'confirming',
    purpose: 'meeting',
    targetType: 'staff',
    targetId: 'staff-1',
    targetLabel: '佐藤 太郎',
    visitor: { name: '来客 一郎' },
    startedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

describe('DataBackedReceptionSessionRepository (#274 ⑤)', () => {
  it('put → get が round-trip し、未知 id は undefined', async () => {
    __resetBackend();
    const repo = new DataBackedReceptionSessionRepository();
    await repo.put(session());
    expect(await repo.get('rcp-1')).toMatchObject({ id: 'rcp-1', state: 'confirming' });
    expect(await repo.get('nope')).toBeUndefined();
  });

  it('put は同一 id を上書きする（状態遷移の保存）', async () => {
    __resetBackend();
    const repo = new DataBackedReceptionSessionRepository();
    await repo.put(session());
    await repo.put(session({ state: 'calling' }));
    expect((await repo.get('rcp-1'))?.state).toBe('calling');
  });

  it('reset で初期状態へ戻る（テスト導線）', async () => {
    __resetBackend();
    const repo = new DataBackedReceptionSessionRepository();
    await repo.put(session());
    await repo.reset();
    expect(await repo.get('rcp-1')).toBeUndefined();
  });
});
