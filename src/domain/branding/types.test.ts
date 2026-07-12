import { describe, expect, it } from 'vitest';
import { hasBrandingContent } from './types';

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
