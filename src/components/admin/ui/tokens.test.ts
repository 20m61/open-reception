import { describe, expect, it } from 'vitest';
import { buttonStyle, type ButtonVariant } from './Button';
import {
  SECRET_META,
  STATUS_META,
  TONE_COLOR,
  TONE_SOFT_BG,
  color,
  type SecretPresence,
  type StatusKind,
  type Tone,
} from './tokens';

describe('STATUS_META: 状態語彙 (#92 表示ルール)', () => {
  const ALL: StatusKind[] = ['ok', 'warning', 'critical', 'stopped', 'maintenance'];

  it('5 状態すべてにラベルと色が定義されている', () => {
    for (const s of ALL) {
      expect(STATUS_META[s].label).toBeTruthy();
      expect(STATUS_META[s].color).toMatch(/^var\(--color-/);
    }
  });

  it('業務向けの日本語ラベルに揃っている', () => {
    expect(STATUS_META.ok.label).toBe('正常');
    expect(STATUS_META.critical.label).toBe('異常');
    expect(STATUS_META.maintenance.label).toBe('メンテナンス中');
  });

  it('異常は danger、正常は success の色トークン', () => {
    expect(STATUS_META.critical.color).toBe(color.danger);
    expect(STATUS_META.ok.color).toBe(color.success);
  });
});

describe('SECRET_META: シークレット状態語彙 (#92 機密値非表示)', () => {
  const ALL: SecretPresence[] = ['configured', 'missing', 'needs_rotation'];

  it('登録済み/未設定/要更新 の 3 状態のみ', () => {
    expect(Object.keys(SECRET_META).sort()).toEqual([...ALL].sort());
    expect(SECRET_META.configured.label).toBe('登録済み');
    expect(SECRET_META.missing.label).toBe('未設定');
    expect(SECRET_META.needs_rotation.label).toBe('要更新');
  });
});

describe('TONE_COLOR / TONE_SOFT_BG: トーン語彙', () => {
  it('全トーンに前景色がある', () => {
    const tones: Tone[] = ['neutral', 'success', 'warning', 'danger', 'accent'];
    for (const t of tones) {
      expect(TONE_COLOR[t]).toBeTruthy();
    }
    expect(TONE_COLOR.neutral).toBe(color.text);
  });

  it('soft 背景は neutral 以外の全トーンに rgba で定義', () => {
    for (const t of ['success', 'warning', 'danger', 'accent'] as const) {
      expect(TONE_SOFT_BG[t]).toMatch(/^rgba\(/);
    }
  });
});

describe('buttonStyle: variant 選択ロジック', () => {
  const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];

  it('全 variant が共通の base（cursor:pointer, fontWeight:700）を持つ', () => {
    for (const v of VARIANTS) {
      const s = buttonStyle(v);
      expect(s.cursor).toBe('pointer');
      expect(s.fontWeight).toBe(700);
    }
  });

  it('primary は accent 背景、文字は bg 色（コントラスト確保）', () => {
    const s = buttonStyle('primary');
    expect(s.background).toBe(color.accent);
    expect(s.color).toBe(color.bg);
  });

  it('danger は danger 文字色と danger 罫線（怖く見せる）', () => {
    const s = buttonStyle('danger');
    expect(s.color).toBe(color.danger);
    expect(s.borderColor).toBe(color.danger);
  });

  it('secondary と ghost は同系の落ち着いたトーン', () => {
    expect(buttonStyle('secondary').color).toBe(color.text);
    expect(buttonStyle('ghost').color).toBe(color.text);
  });
});

/**
 * 押せない・処理中の視覚契約を admin へも効かせる (#886 / 課題 09・10)。
 *
 * `docs/experience/README.md` が正本として定めている:
 *   - **押せない** … 破線の枠で示す。透明度だけに寄せない。**太さは変えない**
 *   - **処理中** … `aria-busy="true"` を付けて無効表現から**除外する**
 *
 * kiosk 側（`globals.css` の `.btn:disabled:not([aria-busy='true'])`）は実装済みだったが、
 * `ui/Button.tsx` には disabled の分岐が**無かった**。インラインで `background` を明示して
 * いるため UA 既定のグレーアウトまで打ち消し、**43 箇所の disabled ボタンが有効時と画素単位で
 * 同一に描画されていた**（実測: `<Button>` 135 個中 43 個が disabled を受ける / 19 ファイル）。
 */
describe('ボタンの状態表現 (#886)', () => {
  const VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const;

  it.each(VARIANTS)('%s: 押せないときは有効時と異なる描画になる', (variant) => {
    const enabled = buttonStyle(variant);
    const disabled = buttonStyle(variant, { disabled: true });
    expect(disabled).not.toEqual(enabled);
  });

  it.each(VARIANTS)('%s: 押せないことを破線で示す（透明度だけに寄せない）', (variant) => {
    const disabled = buttonStyle(variant, { disabled: true });
    expect(disabled.borderStyle, '破線になっていない').toBe('dashed');
    // 透明度**だけ**で表現していないこと。opacity を落として済ませると、明るいロビーでは
    // 「ただのボタン」に見えて連打される（experience 契約）。
    expect(disabled.opacity, 'opacity だけに寄せている').toBeUndefined();
  });

  /**
   * 枠の**実効**太さ。`border` ショートハンドと `borderWidth` のどちらで指定されても拾う。
   *
   * 当初は `borderWidth` だけを見ていたが、`base` が `border: '1px solid transparent'` の
   * ショートハンドを使っているため**両方 undefined になり、検査が成立していなかった**
   * （`expect(undefined).toBe('1px')` で落ちて気づいた）。ショートハンドを
   * `2px dashed` に書き換える変異も捕まえたいので、両方から取る。
   */
  const effectiveBorderWidth = (style: ReturnType<typeof buttonStyle>): string => {
    if (style.borderWidth !== undefined) return String(style.borderWidth);
    const shorthand = typeof style.border === 'string' ? style.border : '';
    return shorthand.split(/\s+/)[0] ?? '';
  };

  it.each(VARIANTS)('%s: 枠の太さは有効時と変わらない（寸法を動かさない）', (variant) => {
    // 太らせると有効化の瞬間にボタンの寸法が動き、「押せるようになった」ではなく
    // 「画面が動いた」と受け取られる。
    const enabled = buttonStyle(variant);
    const disabled = buttonStyle(variant, { disabled: true });
    expect(effectiveBorderWidth(disabled)).toBe(effectiveBorderWidth(enabled));
    // 下界: 両方とも空文字なら上は空虚に通る。実際に太さが取れていることを確かめる。
    expect(effectiveBorderWidth(enabled)).toBe('1px');
  });

  it.each(VARIANTS)('%s: 処理中（aria-busy）には無効表現を当てない', (variant) => {
    // #792: 送信の往復中に主 CTA が破線へ落ちると「押せなくなった」と読まれる。
    const busy = buttonStyle(variant, { disabled: true, busy: true });
    expect(busy.borderStyle, '処理中に破線を当てている').not.toBe('dashed');
    expect(busy.background, '処理中に面が変わっている').toBe(buttonStyle(variant).background);
  });

  it('secondary と ghost は別の描画になる（4 variant が 3 描画に潰れない）', () => {
    // 旧テストは「両方とも color.text」しか見ておらず、**同一オブジェクトを返す実装を
    // 検出できなかった**。同系のトーンであることと、区別が付くことは両立する。
    expect(buttonStyle('ghost')).not.toEqual(buttonStyle('secondary'));
  });

  it('ghost は面を持たない（#778「枠が強い＝重要」に沿う）', () => {
    // 下界: 上の検査は「どこか 1 プロパティが違えば」通ってしまう。ghost が ghost である
    // 条件そのものを名指しで縛る。
    expect(buttonStyle('ghost').background).toBe('transparent');
  });
});
