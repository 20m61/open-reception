import { describe, expect, it } from 'vitest';
import {
  applyConnectionResult,
  composeSecretStatus,
  deriveSecretPresence,
  isSecretKey,
  type SecretStatus,
} from './integration-status';

describe('integration-status domain (#93)', () => {
  describe('deriveSecretPresence', () => {
    it('値があれば configured、空/空白/未定義は missing', () => {
      expect(deriveSecretPresence('abc')).toBe('configured');
      expect(deriveSecretPresence('')).toBe('missing');
      expect(deriveSecretPresence('   ')).toBe('missing');
      expect(deriveSecretPresence(undefined)).toBe('missing');
      expect(deriveSecretPresence(null)).toBe('missing');
    });

    it('戻り値は bool 相当の状態のみで、入力値を含まない（平文非露出）', () => {
      const secret = 'super-secret-key-value';
      const result = deriveSecretPresence(secret);
      expect(result).toBe('configured');
      expect(JSON.stringify(result)).not.toContain(secret);
    });
  });

  describe('composeSecretStatus', () => {
    it('env presence を正とし、record の更新メタを合成する', () => {
      const status = composeSecretStatus('VONAGE_API_SECRET', 'configured', {
        presence: 'missing',
        health: 'ok',
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'tenant_admin',
      });
      expect(status.presence).toBe('configured'); // env を優先
      expect(status.updatedBy).toBe('tenant_admin');
      // 状態オブジェクトに value プロパティが存在しないことを型と実体で担保。
      expect(Object.keys(status)).not.toContain('value');
    });

    it('record 無しなら health unknown / 更新メタ無し', () => {
      const status = composeSecretStatus('WEBHOOK_SECRET', 'missing');
      expect(status).toEqual<SecretStatus>({
        key: 'WEBHOOK_SECRET',
        presence: 'missing',
        health: 'unknown',
        updatedAt: undefined,
        updatedBy: undefined,
      });
    });
  });

  describe('applyConnectionResult', () => {
    it('成功で lastSuccessAt を更新し errorSummary をクリア', () => {
      const next = applyConnectionResult(
        { lastResult: 'failure', lastFailureAt: 'x', lastErrorSummary: 'boom' },
        'success',
        '2026-06-20T00:00:00.000Z',
      );
      expect(next.lastResult).toBe('success');
      expect(next.lastSuccessAt).toBe('2026-06-20T00:00:00.000Z');
      expect(next.lastErrorSummary).toBeUndefined();
    });

    it('失敗で lastFailureAt と要約を記録し、長文は 280 字に丸める', () => {
      const long = 'e'.repeat(400);
      const next = applyConnectionResult(undefined, 'failure', '2026-06-20T00:00:00.000Z', long);
      expect(next.lastResult).toBe('failure');
      expect(next.lastFailureAt).toBe('2026-06-20T00:00:00.000Z');
      expect(next.lastErrorSummary?.length).toBe(280);
    });
  });

  describe('isSecretKey', () => {
    it('既知のキーのみ true', () => {
      expect(isSecretKey('VONAGE_API_SECRET')).toBe(true);
      expect(isSecretKey('UNKNOWN')).toBe(false);
      expect(isSecretKey(123)).toBe(false);
    });
  });
});
