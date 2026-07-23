import { describe, expect, it } from 'vitest';
import {
  generateReservationToken,
  hashReservationToken,
  reservationTokenHashesEqual,
  RESERVATION_TOKEN_HASH_HEX_LEN,
} from './token';
import { migrateReservationToHashed } from './migration';
import { asReservationId, asReservationToken, type LegacyVisitReservation } from './types';
import { asSiteId, asTenantId } from '@/domain/tenant/types';

describe('hashReservationToken (#375)', () => {
  it('SHA-256 の 16 進 64 文字を返し、決定的である', () => {
    const token = asReservationToken('token-abc');
    const h1 = hashReservationToken(token);
    const h2 = hashReservationToken(token);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(RESERVATION_TOKEN_HASH_HEX_LEN);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('生 token を復元できない（hash は入力そのものを含まない）', () => {
    const token = asReservationToken('super-secret-token-value');
    const hash = hashReservationToken(token);
    expect(hash).not.toContain('super-secret');
    expect(hash).not.toBe(token as unknown as string);
  });

  it('異なる token は異なる hash になる', () => {
    const a = hashReservationToken(generateReservationToken());
    const b = hashReservationToken(generateReservationToken());
    expect(a).not.toBe(b);
  });

  it('pepper（server secret）を混ぜると hash が変わる', () => {
    const token = asReservationToken('token-abc');
    const noPepper = hashReservationToken(token);
    const peppered = hashReservationToken(token, 'server-pepper');
    expect(peppered).not.toBe(noPepper);
    // 同一 pepper なら決定的。
    expect(hashReservationToken(token, 'server-pepper')).toBe(peppered);
  });
});

describe('reservationTokenHashesEqual (timing-safe, #375)', () => {
  it('同一 hash は true、改竄 hash は false', () => {
    const token = asReservationToken('token-abc');
    const hash = hashReservationToken(token);
    expect(reservationTokenHashesEqual(hash, hashReservationToken(token))).toBe(true);
    expect(reservationTokenHashesEqual(hash, hashReservationToken(asReservationToken('other')))).toBe(
      false,
    );
  });

  it('長さの異なる/不正な入力でも例外を投げず false', () => {
    const hash = hashReservationToken(asReservationToken('token-abc'));
    expect(reservationTokenHashesEqual(hash, 'deadbeef')).toBe(false);
    expect(reservationTokenHashesEqual(hash, '')).toBe(false);
  });
});

describe('migrateReservationToHashed (現行QRデータ移行, #375)', () => {
  function legacy(over: Partial<LegacyVisitReservation> = {}): LegacyVisitReservation {
    return {
      id: asReservationId('rsv-legacy'),
      tenantId: asTenantId('tenant-a'),
      siteId: asSiteId('site-1'),
      visitorName: '山田太郎',
      visitAt: '2026-06-20T01:00:00.000Z',
      targetType: 'staff',
      targetId: 'staff-1',
      token: asReservationToken('legacy-plain-token'),
      usagePolicy: 'single_use',
      expiresAt: '2026-06-27T00:00:00.000Z',
      status: 'active',
      retentionDays: 30,
      createdAt: '2026-06-19T00:00:00.000Z',
      updatedAt: '2026-06-19T00:00:00.000Z',
      ...over,
    };
  }

  it('平文 token を tokenHash へ変換し、生 token を落とす', () => {
    const migrated = migrateReservationToHashed(legacy());
    expect(migrated.tokenHash).toBe(hashReservationToken(asReservationToken('legacy-plain-token')));
    expect((migrated as Record<string, unknown>).token).toBeUndefined();
    // 他フィールドは保持。
    expect(migrated.visitorName).toBe('山田太郎');
    expect(migrated.status).toBe('active');
  });

  it('pepper を指定すると peppered hash で移行する', () => {
    const migrated = migrateReservationToHashed(legacy(), 'server-pepper');
    expect(migrated.tokenHash).toBe(
      hashReservationToken(asReservationToken('legacy-plain-token'), 'server-pepper'),
    );
  });
});
