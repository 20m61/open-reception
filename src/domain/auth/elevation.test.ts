/**
 * JIT 権限昇格の純ドメインの単体テスト (issue #83 inc4 / #91)。
 */
import { describe, expect, it } from 'vitest';
import {
  elevationAuditMetadata,
  elevationCoversScope,
  grantElevation,
  grantBreakGlass,
  isElevated,
  requireElevation,
  elevationJtiStatus,
  elevatedWriteAuditMetadata,
  isBreakGlassAudit,
  ELEVATION_MIN_TTL_MS,
  ELEVATION_MAX_TTL_MS,
  ELEVATION_DEFAULT_TTL_MS,
  BREAK_GLASS_TTL_MS,
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

describe('grantBreakGlass (#83 §3 break-glass)', () => {
  it('breakGlass:true・固定短窓（15 分）で付与する', () => {
    const e = grantBreakGlass({ reason: '本番障害の緊急対応', scope: {} }, NOW);
    expect(e.breakGlass).toBe(true);
    expect(e.until).toBe(NOW + BREAK_GLASS_TTL_MS);
    expect(BREAK_GLASS_TTL_MS).toBeLessThan(ELEVATION_DEFAULT_TTL_MS);
  });

  it('reason 必須（空白のみは throw）', () => {
    expect(() => grantBreakGlass({ reason: '   ', scope: {} }, NOW)).toThrow();
  });

  it('通常昇格（grantElevation）は breakGlass を持たない（後方互換）', () => {
    const e = grantElevation({ reason: 'r', scope: {} }, NOW);
    expect(e.breakGlass).toBeUndefined();
  });

  it('break-glass 昇格も requireElevation の同じ強制（期限・スコープ）を受ける', () => {
    const e = grantBreakGlass({ reason: 'r', scope: {} }, NOW);
    expect(requireElevation(e, { tenantId: 't1' }, NOW)).toEqual({ ok: true });
    expect(requireElevation(e, {}, NOW + BREAK_GLASS_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('elevationAuditMetadata + break-glass 高重要度 (#83 §3)', () => {
  it('break-glass 昇格は breakGlass/severity を監査 metadata に載せる', () => {
    const meta = elevationAuditMetadata(grantBreakGlass({ reason: '緊急', scope: {} }, NOW));
    expect(meta.breakGlass).toBe('true');
    expect(meta.severity).toBe('high');
  });

  it('通常昇格の監査 metadata には breakGlass/severity を載せない（既存互換）', () => {
    const meta = elevationAuditMetadata(grantElevation({ reason: 'r', scope: {} }, NOW));
    expect('breakGlass' in meta).toBe(false);
    expect('severity' in meta).toBe(false);
  });
});

describe('elevatedWriteAuditMetadata (#83 §3 全 write の高重要度マーク)', () => {
  it('break-glass 中の write は breakGlass/severity マークを返す', () => {
    const e = grantBreakGlass({ reason: 'r', scope: {} }, NOW);
    expect(elevatedWriteAuditMetadata(e)).toEqual({ breakGlass: 'true', severity: 'high' });
  });
  it('通常昇格中の write は空（既存の監査表現を変えない）', () => {
    const e = grantElevation({ reason: 'r', scope: {} }, NOW);
    expect(elevatedWriteAuditMetadata(e)).toEqual({});
  });
});

describe('isBreakGlassAudit (#83 §3 利用後レビュー抽出)', () => {
  it('privilege.break_glass アクションはレビュー対象', () => {
    expect(isBreakGlassAudit({ action: 'privilege.break_glass' })).toBe(true);
  });
  it('metadata.breakGlass=true の write もレビュー対象', () => {
    expect(isBreakGlassAudit({ action: 'platform.notice.published', metadata: { breakGlass: 'true' } })).toBe(true);
  });
  it('通常操作はレビュー対象外', () => {
    expect(isBreakGlassAudit({ action: 'privilege.elevated' })).toBe(false);
    expect(isBreakGlassAudit({ action: 'platform.notice.published', metadata: { reason: 'x' } })).toBe(false);
  });
});
