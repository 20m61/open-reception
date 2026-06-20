import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetStore,
  cancelReception,
  completeReception,
  createReception,
  getReception,
  markConnected,
  markTimeout,
  recordStaffResponse,
  getReceptionVisitorStatus,
  startCall,
} from './reception-store';
import { __resetLogStore, listAuditLogs } from './reception-log-store';
import type { CallAdapter } from '@/adapters/call/types';

/** Vonage を模した非同期 adapter（calling を返す）。 */
const callingAdapter: CallAdapter = {
  call: async () => ({ status: 'calling', sessionId: 'sess-async' }),
};

const baseInput = {
  kioskId: 'kiosk-1',
  purpose: 'meeting',
  targetType: 'staff' as const,
  targetId: 'staff-sato',
  targetLabel: '佐藤 太郎',
  visitor: { name: '来客 一郎', company: 'ACME' },
};

beforeEach(async () => {
  await __resetStore();
});

describe('reception-store', () => {
  it('有効な入力で受付セッションを作成できる', async () => {
    const r = await createReception(baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe('confirming');
      expect(r.value.visitor?.name).toBe('来客 一郎');
    }
  });

  it('不正な入力を拒否する', async () => {
    const r = await createReception({ ...baseInput, visitor: { name: '' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });

  it('purpose が不正なら拒否する', async () => {
    const r = await createReception({ ...baseInput, purpose: 'unknown' });
    expect(r.ok).toBe(false);
  });

  it('成功する担当者への呼び出しは connected になる', async () => {
    const created = await createReception(baseInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await startCall(created.value.id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe('connected');
      expect(r.value.callOutcome).toBe('connected');
    }
  });

  it('未応答の担当者への呼び出しは timeout になる', async () => {
    const created = await createReception({ ...baseInput, targetId: 'staff-suzuki', targetLabel: '鈴木 花子' });
    if (!created.ok) return;
    const r = await startCall(created.value.id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe('timeout');
      expect(r.value.completedAt).toBeDefined();
    }
  });

  it('失敗する担当者への呼び出しは failed になる', async () => {
    const created = await createReception({ ...baseInput, targetId: 'staff-takahashi', targetLabel: '高橋 健' });
    if (!created.ok) return;
    const r = await startCall(created.value.id);
    expect(r.ok && r.value.state).toBe('failed');
  });

  it('接続後に完了できる', async () => {
    const created = await createReception(baseInput);
    if (!created.ok) return;
    await startCall(created.value.id);
    const r = await completeReception(created.value.id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe('completed');
      expect(r.value.completedAt).toBeDefined();
    }
  });

  it('confirming からキャンセルできる', async () => {
    const created = await createReception(baseInput);
    if (!created.ok) return;
    const r = await cancelReception(created.value.id);
    expect(r.ok && r.value.state).toBe('cancelled');
  });

  it('不正な状態遷移を拒否する（呼び出し前の complete）', async () => {
    const created = await createReception(baseInput);
    if (!created.ok) return;
    const r = await completeReception(created.value.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_transition');
  });

  it('存在しないセッションは not_found', async () => {
    const r = await getReception('missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });

  describe('非同期通話（Vonage, increment 2）', () => {
    it('calling を返す adapter では calling のまま sessionId を紐づける', async () => {
      const created = await createReception(baseInput);
      if (!created.ok) return;
      const r = await startCall(created.value.id, callingAdapter);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.state).toBe('calling');
        expect(r.value.vonageSessionId).toBe('sess-async');
        expect(r.value.callOutcome).toBeUndefined();
      }
    });

    it('応答で calling → connected に確定する', async () => {
      const created = await createReception(baseInput);
      if (!created.ok) return;
      await startCall(created.value.id, callingAdapter);
      const r = await markConnected(created.value.id);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.state).toBe('connected');
        expect(r.value.callOutcome).toBe('connected');
      }
    });

    it('connected 後に完了できる', async () => {
      const created = await createReception(baseInput);
      if (!created.ok) return;
      await startCall(created.value.id, callingAdapter);
      await markConnected(created.value.id);
      const r = await completeReception(created.value.id);
      expect(r.ok && r.value.state).toBe('completed');
    });

    it('未応答で calling → timeout に確定し completedAt を持つ', async () => {
      const created = await createReception(baseInput);
      if (!created.ok) return;
      await startCall(created.value.id, callingAdapter);
      const r = await markTimeout(created.value.id);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.state).toBe('timeout');
        expect(r.value.callOutcome).toBe('timeout');
        expect(r.value.completedAt).toBeDefined();
      }
    });

    it('応答時に reception.answered を監査ログへ一度だけ記録する', async () => {
      await __resetLogStore();
      const created = await createReception(baseInput);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await startCall(created.value.id, callingAdapter);
      await markConnected(created.value.id, 'staff');
      // 二度目は不正遷移（既に connected）→ answered を重複記録しない。
      await markConnected(created.value.id, 'staff');
      const answered = (await listAuditLogs()).filter(
        (a) => a.action === 'reception.answered' && a.targetId === created.value.id,
      );
      expect(answered).toHaveLength(1);
      expect(answered[0]!.actor).toBe('staff');
    });

    it('calling 以外からの markConnected は不正遷移', async () => {
      const created = await createReception(baseInput);
      if (!created.ok) return;
      const r = await markConnected(created.value.id); // confirming のまま
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_transition');
    });
  });

  describe('recordStaffResponse (issue #99)', () => {
    it('calling 中に応答を記録し、来訪者向け結果を session に載せる', async () => {
      const created = await createReception(baseInput);
      if (!created.ok) return;
      await startCall(created.value.id, callingAdapter); // → calling
      const r = await recordStaffResponse(created.value.id, 'coming');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.action).toBe('coming');
        expect(r.value.kioskStatus).toBe('acknowledged');
        expect(r.value.visitorMessage.length).toBeGreaterThan(0);
      }
      const saved = await getReception(created.value.id);
      if (saved.ok) expect(saved.value.staffResponse?.action).toBe('coming');
    });

    it('最新の応答で上書きする（5分お待ち → 今行きます）', async () => {
      const created = await createReception(baseInput);
      if (!created.ok) return;
      await startCall(created.value.id, callingAdapter);
      await recordStaffResponse(created.value.id, 'wait', { respondedAt: '2026-06-20T00:00:00.000Z' });
      await recordStaffResponse(created.value.id, 'coming', { respondedAt: '2026-06-20T00:01:00.000Z' });
      const saved = await getReception(created.value.id);
      if (saved.ok) expect(saved.value.staffResponse?.action).toBe('coming');
    });

    it('応答種別のみを監査 (reception.staff_responded) に残す（PII を残さない）', async () => {
      await __resetLogStore();
      const created = await createReception(baseInput);
      if (!created.ok) return;
      await startCall(created.value.id, callingAdapter);
      await recordStaffResponse(created.value.id, 'decline');
      const logs = (await listAuditLogs()).filter(
        (a) => a.action === 'reception.staff_responded' && a.targetId === created.value.id,
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]!.actor).toBe('staff');
      expect(logs[0]!.metadata).toEqual({ action: 'decline' });
      // 監査に来訪者文言・氏名等の PII を含めない。
      expect(JSON.stringify(logs[0]!.metadata)).not.toMatch(/来客|ACME/);
    });

    it('confirming など calling/connected 以外からは記録できない', async () => {
      const created = await createReception(baseInput); // confirming のまま
      if (!created.ok) return;
      const r = await recordStaffResponse(created.value.id, 'coming');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_transition');
    });

    it('存在しない受付は not_found', async () => {
      const r = await recordStaffResponse('missing', 'coming');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('not_found');
    });

    it('getReceptionVisitorStatus は PII を返さず state と staffResponse のみ返す', async () => {
      const created = await createReception(baseInput);
      if (!created.ok) return;
      await startCall(created.value.id, callingAdapter);
      await recordStaffResponse(created.value.id, 'wait');
      const r = await getReceptionVisitorStatus(created.value.id);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(Object.keys(r.value).sort()).toEqual(['staffResponse', 'state']);
        expect(r.value.staffResponse?.action).toBe('wait');
        expect(JSON.stringify(r.value)).not.toMatch(/来客|ACME/);
      }
    });
  });
});
