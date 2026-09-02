import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buttonStyle } from '../../src/components/admin/ui/Button';

/**
 * 「押せない」「処理中」の視覚契約を **kiosk と admin の両方**に課す (#886)。
 *
 * ## なぜ両方を 1 つのテストで見るか
 *
 * 契約の正本は `docs/experience/README.md` で、実装は **2 箇所に分かれている**:
 *   - kiosk … `globals.css` の `.btn:disabled:not([aria-busy='true'])`
 *   - admin … `ui/Button.tsx` の `buttonStyle()`
 *
 * kiosk は `#778` / `#792` で実装済みだったのに、**admin へ写されていなかった** ——
 * `buttonStyle()` に disabled の分岐が無く、43 箇所の disabled ボタンが有効時と画素単位で
 * 同一に描画されていた。片方だけ直る型を止めるには、**両方へ同じ条件を課す**しかない。
 *
 * これは本リポジトリが繰り返している「ある次元で解いた対策を別の次元へ写していない」形で、
 * #870（platform → admin）、#884（#869 → accent）に続く 3 例目である。
 */
const GLOBALS = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
const EXPERIENCE = readFileSync(resolve(process.cwd(), 'docs/experience/README.md'), 'utf8');

describe('押せない・処理中の視覚契約 (#886)', () => {
  it('契約が正本に書かれている（検査の根拠が消えたら落とす＝下界）', () => {
    // 文言そのものではなく、契約の 2 本柱が残っていることを確かめる。
    expect(EXPERIENCE, '「破線」の契約が正本から消えている').toContain('破線');
    expect(EXPERIENCE, 'aria-busy の契約が正本から消えている').toContain('aria-busy');
  });

  it('kiosk: 押せないを破線で示し、太さを変えない', () => {
    const block = GLOBALS.slice(GLOBALS.indexOf(".btn:disabled:not([aria-busy='true'])"));
    const body = block.slice(0, block.indexOf('}'));
    expect(body, 'kiosk が破線を使っていない').toContain('border-style: dashed');
    // 太さを触っていないこと。`border-width` を書いた時点で寸法が動きうる。
    expect(body, 'kiosk が枠の太さを変えている').not.toContain('border-width');
  });

  it('kiosk: 処理中には無効表現を当てない', () => {
    // `:not([aria-busy='true'])` が付いていることが、処理中を除外している証拠。
    expect(GLOBALS).toContain(".btn:disabled:not([aria-busy='true'])");
  });

  it('admin: 同じ契約を実装している（kiosk とずれない）', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const disabled = buttonStyle(variant, { disabled: true });
      const busy = buttonStyle(variant, { disabled: true, busy: true });
      expect(disabled.borderStyle, `${variant}: 破線でない`).toBe('dashed');
      expect(busy.borderStyle, `${variant}: 処理中に破線を当てている`).not.toBe('dashed');
    }
  });
});
