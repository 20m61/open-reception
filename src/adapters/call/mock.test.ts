import { describe, expect, it } from 'vitest';
import { MockCallAdapter } from './mock';
import { MOCK_STAFF } from '@/domain/staff/mock-data';

const adapter = new MockCallAdapter(MOCK_STAFF);

describe('MockCallAdapter', () => {
  it('success の担当者は connected を返す', async () => {
    const r = await adapter.call({ receptionId: 'r1', targetType: 'staff', targetId: 'staff-sato' });
    expect(r.status).toBe('connected');
  });

  it('no_answer の担当者は timeout を返す', async () => {
    const r = await adapter.call({ receptionId: 'r1', targetType: 'staff', targetId: 'staff-suzuki' });
    expect(r.status).toBe('timeout');
    expect(r.reason).toBe('no_answer');
  });

  it('failure の担当者は failed を返す', async () => {
    const r = await adapter.call({ receptionId: 'r1', targetType: 'staff', targetId: 'staff-takahashi' });
    expect(r.status).toBe('failed');
  });

  it('timeout の担当者は timeout を返す', async () => {
    const r = await adapter.call({ receptionId: 'r1', targetType: 'staff', targetId: 'staff-tanaka' });
    expect(r.status).toBe('timeout');
  });

  it('存在しない担当者は failed を返す', async () => {
    const r = await adapter.call({ receptionId: 'r1', targetType: 'staff', targetId: 'nope' });
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('target_not_found');
  });

  it('部署呼び出しは connected を返す', async () => {
    const r = await adapter.call({ receptionId: 'r1', targetType: 'department', targetId: 'dept-sales' });
    expect(r.status).toBe('connected');
  });
});
