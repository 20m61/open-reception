import { describe, it, expect } from 'vitest';
import { InMemoryTtsCache } from './cache-store';

describe('InMemoryTtsCache (issue #371 — S3/CloudFront/SW/IndexedDB 境界の暫定実装, ADR 0002)', () => {
  it('has() is false and get() is undefined for a key never set', () => {
    const cache = new InMemoryTtsCache();
    expect(cache.has('missing')).toBe(false);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('set() then get() returns the same entry', () => {
    const cache = new InMemoryTtsCache();
    cache.set('k1', { audioRef: 'ref1', createdAt: 100 });
    expect(cache.get('k1')).toEqual({ audioRef: 'ref1', createdAt: 100 });
    expect(cache.has('k1')).toBe(true);
  });

  it('set() overwrites an existing entry for the same key', () => {
    const cache = new InMemoryTtsCache();
    cache.set('k1', { audioRef: 'ref1', createdAt: 100 });
    cache.set('k1', { audioRef: 'ref2', createdAt: 200 });
    expect(cache.get('k1')).toEqual({ audioRef: 'ref2', createdAt: 200 });
  });

  it('keeps distinct keys isolated from each other', () => {
    const cache = new InMemoryTtsCache();
    cache.set('k1', { audioRef: 'ref1', createdAt: 100 });
    cache.set('k2', { audioRef: 'ref2', createdAt: 200 });
    expect(cache.get('k1')!.audioRef).toBe('ref1');
    expect(cache.get('k2')!.audioRef).toBe('ref2');
  });
});
