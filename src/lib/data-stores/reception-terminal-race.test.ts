/**
 * 受付が終端するとき、取次の相関キーを巻き戻さない (#743 AC1)。
 *
 * ## 事実
 *
 * `markTimeout` / `markCallFailed` は `getReception` で読んでから**全体置換**で書いていた。
 * その間に取次が 2 手目へ進むと（`setProviderCallIdIfCalling`）、置換が
 * `providerCallId` を **1 手目へ巻き戻す**。
 *
 * 受付は terminal なので蘇生はしない（#742 で片方向は塞いだ）が、**2 手目は鳴り続け、
 * `/status` は 1 手目の相関を読むので結果を誰も回収しない** ── 担当者の電話は鳴るのに
 * 来訪者はもうそこに居ない、という「無人の呼び出し」になる。
 *
 * ## 窓を決定的に踏む
 *
 * memory backend は単一スレッドなので自然な競合は起きない。**読みと書きの間に**
 * 別の書き手を差し込んで、同じ順序を再現する。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReceptionSession } from '@/domain/reception/session';
import { getReceptionSessionRepository, markCallFailed, markTimeout, __resetStore } from './reception-store';

const ID = 'TEST-reception-race';

function calling(over: Partial<ReceptionSession> = {}): ReceptionSession {
  return {
    id: ID,
    kioskId: 'TEST-kiosk',
    state: 'calling',
    targetType: 'staff',
    targetId: 'staff-seed',
    targetLabel: 'TEST-担当',
    providerCallId: 'TEST-call-hop1',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  } as ReceptionSession;
}

beforeEach(async () => {
  await __resetStore();
  await getReceptionSessionRepository().put(calling());
});

/**
 * `markTimeout` などが**読んだ直後**に取次が 2 手目へ進む、という順序を作る。
 * これが実際の窓で、事前に付け替えておくだけのテストは窓を踏まない（素通りする）。
 */
async function repointDuringRead(run: () => Promise<unknown>): Promise<void> {
  const repo = getReceptionSessionRepository();
  const originalGet = repo.get.bind(repo);
  let interleaved = false;
  repo.get = async (id: string) => {
    const found = await originalGet(id);
    if (!interleaved) {
      interleaved = true;
      await repo.setProviderCallIdIfCalling(ID, 'TEST-call-hop2', '2026-08-20T00:00:05.000Z');
    }
    return found;
  };
  try {
    await run();
  } finally {
    repo.get = originalGet;
  }
}

describe('終端の書き込みは相関キーを巻き戻さない (#743)', () => {
  /**
   * 🔴 **これが本体。** 取次が 2 手目へ進んだあとに終端の書き込みが届いても、
   * 相関キーは 2 手目のままでなければならない。全体置換で書くと、読んだ時点の
   * `providerCallId`（1 手目）が書き戻され、**2 手目は鳴り続けるのに `/status` は
   * 1 手目の相関を読む**（結果を誰も回収しない「無人の呼び出し」）。
   */
  it('🔴 markTimeout は providerCallId を巻き戻さない', async () => {
    await repointDuringRead(() => markTimeout(ID));
    const after = await getReceptionSessionRepository().get(ID);
    expect(after?.state).toBe('timeout');
    expect(after?.providerCallId, '1 手目へ巻き戻っている').toBe('TEST-call-hop2');
  });

  it('🔴 markCallFailed も巻き戻さない', async () => {
    await repointDuringRead(() => markCallFailed(ID, 'TEST-reason'));
    const after = await getReceptionSessionRepository().get(ID);
    expect(after?.state).toBe('failed');
    expect(after?.providerCallId).toBe('TEST-call-hop2');
  });

  it('競合が無いときも従来どおり終端する', async () => {
    const result = await markTimeout(ID);
    expect(result.ok).toBe(true);
    const after = await getReceptionSessionRepository().get(ID);
    expect(after?.state).toBe('timeout');
    expect(after?.callOutcome).toBe('timeout');
    expect(after?.completedAt).toBeDefined();
    // 触っていない項目は残る（部分更新であることの確認）。
    expect(after?.providerCallId).toBe('TEST-call-hop1');
  });

  /**
   * 🔴 **同じ受付の履歴を 2 件残さない。** 採番に重複排除が無いので、
   * 終端の書き込みが 2 度成立すると履歴・監査が二重に残る。
   */
  it('🔴 終端したあとの二重終端は成立しない', async () => {
    expect((await markTimeout(ID)).ok).toBe(true);
    expect((await markTimeout(ID)).ok).toBe(false);
  });
});
