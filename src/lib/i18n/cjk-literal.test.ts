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
});
