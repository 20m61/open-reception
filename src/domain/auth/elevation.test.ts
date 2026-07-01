/**
 * JIT 権限昇格の純ドメインの単体テスト (issue #83 inc4 / #91)。
 */
import { describe, expect, it } from 'vitest';
import {
  elevationAuditMetadata,
  elevationCoversScope,
  grantElevation,
  isElevated,
  requireElevation,
  elevationJtiStatus,
  ELEVATION_MIN_TTL_MS,
  ELEVATION_MAX_TTL_MS,
  ELEVATION_DEFAULT_TTL_MS,
  type Elevation,
  type ElevationJtiRecord,
} from './elevation';

const NOW = 1_000_000_000_000;

describe('grantElevation', () => {
  it('reason 必須・until は now+ttl（既定 30分）', () => {
    const e = grantElevation({ reason: '機能フラグ調整', scope: { tenantId: 'acme' } }, NOW);
    expect(e.until).toBe(NOW + ELEVATION_DEFAULT_TTL_MS);
    expect(e.reason).toBe('機能フラグ調整');
    expect(e.scope).toEqual({ tenantId: 'acme', siteId: undefined, deviceId: undefined });
  });
  it('空白 reason は拒否', () => {
    expect(() => grantElevation({ reason: '   ', scope: {} }, NOW)).toThrow();
  });
  it('ttl は [MIN, MAX] にクランプ', () => {
    expect(grantElevation({ reason: 'r', scope: {}, ttlMs: 1 }, NOW).until).toBe(NOW + ELEVATION_MIN_TTL_MS);
    expect(grantElevation({ reason: 'r', scope: {}, ttlMs: 10 * 60 * 60 * 1000 }, NOW).until).toBe(
      NOW + ELEVATION_MAX_TTL_MS,
    );
  });
});

describe('isElevated', () => {
  const e: Elevation = { until: NOW + 1000, reason: 'r', scope: {} };
  it('期限内は true / 期限切れ・null は false', () => {
    expect(isElevated(e, NOW)).toBe(true);
    expect(isElevated(e, NOW + 2000)).toBe(false);
    expect(isElevated(null, NOW)).toBe(false);
  });
});

describe('elevationCoversScope', () => {
  it('platform 全体昇格 {} は全対象を覆う', () => {
    expect(elevationCoversScope({}, { tenantId: 'x', siteId: 's' })).toBe(true);
  });
  it('tenant 昇格は当該テナントのサイト/端末も覆う', () => {
    expect(elevationCoversScope({ tenantId: 'x' }, { tenantId: 'x', siteId: 's' })).toBe(true);
    expect(elevationCoversScope({ tenantId: 'x' }, { tenantId: 'y' })).toBe(false);
  });
  it('tenant 昇格は platform スコープ操作（tenantId 無し）を覆わない', () => {
    expect(elevationCoversScope({ tenantId: 'x' }, {})).toBe(false);
  });
});

describe('requireElevation', () => {
  const e: Elevation = { until: NOW + 1000, reason: 'r', scope: { tenantId: 'x' } };
  it('未昇格 / 失効 / 対象外 を区別する', () => {
    expect(requireElevation(null, { tenantId: 'x' }, NOW)).toEqual({ ok: false, reason: 'not_elevated' });
    expect(requireElevation(e, { tenantId: 'x' }, NOW + 2000)).toEqual({ ok: false, reason: 'expired' });
    expect(requireElevation(e, { tenantId: 'y' }, NOW)).toEqual({ ok: false, reason: 'out_of_scope' });
  });
  it('有効かつ対象内は ok', () => {
    expect(requireElevation(e, { tenantId: 'x', siteId: 's' }, NOW)).toEqual({ ok: true });
  });
});

describe('elevationAuditMetadata', () => {
  it('reason・until・設定済スコープのみを残す（機微値なし）', () => {
    const meta = elevationAuditMetadata({
      until: NOW + ELEVATION_MIN_TTL_MS,
      reason: '調査のため',
      scope: { tenantId: 'acme' },
    });
    expect(meta.reason).toBe('調査のため');
    expect(meta.tenantId).toBe('acme');
    expect('siteId' in meta).toBe(false);
    expect(meta.until).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('elevationJtiStatus (#264 jti 失効ストアの純判定)', () => {
  const record: ElevationJtiRecord = { id: 'jti-1', sub: 'dev@example.com', expiresAt: NOW + 1000 };

  it('記録なし（undefined/null）は unknown ＝ fail-closed で無効扱い', () => {
    expect(elevationJtiStatus(undefined, NOW)).toBe('unknown');
    expect(elevationJtiStatus(null, NOW)).toBe('unknown');
  });

  it('記録あり・未失効・期限内は active', () => {
    expect(elevationJtiStatus(record, NOW)).toBe('active');
  });

  it('revokedAt が設定済みなら revoked（期限内でも無効）', () => {
    expect(elevationJtiStatus({ ...record, revokedAt: NOW - 1 }, NOW)).toBe('revoked');
  });

  it('期限切れ（expiresAt <= now）は expired', () => {
    expect(elevationJtiStatus({ ...record, expiresAt: NOW }, NOW)).toBe('expired');
    expect(elevationJtiStatus({ ...record, expiresAt: NOW - 1 }, NOW)).toBe('expired');
  });

  it('revoked は expired より優先（失効操作の事実を保つ）', () => {
    expect(elevationJtiStatus({ ...record, expiresAt: NOW - 1, revokedAt: NOW - 2 }, NOW)).toBe('revoked');
  });
});
