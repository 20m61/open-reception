import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetStore,
  cancelReception,
  completeReception,
  createReception,
  getReception,
  startCall,
} from './reception-store';

const baseInput = {
  kioskId: 'kiosk-1',
  purpose: 'meeting',
  targetType: 'staff' as const,
  targetId: 'staff-sato',
  targetLabel: '佐藤 太郎',
  visitor: { name: '来客 一郎', company: 'ACME' },
};

beforeEach(() => {
  __resetStore();
});

describe('reception-store', () => {
  it('有効な入力で受付セッションを作成できる', () => {
    const r = createReception(baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe('confirming');
      expect(r.value.visitor?.name).toBe('来客 一郎');
    }
  });

  it('不正な入力を拒否する', () => {
    const r = createReception({ ...baseInput, visitor: { name: '' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });

  it('purpose が不正なら拒否する', () => {
    const r = createReception({ ...baseInput, purpose: 'unknown' });
    expect(r.ok).toBe(false);
  });

  it('成功する担当者への呼び出しは connected になる', async () => {
    const created = createReception(baseInput);
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
    const created = createReception({ ...baseInput, targetId: 'staff-suzuki', targetLabel: '鈴木 花子' });
    if (!created.ok) return;
    const r = await startCall(created.value.id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe('timeout');
      expect(r.value.completedAt).toBeDefined();
    }
  });

  it('失敗する担当者への呼び出しは failed になる', async () => {
    const created = createReception({ ...baseInput, targetId: 'staff-takahashi', targetLabel: '高橋 健' });
    if (!created.ok) return;
    const r = await startCall(created.value.id);
    expect(r.ok && r.value.state).toBe('failed');
  });

  it('接続後に完了できる', async () => {
    const created = createReception(baseInput);
    if (!created.ok) return;
    await startCall(created.value.id);
    const r = completeReception(created.value.id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe('completed');
      expect(r.value.completedAt).toBeDefined();
    }
  });

  it('confirming からキャンセルできる', () => {
    const created = createReception(baseInput);
    if (!created.ok) return;
    const r = cancelReception(created.value.id);
    expect(r.ok && r.value.state).toBe('cancelled');
  });

  it('不正な状態遷移を拒否する（呼び出し前の complete）', () => {
    const created = createReception(baseInput);
    if (!created.ok) return;
    const r = completeReception(created.value.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_transition');
  });

  it('存在しないセッションは not_found', () => {
    const r = getReception('missing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });
});
