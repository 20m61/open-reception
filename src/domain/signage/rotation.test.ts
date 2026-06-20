import { describe, expect, it } from 'vitest';
import {
  isHttpUrl,
  isPlayable,
  itemDuration,
  nextIndex,
  playableItems,
  validateConfig,
  validateItem,
} from './rotation';
import {
  asSignageItemId,
  defaultSignageConfig,
  type SignageConfig,
  type SignageItem,
} from './types';
import { asSiteId, asTenantId } from '@/domain/tenant/types';

const T = asTenantId('tenant-a');
const S = asSiteId('site-1');

function item(over: Partial<SignageItem> = {}): SignageItem {
  return {
    id: asSignageItemId('i1'),
    type: 'clock',
    enabled: true,
    ...over,
  };
}

function config(over: Partial<SignageConfig> = {}): SignageConfig {
  return { ...defaultSignageConfig(T, S, '2026-06-20T00:00:00.000Z'), ...over };
}

describe('isHttpUrl', () => {
  it('http/https を受け入れ、それ以外を拒否する', () => {
    expect(isHttpUrl('https://cdn/x.png')).toBe(true);
    expect(isHttpUrl('http://cdn/x.png')).toBe(true);
    expect(isHttpUrl('ftp://cdn/x.png')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

describe('validateItem (#101)', () => {
  it('clock は追加フィールド不要で valid', () => {
    expect(validateItem(item({ type: 'clock' }), 0)).toEqual([]);
  });

  it('message は本文必須', () => {
    expect(validateItem(item({ type: 'message' }), 0).length).toBeGreaterThan(0);
    expect(validateItem(item({ type: 'message', message: 'ようこそ' }), 0)).toEqual([]);
  });

  it('image は http(s) URL 必須', () => {
    expect(validateItem(item({ type: 'image' }), 0).length).toBeGreaterThan(0);
    expect(validateItem(item({ type: 'image', imageUrl: 'bad' }), 0).length).toBeGreaterThan(0);
    expect(validateItem(item({ type: 'image', imageUrl: 'https://cdn/x.png' }), 0)).toEqual([]);
  });

  it('slides は 1 つ以上の http(s) URL 必須', () => {
    expect(validateItem(item({ type: 'slides', slideUrls: [] }), 0).length).toBeGreaterThan(0);
    expect(
      validateItem(item({ type: 'slides', slideUrls: ['https://a', 'bad'] }), 0).length,
    ).toBeGreaterThan(0);
    expect(validateItem(item({ type: 'slides', slideUrls: ['https://a'] }), 0)).toEqual([]);
  });

  it('範囲外の durationSeconds を拒否する', () => {
    expect(validateItem(item({ durationSeconds: 1 }), 0).length).toBeGreaterThan(0);
    expect(validateItem(item({ durationSeconds: 9999 }), 0).length).toBeGreaterThan(0);
    expect(validateItem(item({ durationSeconds: 30 }), 0)).toEqual([]);
  });

  it('未知の種別を拒否する', () => {
    expect(validateItem(item({ type: 'bogus' as never }), 0).length).toBeGreaterThan(0);
  });
});

describe('validateConfig (#101)', () => {
  it('既定間隔の範囲外を拒否する', () => {
    expect(validateConfig(config({ defaultIntervalSeconds: 1 })).ok).toBe(false);
  });

  it('id 重複を拒否する', () => {
    const dup = config({
      items: [item({ id: asSignageItemId('x') }), item({ id: asSignageItemId('x') })],
    });
    expect(validateConfig(dup).ok).toBe(false);
  });

  it('enabled なら再生可能項目が 1 つ以上必要', () => {
    expect(validateConfig(config({ enabled: true, items: [] })).ok).toBe(false);
    expect(
      validateConfig(config({ enabled: true, items: [item({ type: 'clock' })] })).ok,
    ).toBe(true);
  });

  it('disabled なら空でも valid', () => {
    expect(validateConfig(config({ enabled: false, items: [] })).ok).toBe(true);
  });
});

describe('playableItems / isPlayable', () => {
  it('無効・不備の項目を除外し、並び順を保つ', () => {
    const c = config({
      items: [
        item({ id: asSignageItemId('a'), type: 'clock' }),
        item({ id: asSignageItemId('b'), type: 'message', enabled: false, message: 'x' }),
        item({ id: asSignageItemId('c'), type: 'image' }), // imageUrl 無し → 不備
        item({ id: asSignageItemId('d'), type: 'message', message: 'ok' }),
      ],
    });
    expect(playableItems(c).map((i) => i.id)).toEqual(['a', 'd']);
    expect(isPlayable(item({ type: 'image', imageUrl: 'https://x' }))).toBe(true);
    expect(isPlayable(item({ type: 'image', imageUrl: 'https://x', enabled: false }))).toBe(false);
  });
});

describe('itemDuration / nextIndex', () => {
  it('個別秒数 > 既定間隔', () => {
    const c = config({ defaultIntervalSeconds: 10 });
    expect(itemDuration(item(), c)).toBe(10);
    expect(itemDuration(item({ durationSeconds: 25 }), c)).toBe(25);
  });

  it('末尾で先頭へループする', () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(2, 3)).toBe(0);
    expect(nextIndex(0, 0)).toBe(0);
    expect(nextIndex(5, 1)).toBe(0);
  });
});
