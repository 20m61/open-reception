import { describe, expect, it } from 'vitest';
import {
  ACCENT_INK_DARK,
  ACCENT_INK_LIGHT,
  MIN_ACCENT_CONTRAST,
  accentInkFor,
  contrastRatio,
  hasBrandingContent,
  normalizeAccentColor,
} from './types';

/**
 * ブランド表示可否の判定 (#326)。待機画面（IdleView）とサイネージ未設定フォールバックの
 * 両方が「ロゴ or 社名のどちらかがあればブランドを出す」を共有する。単一の真実源にして
 * 判定の重複/乖離を防ぐ。
 */
describe('hasBrandingContent (#326)', () => {
  it('ロゴのみでも true', () => {
    expect(hasBrandingContent({ logoUrl: '/assets/logo.png' })).toBe(true);
  });

  it('社名のみでも true', () => {
    expect(hasBrandingContent({ companyName: '株式会社サンプル' })).toBe(true);
  });

  it('両方あれば true', () => {
    expect(hasBrandingContent({ logoUrl: '/assets/logo.png', companyName: '株式会社サンプル' })).toBe(
      true,
    );
  });

  it('どちらも無ければ false', () => {
    expect(hasBrandingContent({})).toBe(false);
    expect(hasBrandingContent({ logoUrl: undefined, companyName: undefined })).toBe(false);
  });

  it('空文字は「無い」扱い', () => {
    expect(hasBrandingContent({ logoUrl: '', companyName: '' })).toBe(false);
  });
});

/**
 * accent 上のインクを輝度で選ぶ (#884 / 課題 23)。
 *
 * `--color-accent-ink`（`#06121f`）を固定で使っていたため、紺やえんじを選んだテナントの
 * 主 CTA が**黒地に黒文字**になっていた（実測: `#7f1d1d` 対 `#06121f` = 1.88:1）。
 *
 * 分岐ごとの期待値ではなく**不変条件**で縛る（`CLAUDE.md` 検証の作法）。
 * 「この色にはこのインク」を列挙すると、実装と同じ導出をテストへ写すだけになる。
 */
describe('accent 上のインク選択 (#884)', () => {
  it('どの accent でも、選ばれたインクが最小コントラストを満たす（総当たり）', () => {
    // sRGB を粗く総当たりする。**これがこの機能の存在理由そのもの**なので、
    // 代表値ではなく全域で縛る。
    const failures: string[] = [];
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 17) {
          const accent = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
          const ratio = contrastRatio(accent, accentInkFor(accent));
          if (ratio < MIN_ACCENT_CONTRAST) failures.push(`${accent} → ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures, `インクを選んでも読めない accent がある:\n${failures.slice(0, 10).join('\n')}`).toEqual([]);
  });

  it('選ぶのは常に「良いほう」（下界: 常に暗インクを返す実装を落とす）', () => {
    // 上の検査は「常に良いほうを返す」以外の実装でも、たまたま全部 3:1 を超えれば通る。
    // 暗い accent で明インクが選ばれることを名指しで縛る。
    expect(accentInkFor('#7f1d1d')).toBe(ACCENT_INK_LIGHT);
    expect(accentInkFor('#1e3a8a')).toBe(ACCENT_INK_LIGHT);
    // 既定のシアンは暗インク。ここが反転すると既定テナントのコントラストが 8.80 → 2.14 に落ちる。
    expect(accentInkFor('#38bdf8')).toBe(ACCENT_INK_DARK);
  });

  it('accent の保存はコントラストで拒否しない（実在するコーポレートカラーを排除しない）', () => {
    // 弾く設計も検討したが、#7f1d1d / #1e3a8a / #312e81 がほぼ全滅するので採らなかった。
    for (const accent of ['#7f1d1d', '#1e3a8a', '#312e81', '#000000', '#ffffff', '#38bdf8']) {
      expect(normalizeAccentColor(accent), accent).toBe(accent);
    }
  });

  it('形式の検証は従来どおり効く', () => {
    expect(normalizeAccentColor('red')).toBeUndefined();
    expect(normalizeAccentColor('#fff')).toBeUndefined();
    expect(normalizeAccentColor(123)).toBeUndefined();
  });
});
