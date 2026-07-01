import { describe, expect, it, vi, beforeEach } from 'vitest';

const appendAuditLog = vi.fn();
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAuditLog: (...a: unknown[]) => appendAuditLog(...a),
}));

// mock 設定後に被テストモジュールを読み込む（vi.mock は巻き上げられるが順序を明示）。
import { auditContextFromRequest, recordDangerAction, sanitizeAuditMetadata } from './audit';

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/platform/tenants/t1', { method: 'PATCH', headers });
}

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

describe('auditContextFromRequest (#83 AC13 高詳細監査)', () => {
  it('x-forwarded-for 末尾（信頼 proxy が付与した値）を IP に、user-agent を取り出す', () => {
    // 先頭は client 詐称可能。CloudFront が右側に追記する末尾の実 client IP を採る。
    expect(
      auditContextFromRequest(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'user-agent': 'UA/1.0' })),
    ).toEqual({ ip: '5.6.7.8', userAgent: 'UA/1.0' });
  });

  it('ヘッダ欠如は undefined', () => {
    expect(auditContextFromRequest(req({}))).toEqual({ ip: undefined, userAgent: undefined });
  });

  it('user-agent は 256 文字で切り詰める', () => {
    const long = 'x'.repeat(400);
    expect(auditContextFromRequest(req({ 'user-agent': long })).userAgent).toHaveLength(256);
  });
});

describe('recordDangerAction 高詳細監査 (#83 AC13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appendAuditLog.mockResolvedValue({ id: 'a1' });
  });

  it('before/after を sanitize し、IP/user-agent・actor を付与して記録する', async () => {
    await recordDangerAction({
      action: 'tenant.suspended',
      target: { type: 'tenant', id: 't1' },
      reason: '調査のため',
      before: { status: 'active', secret: 'x' },
      after: { status: 'suspended' },
      actor: 'platform:dev@example.com',
      request: req({ 'x-forwarded-for': '9.9.9.9', 'user-agent': 'UA' }),
    });
    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const [entry] = appendAuditLog.mock.calls[0]!;
    expect(entry).toEqual({
      action: 'tenant.suspended',
      actor: 'platform:dev@example.com', // #264: 操作者を帰属。
      targetType: 'tenant',
      targetId: 't1',
      metadata: { reason: '調査のため' },
      before: { status: 'active', secret: '[redacted]' }, // 機微キーは落とす
      after: { status: 'suspended' },
      ip: '9.9.9.9',
      userAgent: 'UA',
    });
  });

  it('actor 未指定は admin・request 未指定なら IP/user-agent は undefined', async () => {
    await recordDangerAction({ action: 'tenant.activated', target: { type: 'tenant', id: 't1' } });
    const [entry] = appendAuditLog.mock.calls[0]!;
    expect(entry.actor).toBe('admin');
    expect(entry.ip).toBeUndefined();
    expect(entry.userAgent).toBeUndefined();
  });
});
