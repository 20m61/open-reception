/**
 * 営業時間ポリシーストアのテスト (issue #367)。
 * memory backend への実書き込み・楽観カウンタ・監査・fail-open (resolveKioskStatusFor) を検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appendAdminAudit = vi.fn();
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAdminAudit: (...a: unknown[]) => appendAdminAudit(...a),
}));

import { getBackend } from '@/lib/data';
import { __resetOperatingPolicyStore, getOperatingPolicy, resolveKioskStatusFor, upsertOperatingPolicy } from './store';

beforeEach(async () => {
  vi.clearAllMocks();
  appendAdminAudit.mockResolvedValue(undefined);
  await __resetOperatingPolicyStore();
});

afterEach(async () => {
  await __resetOperatingPolicyStore();
});

describe('getOperatingPolicy', () => {
  it('未設定なら null', async () => {
    await expect(getOperatingPolicy('t1', 's1')).resolves.toBeNull();
  });
});

describe('upsertOperatingPolicy', () => {
  it('不正入力は invalid_input（issues 同梱）で保存しない', async () => {
    const result = await upsertOperatingPolicy('t1', 's1', 'admin@example.com', {
      weeklySchedule: { mon: [{ start: '18:00', end: '09:00' }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
    await expect(getOperatingPolicy('t1', 's1')).resolves.toBeNull();
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });

  it('初回作成は version=1、更新のたびに version が +1 される（楽観ロック用カウンタ）', async () => {
    const created = await upsertOperatingPolicy('t1', 's1', 'admin@example.com', {
      weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.version).toBe(1);

    // 既存レコードの更新には読んだ version を添える（#367 の楽観ロック）。
    const updated = await upsertOperatingPolicy('t1', 's1', 'admin@example.com', {
      weeklySchedule: { mon: [{ start: '10:00', end: '19:00' }] },
      expectedVersion: 1,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.value.version).toBe(2);
  });

  it('テナント/サイトの越境が無いこと（別サイトのキーへは書かない）', async () => {
    await upsertOperatingPolicy('t1', 's1', 'admin@example.com', {
      weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
    });
    await expect(getOperatingPolicy('t1', 's2')).resolves.toBeNull();
    await expect(getOperatingPolicy('t2', 's1')).resolves.toBeNull();
  });

  it('区切り文字を含む tenantId/siteId はキー衝突させず拒否する（`a:b`+`c` と `a`+`b:c`）', async () => {
    await expect(getOperatingPolicy('a:b', 'c')).rejects.toThrow(/invalid tenantId\/siteId/);
    await expect(getOperatingPolicy('a', 'b:c')).rejects.toThrow(/invalid tenantId\/siteId/);
    await expect(
      upsertOperatingPolicy('a:b', 'c', 'admin@example.com', {
        weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
      }),
    ).rejects.toThrow(/invalid tenantId\/siteId/);
  });

  it('保存を operating_policy.updated として監査する（PII/時間帯の具体値は残さない）', async () => {
    await upsertOperatingPolicy('t1', 's1', 'admin@example.com', {
      weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
    });
    expect(appendAdminAudit).toHaveBeenCalledWith(
      'operating_policy.updated',
      { type: 'operating_policy', id: 't1:s1' },
      expect.objectContaining({ resource: 'operating_policy', tenantId: 't1', siteId: 's1' }),
    );
    const metadata = appendAdminAudit.mock.calls[0]![2] as Record<string, string>;
    expect(JSON.stringify(metadata)).not.toContain('09:00');
  });
});

describe('resolveKioskStatusFor (fail-open)', () => {
  it('ポリシー未設定は undefined（常時営業扱い）', async () => {
    await expect(resolveKioskStatusFor('t1', 's1', Date.now())).resolves.toBeUndefined();
  });

  it('保存済みポリシーがあれば評価結果を返す', async () => {
    await upsertOperatingPolicy('t1', 's1', 'admin@example.com', {
      timezone: 'Asia/Tokyo',
      weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
    });
    // 2026-07-20 は月曜日。19:00 JST = 10:00 UTC は営業時間外。
    const closedAt = Date.UTC(2026, 6, 20, 10, 0, 0);
    const status = await resolveKioskStatusFor('t1', 's1', closedAt);
    expect(status?.state).toBe('closed');
    expect(status?.reopenAt).toBeDefined();
  });
});

describe('楽観ロック（競合更新で後勝ち上書きしない, #367）', () => {
  const base = { weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] } };

  it('expectedVersion が現在の version と一致すれば更新できる', async () => {
    const created = await upsertOperatingPolicy('t1', 's1', 'a@example.com', base);
    expect(created.ok).toBe(true);

    const updated = await upsertOperatingPolicy('t1', 's1', 'b@example.com', {
      ...base,
      expectedVersion: 1,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.value.version).toBe(2);
  });

  it('先に別の更新が入っていたら conflict で拒否する（黙って上書きしない）', async () => {
    await upsertOperatingPolicy('t1', 's1', 'a@example.com', base);
    // 2 人が version 1 を読んだ状態。先に B が保存する。
    const first = await upsertOperatingPolicy('t1', 's1', 'b@example.com', {
      ...base,
      expectedVersion: 1,
    });
    expect(first.ok).toBe(true);

    // A の保存は、読んだ version が古いので通してはいけない。
    const second = await upsertOperatingPolicy('t1', 's1', 'a@example.com', {
      weeklySchedule: { tue: [{ start: '08:00', end: '12:00' }] },
      expectedVersion: 1,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('conflict');

    // B の内容が残っていること（A に上書きされていない）。
    const current = await getOperatingPolicy('t1', 's1');
    expect(current?.version).toBe(2);
    expect(Object.keys(current?.weeklySchedule ?? {})).toEqual(['mon']);
  });

  it('レコードが無いのに expectedVersion を送ったら conflict（作成と更新を取り違えない）', async () => {
    const result = await upsertOperatingPolicy('t1', 'missing', 'a@example.com', {
      ...base,
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('conflict');
  });

  it('expectedVersion を省いた既存レコードへの更新は拒否する（後勝ちの経路を残さない）', async () => {
    await upsertOperatingPolicy('t1', 's1', 'a@example.com', base);
    const blind = await upsertOperatingPolicy('t1', 's1', 'b@example.com', base);
    expect(blind.ok).toBe(false);
    if (!blind.ok) expect(blind.error.code).toBe('conflict');
  });
});

describe('読んでから書くまでの隙間（CAS）', () => {
  it('get の後・書き込みの前に他者が入っても上書きしない', async () => {
    // 事前チェック（`existing.version !== expectedVersion`）は**読んだ時点**の判定なので、
    // 読んでから書くまでに入った更新は素通りする。単一プロセスの memory backend では
    // この窓を自然には踏めないので、`get` と書き込みの間に他者の書き込みを差し込む。
    await upsertOperatingPolicy('t1', 's1', 'a@example.com', {
      weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
    });

    const backend = getBackend();
    const real = backend.collection<{ id: string; version: number }>('operating_policy');
    const originalGet = real.get.bind(real);
    let injected = false;
    const spy = vi.spyOn(real, 'get').mockImplementation(async (id: string) => {
      const value = await originalGet(id);
      if (!injected && value) {
        injected = true;
        // 他者がこの隙間で version 2 へ進める。
        await real.updateIf(id, { version: 2 }, { version: 1 });
      }
      return value;
    });

    try {
      const result = await upsertOperatingPolicy('t1', 's1', 'b@example.com', {
        weeklySchedule: { tue: [{ start: '08:00', end: '12:00' }] },
        expectedVersion: 1,
      });
      expect(injected, '隙間への差し込みが起きていない（検査が空振り）').toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('conflict');
    } finally {
      spy.mockRestore();
    }
  });
});
