/**
 * 呼び出し失敗の理由と文言の対応の単体テスト (issue #422 / 体験設計 J-OR-05)。
 */
import { describe, expect, it } from 'vitest';
import { failedMessageKeyFor, shouldOfferAlternativeContact } from './call-failure';
import { makeT } from '@/lib/i18n';

describe('failedMessageKeyFor', () => {
  it('通信断は専用の文言（呼び出しが行われたと読ませない）', () => {
    expect(failedMessageKeyFor('network')).toBe('reception.failedNetworkBody');
  });

  it('サーバ側の失敗は従来の文言', () => {
    expect(failedMessageKeyFor('server')).toBe('reception.failedBody');
  });

  it('理由不明は従来の文言へ倒す（旧経路を壊さない）', () => {
    expect(failedMessageKeyFor(undefined)).toBe('reception.failedBody');
  });

  it('全 locale で文言が引ける（未翻訳のキーを作らない）', () => {
    for (const locale of ['ja', 'en', 'ko', 'zh', 'ja-simple'] as const) {
      const text = makeT(locale)('reception.failedNetworkBody');
      expect(text.length).toBeGreaterThan(0);
      // キー名がそのまま出ていない（辞書に無いと key を返す実装のため）。
      expect(text).not.toBe('reception.failedNetworkBody');
    }
  });
});

describe('shouldOfferAlternativeContact', () => {
  it('通信断では代替の連絡先を主 CTA にしない（押しても同じく届かない）', () => {
    expect(shouldOfferAlternativeContact('network')).toBe(false);
  });

  it('それ以外は従来どおり代替導線を出す（行き止まりを作らない）', () => {
    expect(shouldOfferAlternativeContact('server')).toBe(true);
    expect(shouldOfferAlternativeContact(undefined)).toBe(true);
  });
});
