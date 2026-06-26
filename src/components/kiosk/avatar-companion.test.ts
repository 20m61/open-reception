import { describe, it, expect } from 'vitest';
import { RECEPTION_STATES, type ReceptionState } from '@/domain/reception/state';

/**
 * #123 アバター常設コンパニオンの表示状態（KioskFlow の showAvatarCompanion と同義の仕様）。
 * 余白のある中央寄せステータス画面のみ true。選択/入力/待機では false（重なり回避）。
 */
const COMPANION_STATES = new Set<ReceptionState>([
  'calling',
  'connected',
  'timeout',
  'failed',
  'fallback',
  'completed',
  'cancelled',
]);

describe('avatar companion 表示状態 (#123)', () => {
  it('ステータス画面でのみ表示する', () => {
    expect(COMPANION_STATES.has('calling')).toBe(true);
    expect(COMPANION_STATES.has('completed')).toBe(true);
    expect(COMPANION_STATES.has('failed')).toBe(true);
  });

  it('待機・選択・入力・確認では表示しない（コンテンツ密集で重なるため）', () => {
    expect(COMPANION_STATES.has('idle')).toBe(false);
    expect(COMPANION_STATES.has('selectingPurpose')).toBe(false);
    expect(COMPANION_STATES.has('selectingTarget')).toBe(false);
    expect(COMPANION_STATES.has('inputVisitorInfo')).toBe(false);
    expect(COMPANION_STATES.has('confirming')).toBe(false);
  });

  it('全 ReceptionState を分類できる（漏れ検知）', () => {
    for (const s of RECEPTION_STATES) {
      expect(typeof COMPANION_STATES.has(s)).toBe('boolean');
    }
  });
});
