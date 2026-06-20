import { describe, expect, it } from 'vitest';
import { sanitizeAuditMetadata } from './audit';

describe('sanitizeAuditMetadata (#91 監査連携・機微値非保存)', () => {
  it('undefined はそのまま undefined', () => {
    expect(sanitizeAuditMetadata(undefined)).toBeUndefined();
  });

  it('null / undefined エントリは捨てる', () => {
    expect(sanitizeAuditMetadata({ a: null, b: undefined, c: 'ok' })).toEqual({ c: 'ok' });
  });

  it('boolean / number は文字列化', () => {
    expect(sanitizeAuditMetadata({ flag: true, count: 3 })).toEqual({ flag: 'true', count: '3' });
  });

  it('機微キーは値を redacted に置換（キー存在は残す）', () => {
    const out = sanitizeAuditMetadata({
      secret: 'abc',
      apiKey: 'xyz',
      pin: '1234',
      token: 't',
      visitorName: '山田',
      email: 'a@b.c',
      reason: '停止理由',
    });
    expect(out).toEqual({
      secret: '[redacted]',
      apiKey: '[redacted]',
      pin: '[redacted]',
      token: '[redacted]',
      visitorName: '[redacted]', // name 部分一致
      email: '[redacted]',
      reason: '停止理由',
    });
  });

  it('object / array は捨てる（構造体の混入防止）', () => {
    expect(sanitizeAuditMetadata({ nested: { a: 1 }, list: [1, 2], ok: 'v' })).toEqual({ ok: 'v' });
  });

  it('結果が空なら undefined', () => {
    expect(sanitizeAuditMetadata({ a: null })).toBeUndefined();
  });
});
