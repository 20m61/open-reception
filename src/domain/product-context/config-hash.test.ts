import { describe, expect, it } from 'vitest';
import { canonicalJson, computeConfigHash, type ConfigHashInput } from './config-hash';
import { asSiteId, asTenantId } from '@/domain/tenant/types';

const BASE: ConfigHashInput = {
  context: { tenantId: asTenantId('tenant-a'), siteId: asSiteId('site-1'), kioskId: 'kiosk-1' },
  version: { id: 'ver-1', status: 'published', revision: 3 },
  sections: {
    branding: { accentColor: '#123456', companyName: 'AVITA' },
    voice: { ttsEnabled: true, rate: 1 },
  },
};

describe('canonicalJson', () => {
  it('キー順に依存しない', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('配列の順序は保持する（表示順は意味を持つ）', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('undefined のキーは欠落キーと同一視する（JSON 表現に一致させる）', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('入れ子のキー順も正規化する', () => {
    expect(canonicalJson({ o: { y: 1, x: 2 } })).toBe(canonicalJson({ o: { x: 2, y: 1 } }));
  });

  it('null と欠落は区別する（明示的な無効化を潰さない）', () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });
});

describe('computeConfigHash', () => {
  it('sha256 プレフィックス付きの安定した指紋を返す', () => {
    const hash = computeConfigHash(BASE);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeConfigHash(BASE)).toBe(hash);
  });

  it('セクションのキー順が違っても一致する（プレビューと本番の resolver 一致条件）', () => {
    const reordered: ConfigHashInput = {
      ...BASE,
      sections: {
        voice: { rate: 1, ttsEnabled: true },
        branding: { companyName: 'AVITA', accentColor: '#123456' },
      },
    };
    expect(computeConfigHash(reordered)).toBe(computeConfigHash(BASE));
  });

  it('version の revision が違えば別の指紋になる', () => {
    const bumped: ConfigHashInput = { ...BASE, version: { ...BASE.version, revision: 4 } };
    expect(computeConfigHash(bumped)).not.toBe(computeConfigHash(BASE));
  });

  it('セクションの内容が変われば指紋が変わる', () => {
    const changed: ConfigHashInput = {
      ...BASE,
      sections: { ...BASE.sections, branding: { accentColor: '#000000', companyName: 'AVITA' } },
    };
    expect(computeConfigHash(changed)).not.toBe(computeConfigHash(BASE));
  });

  it('端末が違えば指紋が変わる（端末別上書きを取り違えない）', () => {
    const otherKiosk: ConfigHashInput = {
      ...BASE,
      context: { ...BASE.context, kioskId: 'kiosk-2' },
    };
    expect(computeConfigHash(otherKiosk)).not.toBe(computeConfigHash(BASE));
  });

  it('publishedAt の有無は指紋に影響しない（内容ではなく配信時刻のため）', () => {
    const withPublishedAt: ConfigHashInput = {
      ...BASE,
      version: { ...BASE.version, publishedAt: '2026-07-27T00:00:00.000Z' },
    };
    expect(computeConfigHash(withPublishedAt)).toBe(computeConfigHash(BASE));
  });
});
