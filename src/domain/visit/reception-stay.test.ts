import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import type { ReceptionSession } from '@/domain/reception/session';
import { receptionToCreateStayInput, shouldCreateStayForReception } from './reception-stay';

const T = asTenantId('dev-tenant');
const S = asSiteId('dev-site');
const SCOPE = { tenantId: T, siteId: S };

function session(over: Partial<ReceptionSession> = {}): ReceptionSession {
  return {
    id: 'rec-1',
    kioskId: 'kiosk-dev',
    state: 'completed',
    callOutcome: 'connected',
    purpose: 'meeting',
    targetType: 'staff',
    targetId: 'staff-1',
    targetLabel: '営業部 佐藤',
    visitor: { name: '山田太郎', company: 'ACME', note: '秘密メモ' },
    startedAt: '2026-07-12T09:00:00.000Z',
    updatedAt: '2026-07-12T09:05:00.000Z',
    completedAt: '2026-07-12T09:05:00.000Z',
    ...over,
  };
}

describe('shouldCreateStayForReception (issue #342)', () => {
  it('connected で完了した受付のみ在館記録を作る', () => {
    expect(shouldCreateStayForReception(session())).toBe(true);
  });

  it('未応答/失敗/取消/フォールバック完了では作らない（誤った在館を生まない）', () => {
    expect(shouldCreateStayForReception(session({ state: 'timeout', callOutcome: 'timeout' }))).toBe(false);
    expect(shouldCreateStayForReception(session({ state: 'failed', callOutcome: 'failed' }))).toBe(false);
    expect(shouldCreateStayForReception(session({ state: 'cancelled', callOutcome: 'cancelled' }))).toBe(false);
    // fallback → completed（担当者は応答していない）。callOutcome が connected でない完了は作らない。
    expect(shouldCreateStayForReception(session({ state: 'completed', callOutcome: 'timeout' }))).toBe(false);
    // 完了前（connected のまま COMPLETE していない）は作らない。
    expect(shouldCreateStayForReception(session({ state: 'connected', callOutcome: 'connected' }))).toBe(false);
    // callOutcome 未設定も作らない。
    expect(shouldCreateStayForReception(session({ state: 'completed', callOutcome: undefined }))).toBe(false);
  });
});

describe('receptionToCreateStayInput (issue #342)', () => {
  it('scope と非 PII 参照のみを写す（氏名/会社/メモは載せない）', () => {
    const input = receptionToCreateStayInput(session(), SCOPE);
    expect(input).toEqual({
      tenantId: T,
      siteId: S,
      checkedInAt: '2026-07-12T09:05:00.000Z',
      receptionId: 'rec-1',
      targetLabel: '営業部 佐藤',
      purpose: 'meeting',
    });
  });

  it('PII（visitor の氏名/会社/メモ）を作成入力へ持ち込まない', () => {
    const input = receptionToCreateStayInput(session(), SCOPE);
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain('山田太郎');
    expect(serialized).not.toContain('ACME');
    expect(serialized).not.toContain('秘密メモ');
    expect(input).not.toHaveProperty('visitor');
  });

  it('scope はクライアント入力ではなく呼び出し側の解決値を使う（越境しない）', () => {
    // 受付が別サイトを騙っても、写像は渡された scope（kiosk セッション由来）を使う。
    const input = receptionToCreateStayInput(session(), { tenantId: T, siteId: asSiteId('other-site') });
    expect(input.siteId).toBe('other-site');
    expect(input.tenantId).toBe(T);
  });

  it('completedAt 未確定なら checkedInAt は undefined（呼び出し側 now に委ねる）', () => {
    const input = receptionToCreateStayInput(session({ completedAt: undefined }), SCOPE);
    expect(input.checkedInAt).toBeUndefined();
  });
});
