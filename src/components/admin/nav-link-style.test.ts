import { describe, expect, it } from 'vitest';
import { navLinkAriaCurrent, navLinkStyle } from './nav-link-style';
import { motion } from './ui/tokens';

describe('navLinkStyle: アクティブ表示の即時反映 (#94)', () => {
  it('アクティブ項目はアクセントの左罫線・太字・surface-2 背景になる', () => {
    const s = navLinkStyle(true);
    expect(s.fontWeight).toBe(700);
    expect(s.background).toBe('var(--color-surface-2)');
    expect(s.borderLeft).toBe('3px solid var(--color-accent)');
    expect(s.opacity).toBe(1);
  });

  it('非アクティブ項目は控えめ（透過罫線・通常太さ・透明背景）', () => {
    const s = navLinkStyle(false);
    expect(s.fontWeight).toBe(400);
    expect(s.background).toBe('transparent');
    expect(s.borderLeft).toBe('3px solid transparent');
    expect(s.opacity).toBe(0.8);
  });

  it('遷移を滑らかに見せる軽い transition を常に持つ', () => {
    /*
     * #903 で直書きの `120ms` をモーショントークンへ寄せた。**主張は弱めない** ——
     * 「軽い」を言い切るのが目的なので、単に transition が在ることではなく
     * **応答 3 段階のいちばん速い段**を使っていることを見る（下界として `slow` を排除）。
     */
    for (const active of [true, false]) {
      const transition = String(navLinkStyle(active).transition);
      expect(transition).toContain(motion.fast);
      expect(transition).not.toContain(motion.slow);
      expect(transition).toContain('background');
      expect(transition).toContain('opacity');
    }
  });

  it('語中改行を防ぐ（#330 item4）: keep-all を基本にしつつ、収まらない場合の保険を持つ', () => {
    for (const active of [true, false]) {
      const s = navLinkStyle(active);
      expect(s.wordBreak).toBe('keep-all');
      expect(s.overflowWrap).toBe('anywhere');
    }
  });

  it('サイドバー幅（240px）で収まるよう、本文の巨大フォントではなく管理画面密度のフォントを使う（#330 item4）', () => {
    // ページ本文の --font-body（受付端末向け 1.25rem=20px）ではなく、
    // 管理画面 UI トークンの font.body（0.95rem）を使う。
    expect(navLinkStyle(true).fontSize).toBe('0.95rem');
  });
});

describe('navLinkAriaCurrent: 現在地の SR 通知 (#94)', () => {
  it('アクティブ時のみ page、それ以外は undefined', () => {
    expect(navLinkAriaCurrent(true)).toBe('page');
    expect(navLinkAriaCurrent(false)).toBeUndefined();
  });
});
