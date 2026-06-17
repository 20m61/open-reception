import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetStore,
  cancelReception,
  completeReception,
  createReception,
  recordFallback,
  startCall,
} from './reception-store';
import {
  __resetLogStore,
  listAuditLogs,
  listReceptionLogs,
} from './reception-log-store';

const baseInput = {
  kioskId: 'kiosk-1',
  purpose: 'meeting',
  targetType: 'staff' as const,
  targetId: 'staff-sato',
  targetLabel: '佐藤 太郎',
  visitor: { name: '来客 一郎', company: 'ACME', note: '内密の用件' },
};

beforeEach(() => {
  __resetStore();
  __resetLogStore();
});

async function runReception(targetId: string, targetLabel: string) {
  const created = createReception({ ...baseInput, targetId, targetLabel });
  if (!created.ok) throw new Error('create failed');
  await startCall(created.value.id);
  return created.value.id;
}

describe('reception history logging (#19)', () => {
  it('未応答を受付履歴に記録する', async () => {
    await runReception('staff-suzuki', '鈴木 花子');
    const logs = listReceptionLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.outcome).toBe('timeout');
  });

  it('失敗を受付履歴に記録し失敗理由を残す', async () => {
    await runReception('staff-takahashi', '高橋 健');
    const logs = listReceptionLogs();
    expect(logs[0]?.outcome).toBe('failed');
    expect(logs[0]?.failureReason).toBe('call_failed');
  });

  it('成功は完了時に記録する', async () => {
    const id = await runReception('staff-sato', '佐藤 太郎');
    expect(listReceptionLogs()).toHaveLength(0); // connected だけではまだ履歴化しない
    completeReception(id);
    const logs = listReceptionLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.outcome).toBe('connected');
  });

  it('キャンセルを記録する', () => {
    const created = createReception(baseInput);
    if (!created.ok) return;
    cancelReception(created.value.id);
    expect(listReceptionLogs()[0]?.outcome).toBe('cancelled');
  });

  it('受付履歴に来訪者の個人情報を含めない', async () => {
    await runReception('staff-suzuki', '鈴木 花子');
    const serialized = JSON.stringify(listReceptionLogs());
    expect(serialized).not.toContain('来客 一郎');
    expect(serialized).not.toContain('ACME');
    expect(serialized).not.toContain('内密の用件');
  });

  it('所要時間を記録する', async () => {
    await runReception('staff-suzuki', '鈴木 花子');
    expect(listReceptionLogs()[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('代替導線の利用を記録する', async () => {
    const id = await runReception('staff-suzuki', '鈴木 花子');
    const r = recordFallback(id);
    expect(r.ok && r.value.state).toBe('fallback');
    expect(listReceptionLogs()[0]?.fallbackUsed).toBe(true);
  });

  it('監査ログに受付イベントを残す', async () => {
    await runReception('staff-suzuki', '鈴木 花子');
    const audit = listAuditLogs();
    expect(audit.some((a) => a.action === 'reception.timeout')).toBe(true);
    expect(audit[0]?.actor).toBe('kiosk:kiosk-1');
  });

  it('完了イベントを監査ログに残す', async () => {
    const id = await runReception('staff-sato', '佐藤 太郎');
    completeReception(id);
    const audit = listAuditLogs();
    expect(audit.some((a) => a.action === 'reception.completed')).toBe(true);
  });
});
