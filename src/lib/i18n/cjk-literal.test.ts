import { describe, expect, it } from 'vitest';
import { CJK_EXCEPTION_ALLOWLIST, scanKioskForRawCjk } from '../../../scripts/check-cjk-literals';

/**
 * kiosk 配下の生 CJK 文字列リテラル機械検証 (issue #327)。
 *
 * `scripts/check-cjk-literals.ts` の AST スキャナを使い、`CJK_EXCEPTION_ALLOWLIST`
 * （未移行の既存ファイル）を除く kiosk コンポーネントに日本語等の CJK ハードコードが
 * 混入していないことを検証する。新規ファイルや `checkout/**` は allowlist に無いため
 * 即座に検出される（受け入れ条件: 「新規文言追加時に翻訳漏れが構造的に検出される」）。
 */
describe('kiosk 配下の生 CJK リテラル (#327)', () => {
  it('例外リスト（未移行ファイル）以外に生 CJK 文字列リテラルが無い', () => {
    const violations = scanKioskForRawCjk();
    expect(violations).toEqual([]);
  });

  it('退館チェックアウト (checkout/**) は例外なしで完全に検証される', () => {
    expect(CJK_EXCEPTION_ALLOWLIST.some((p) => p.includes('/checkout/'))).toBe(false);
  });

  it('待機サイネージ (SignageDisplay.tsx) は例外なしで完全に検証される (#327 2nd increment)', () => {
    expect(
      CJK_EXCEPTION_ALLOWLIST.includes('src/components/kiosk/signage/SignageDisplay.tsx'),
    ).toBe(false);
  });

  it('走査対象は components/kiosk と app/kiosk の両方に及ぶ（app router ページの棚卸し漏れを防ぐ）', () => {
    // enroll/page.tsx は端末プロビジョニング画面（来訪者向け多言語導線の対象外）で明示除外。
    // layout.tsx はブラウザタブタイトルのみで画面本文ではないため明示除外。それ以外の
    // src/app/kiosk 配下（checkout/page.tsx・signage/page.tsx・page.tsx）は例外なしで検証される。
    expect(CJK_EXCEPTION_ALLOWLIST).toContain('src/app/kiosk/enroll/page.tsx');
    expect(CJK_EXCEPTION_ALLOWLIST).toContain('src/app/kiosk/layout.tsx');
    expect(CJK_EXCEPTION_ALLOWLIST.some((p) => p === 'src/app/kiosk/checkout/page.tsx')).toBe(
      false,
    );
    expect(CJK_EXCEPTION_ALLOWLIST.some((p) => p === 'src/app/kiosk/signage/page.tsx')).toBe(
      false,
    );
  });
});
