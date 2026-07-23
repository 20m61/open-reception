import { describe, expect, it } from 'vitest';
import { checkVonageConnection, runConnectionTest } from './connection-test';

/**
 * 接続テスト（設定検証）の単体テスト (issue #93 / #405 Inc3)。
 * テナント設定 presence（configured/enabled の状態のみ）から判定し、secret 値・名を出さない。
 */
describe('connection-test (#93 × #405)', () => {
  it('configured かつ enabled なら success（実発信はしない）', () => {
    const outcome = checkVonageConnection({ configured: true, enabled: true });
    expect(outcome.result).toBe('success');
  });

  it('未設定（configured=false）なら failure。要約に secret 値・名を含めない', () => {
    const outcome = checkVonageConnection({ configured: false, enabled: false });
    expect(outcome.result).toBe('failure');
    expect(outcome.summary).not.toMatch(/VONAGE_/);
    expect(outcome.summary).not.toMatch(/secret|private|key/i);
  });

  it('設定済みだが無効化（enabled=false）なら failure', () => {
    const outcome = checkVonageConnection({ configured: true, enabled: false });
    expect(outcome.result).toBe('failure');
    expect(outcome.summary).not.toMatch(/VONAGE_/);
  });

  it('runConnectionTest は vonage を presence で判定し、未知連携は failure', () => {
    expect(runConnectionTest('vonage', { configured: true, enabled: true }).result).toBe('success');
    expect(runConnectionTest('bogus', { configured: true, enabled: true }).result).toBe('failure');
  });
});
