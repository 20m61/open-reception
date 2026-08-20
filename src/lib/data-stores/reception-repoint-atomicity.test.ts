/**
 * 相関キーの付け替えが **atomic な原始操作**を通ること (#646 / レビュー M2)。
 *
 * ## なぜ構造で固定するのか
 *
 * 塞ぎたい事故は「読んでから書くまでの間に `/status` が `markTimeout` を書き、その後の
 * **全体置換**が `state` / `callOutcome` / `completedAt` を `'calling'` へ巻き戻す」。
 * 受付履歴の採番には重複排除が無いので、後で再度確定すると同じ受付の履歴・監査が 2 件残る。
 *
 * 🔴 **この競合は memory backend では再現できない**（単一スレッドで read→write の間に
 * 何も割り込めない）。read-modify-write に戻す変異を当てても振る舞いテストは全部 green の
 * ままになる ── 実際に確かめた。よってここでは「**どの原始操作を使ったか**」を固定する。
 *
 * `updateIf` は DynamoDB では `UpdateItem` + `ConditionExpression`（名指しした属性だけを
 * SET）になるので、条件判定と部分更新が 1 リクエストで原子的に行われる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateIf = vi.fn();
const put = vi.fn();
const get = vi.fn();

vi.mock('@/lib/data', () => ({
  getBackend: () => ({ collection: () => ({ updateIf, put, get }) }),
}));

import { DataBackedReceptionSessionRepository } from './reception-repository';

beforeEach(() => {
  vi.clearAllMocks();
  updateIf.mockResolvedValue(true);
});

describe('setProviderCallIdIfCalling は atomic な原始操作を通る (#646)', () => {
  it('🔴 updateIf を使う ── 全体置換（put）はしない', async () => {
    await new DataBackedReceptionSessionRepository().setProviderCallIdIfCalling(
      'rec-1',
      'TEST-call-2',
      '2026-08-20T00:01:00.000Z',
    );
    expect(updateIf).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
    // 読んでから書く形にすると、読みと書きの間に窓ができる。
    expect(get).not.toHaveBeenCalled();
  });

  it("🔴 条件は「呼び出し中であること」── 終端した受付を蘇生させない", async () => {
    await new DataBackedReceptionSessionRepository().setProviderCallIdIfCalling(
      'rec-1',
      'TEST-call-2',
      '2026-08-20T00:01:00.000Z',
    );
    const [id, changes, expected] = updateIf.mock.calls[0] as [string, object, object];
    expect(id).toBe('rec-1');
    expect(expected).toEqual({ state: 'calling' });
    // 🔴 更新するのは相関キーと更新時刻**だけ**。state や callOutcome を含めると、
    // 名指しした属性が上書きされて同じ巻き戻しが起きる。
    expect(changes).toEqual({
      providerCallId: 'TEST-call-2',
      updatedAt: '2026-08-20T00:01:00.000Z',
    });
  });

  it('条件に合わなければ false を返す（何も書かない）', async () => {
    updateIf.mockResolvedValue(false);
    expect(
      await new DataBackedReceptionSessionRepository().setProviderCallIdIfCalling(
        'rec-1',
        'TEST-call-2',
        '2026-08-20T00:01:00.000Z',
      ),
    ).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});
