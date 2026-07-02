/**
 * read 系監査の記録判定（純関数）のテスト (issue #83 §5 / inc5b)。
 *
 * 監査ログ閲覧の監査（platform.audit_log.viewed）は、それ自体が監査ログに増えるため、
 * 同一 actor の窓内連続閲覧を 1 回に絞る（自己増殖ループ・一覧の押し流し防止）。
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_VIEW_WINDOW_MS, shouldRecordAuditView } from './read-audit';

const NOW = Date.parse('2026-07-02T12:00:00.000Z');
const ACTOR = 'platform:dev@example.com';

function viewLog(at: string, actor = ACTOR) {
  return { action: 'platform.audit_log.viewed' as const, actor, at };
}

describe('shouldRecordAuditView (#83 §5 閲覧監査のループ回避)', () => {
  it('閲覧記録が無ければ記録する', () => {
    expect(shouldRecordAuditView([], ACTOR, NOW)).toBe(true);
  });

  it('同一 actor が窓内に閲覧済みなら記録しない', () => {
    const logs = [viewLog('2026-07-02T11:50:00.000Z')]; // 10 分前 < 15 分窓
    expect(shouldRecordAuditView(logs, ACTOR, NOW)).toBe(false);
  });

  it('窓より古い閲覧記録しか無ければ再び記録する', () => {
    const logs = [viewLog('2026-07-02T11:40:00.000Z')]; // 20 分前 > 15 分窓
    expect(shouldRecordAuditView(logs, ACTOR, NOW)).toBe(true);
  });

  it('別 actor の閲覧記録では抑制しない（actor ごとに 1 回）', () => {
    const logs = [viewLog('2026-07-02T11:59:00.000Z', 'platform:other@example.com')];
    expect(shouldRecordAuditView(logs, ACTOR, NOW)).toBe(true);
  });

  it('閲覧以外の action は判定に影響しない', () => {
    const logs = [{ action: 'privilege.elevated' as const, actor: ACTOR, at: '2026-07-02T11:59:00.000Z' }];
    expect(shouldRecordAuditView(logs, ACTOR, NOW)).toBe(true);
  });

  it('at が不正な閲覧記録は無視して記録する（欠損データで監査が止まらない）', () => {
    const logs = [viewLog('not-a-date')];
    expect(shouldRecordAuditView(logs, ACTOR, NOW)).toBe(true);
  });

  it('未来時刻（クロックスキュー）の閲覧記録は「直近閲覧あり」として抑制する', () => {
    const logs = [viewLog('2026-07-02T12:01:00.000Z')];
    expect(shouldRecordAuditView(logs, ACTOR, NOW)).toBe(false);
  });

  it('窓はカスタムでき、境界ちょうど（age === window）は記録する', () => {
    const logs = [viewLog('2026-07-02T11:59:00.000Z')]; // 60_000ms 前
    expect(shouldRecordAuditView(logs, ACTOR, NOW, 60_000)).toBe(true);
    expect(shouldRecordAuditView(logs, ACTOR, NOW, 60_001)).toBe(false);
  });

  it('既定窓は 15 分', () => {
    expect(AUDIT_VIEW_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});
