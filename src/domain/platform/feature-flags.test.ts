/**
 * テナント別機能フラグの純ロジックのテスト (issue #83 inc5a)。
 * 入力検証（未知キー・非 boolean の拒否）、既定値の解決、変更適用と監査用 before/after の導出を検証する。
 */
import { describe, expect, it } from 'vitest';
import {
  TENANT_FEATURE_FLAG_KEYS,
  DEFAULT_TENANT_FEATURE_FLAGS,
  effectiveTenantFeatureFlags,
  parseFeatureFlagChanges,
  applyFeatureFlagChanges,
  type TenantFeatureFlagRecord,
} from './feature-flags';

describe('parseFeatureFlagChanges (#83 inc5a)', () => {
  it('既知キー + boolean 値のみ受理する', () => {
    const r = parseFeatureFlagChanges({ voiceSynthesis: false });
    expect(r).toEqual({ ok: true, changes: { voiceSynthesis: false } });
  });

  it('複数キーの同時変更を受理する', () => {
    const r = parseFeatureFlagChanges({ voiceSynthesis: false, avatarReception: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changes).toEqual({ voiceSynthesis: false, avatarReception: true });
  });

  it('オブジェクト以外は拒否する', () => {
    expect(parseFeatureFlagChanges(undefined).ok).toBe(false);
    expect(parseFeatureFlagChanges(null).ok).toBe(false);
    expect(parseFeatureFlagChanges('voiceSynthesis').ok).toBe(false);
    expect(parseFeatureFlagChanges([true]).ok).toBe(false);
  });

  it('未知キーは拒否する（typo で意図しないフラグを作らない）', () => {
    const r = parseFeatureFlagChanges({ voiceSynthesys: false });
    expect(r.ok).toBe(false);
  });

  it('boolean 以外の値は拒否する', () => {
    expect(parseFeatureFlagChanges({ voiceSynthesis: 'false' }).ok).toBe(false);
    expect(parseFeatureFlagChanges({ voiceSynthesis: 0 }).ok).toBe(false);
  });

  it('空オブジェクトは拒否する（変更なしのリクエストを弾く）', () => {
    expect(parseFeatureFlagChanges({}).ok).toBe(false);
  });
});

describe('effectiveTenantFeatureFlags', () => {
  it('レコード未作成のテナントは既定値（全機能有効）', () => {
    expect(effectiveTenantFeatureFlags(undefined)).toEqual(DEFAULT_TENANT_FEATURE_FLAGS);
    for (const key of TENANT_FEATURE_FLAG_KEYS) {
      expect(effectiveTenantFeatureFlags(undefined)[key]).toBe(true);
    }
  });

  it('保存済みの値が既定値を上書きする（欠落キーは既定値のまま）', () => {
    const record: TenantFeatureFlagRecord = {
      id: 'internal',
      flags: { voiceSynthesis: false },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(effectiveTenantFeatureFlags(record)).toEqual({
      ...DEFAULT_TENANT_FEATURE_FLAGS,
      voiceSynthesis: false,
    });
  });
});

describe('applyFeatureFlagChanges', () => {
  const now = new Date('2026-07-02T00:00:00.000Z');

  it('レコード未作成のテナントに変更を適用し、監査用 before/after は変更キーのみ持つ', () => {
    const r = applyFeatureFlagChanges(undefined, { voiceSynthesis: false }, {
      tenantId: 'internal',
      now,
      operator: 'dev@example.com',
    });
    expect(r.changedKeys).toEqual(['voiceSynthesis']);
    expect(r.next.id).toBe('internal');
    expect(r.next.flags.voiceSynthesis).toBe(false);
    expect(r.next.updatedAt).toBe(now.toISOString());
    expect(r.next.updatedBy).toBe('dev@example.com');
    // 監査ログの before/after は Record<string,string>（機微値なし・変更キーのみ）。
    expect(r.before).toEqual({ voiceSynthesis: 'true' });
    expect(r.after).toEqual({ voiceSynthesis: 'false' });
  });

  it('現在値と同じ値の変更は changedKeys に含めない（no-op 検出）', () => {
    const r = applyFeatureFlagChanges(undefined, { voiceSynthesis: true }, {
      tenantId: 'internal',
      now,
      operator: 'dev@example.com',
    });
    expect(r.changedKeys).toEqual([]);
    expect(r.before).toEqual({});
    expect(r.after).toEqual({});
  });

  it('既存レコードへの変更は他のキーを保持する', () => {
    const current: TenantFeatureFlagRecord = {
      id: 'internal',
      flags: { voiceSynthesis: false },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const r = applyFeatureFlagChanges(current, { avatarReception: false }, {
      tenantId: 'internal',
      now,
      operator: 'dev@example.com',
    });
    expect(r.changedKeys).toEqual(['avatarReception']);
    expect(r.next.flags).toEqual({ voiceSynthesis: false, avatarReception: false });
    expect(r.before).toEqual({ avatarReception: 'true' });
    expect(r.after).toEqual({ avatarReception: 'false' });
  });
});
