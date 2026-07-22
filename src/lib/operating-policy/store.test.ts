/**
 * 営業時間ポリシーストアのテスト (issue #367)。
 * memory backend への実書き込み・楽観カウンタ・監査・fail-open (resolveKioskStatusFor) を検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appendAdminAudit = vi.fn();
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAdminAudit: (...a: unknown[]) => appendAdminAudit(...a),
}));

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

    const updated = await upsertOperatingPolicy('t1', 's1', 'admin@example.com', {
      weeklySchedule: { mon: [{ start: '10:00', end: '19:00' }] },
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

  it('保存を site.updated として監査する（PII/時間帯の具体値は残さない）', async () => {
    await upsertOperatingPolicy('t1', 's1', 'admin@example.com', {
      weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
    });
    expect(appendAdminAudit).toHaveBeenCalledWith(
      'site.updated',
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
