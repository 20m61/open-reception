/**
 * 受付端末の応答ポーリング反映ロジックの単体テスト (issue #99)。
 * フック本体は DOM 依存のため、純関数 shouldReplaceResponse のみを検証する。
 */
import { describe, expect, it } from 'vitest';
import { shouldReplaceResponse } from './useStaffResponse';
import type { StaffResponseResult } from '@/domain/reception/staff-response';

function result(action: StaffResponseResult['action'], respondedAt: string): StaffResponseResult {
  return {
    action,
    kioskStatus: 'acknowledged',
    visitorMessage: 'x',
    severity: 'success',
    offersFallback: false,
    respondedAt,
  };
}

describe('shouldReplaceResponse', () => {
  it('応答がなければ置き換えない', () => {
    expect(shouldReplaceResponse(null, undefined)).toBe(false);
    expect(shouldReplaceResponse(result('coming', '2026-06-20T00:00:00.000Z'), undefined)).toBe(false);
  });

  it('初回の応答は採用する', () => {
    expect(shouldReplaceResponse(null, result('coming', '2026-06-20T00:00:00.000Z'))).toBe(true);
  });

  it('より新しい応答のみ採用する', () => {
    const current = result('wait', '2026-06-20T00:00:00.000Z');
    expect(shouldReplaceResponse(current, result('coming', '2026-06-20T00:01:00.000Z'))).toBe(true);
  });

  it('同じ／古い応答は無視する（再取得・巻き戻りを防ぐ）', () => {
    const current = result('coming', '2026-06-20T00:01:00.000Z');
    expect(shouldReplaceResponse(current, result('coming', '2026-06-20T00:01:00.000Z'))).toBe(false);
    expect(shouldReplaceResponse(current, result('wait', '2026-06-20T00:00:00.000Z'))).toBe(false);
  });
});
