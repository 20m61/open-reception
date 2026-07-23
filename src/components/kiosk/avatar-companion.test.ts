import { describe, it, expect } from 'vitest';
import { RECEPTION_STATES } from '@/domain/reception/state';
import { deriveAvatarPresence } from '@/domain/reception/ui-contract';

/**
 * アバターの継続表示の仕様（KioskFlow の companion 表示は本 presence 契約に従う）。
 *
 * === 意図の反転（#123 → #361）===
 * 旧仕様(#123)は「選択/入力/確認画面はカードや入力欄でコンテンツが密集し重なるため
 * アバターを出さない（中央寄せで余白のあるステータス画面に限定）」とし、本テストは
 * その set を `COMPANION_STATES` として固定していた（selectingPurpose/selectingTarget/
 * inputVisitorInfo/confirming は false）。
 *
 * #361（Character-led 再設計）はこの意図を**意図的に反転**する。フォームや選択が独立カード
 * として進むと来訪者から見て「同じアバターとの対話」が途中で切れるため、選択/入力/確認/
 * 呼び出しでもアバターを会話コンパニオン(presence='companion')として継続表示する。
 * 表示の真実源は `deriveAvatarPresence(screenState)`（ui-contract.ts）へ移し、旧テストが固定
 * していた「密集画面では非表示」という前提を破棄する。
 *
 * レイアウト上の重なり回避は「非表示」ではなく配置で解決する:
 *  - 横向き(ipad-landscape)はアバター 35% / 会話・操作 65% のレール構成で並置する。
 *  - 縦向き(ipad-portrait)は既存プロファイルを壊さないため、KioskFlow 側でステータス画面に
 *    限定した控えめ表示を維持する（presence 契約自体は横縦非依存）。
 */
describe('avatar presence 表示状態 (#361 / 旧 #123 の意図反転)', () => {
  it('待機はアバターが主役(primary)、通話中は静かな最小(minimal)', () => {
    expect(deriveAvatarPresence('idle')).toBe('primary');
    expect(deriveAvatarPresence('connected')).toBe('minimal');
  });

  it('選択・入力・確認・呼び出しでもアバターは会話コンパニオンとして継続する（旧: 非表示 → 新: companion）', () => {
    // #123 ではここが「重なり回避のため非表示」だった。#361 で反転し companion で継続する。
    expect(deriveAvatarPresence('selectingPurpose')).toBe('companion');
    expect(deriveAvatarPresence('selectingTarget')).toBe('companion');
    expect(deriveAvatarPresence('inputVisitorInfo')).toBe('companion');
    expect(deriveAvatarPresence('confirming')).toBe('companion');
    expect(deriveAvatarPresence('calling')).toBe('companion');
  });

  it('結果・完了・中止でもアバターが付き添う(companion)', () => {
    for (const s of ['timeout', 'failed', 'fallback', 'completed', 'cancelled'] as const) {
      expect(deriveAvatarPresence(s)).toBe('companion');
    }
  });

  it('全 ReceptionState を分類できる（漏れ検知）', () => {
    for (const s of RECEPTION_STATES) {
      expect(['primary', 'companion', 'minimal']).toContain(deriveAvatarPresence(s));
    }
  });
});
