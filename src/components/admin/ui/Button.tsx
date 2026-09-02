import type { ButtonHTMLAttributes, CSSProperties } from 'react';
import { color, radius, space } from './tokens';

/**
 * 管理画面 共有ボタン (issue #92, increment 1)。
 *
 * 既存ページの ghost / danger ボタン（インラインスタイル）のトーンを正準化したもの。
 * バリアントは globals.css の `.btn--*`（受付端末向け = 大型）とは別系統で、
 * 管理画面向けに密度を上げた標準サイズにする。
 *
 * variant 選択ロジック（`buttonStyle`）は純粋関数として切り出し、node 環境でテストする。
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * ボタンの状態。**「押せない」と「処理中」を別の状態として扱う**（`#792`）。
 *
 * どちらも DOM 上は `disabled` 属性で表現されるが、視覚表現は正反対である ——
 * 処理中に無効表現を当てると、来訪者/運用者は「押せなくなった・タップが失敗した」と読む。
 */
export type ButtonState = {
  /** `disabled` 属性が付いているか。 */
  readonly disabled?: boolean;
  /** `aria-busy="true"`（処理中）。無効表現から**除外する**。 */
  readonly busy?: boolean;
};

/**
 * variant → インラインスタイル（純ロジック・テスト対象）。
 *
 * 🔴 **状態も受ける (#886)。** かつては variant だけを見ており disabled の分岐が無かった。
 * インラインで `background` を明示しているため **UA 既定のグレーアウトまで打ち消し**、
 * 43 箇所の disabled ボタンが有効時と画素単位で同一に描画されていた。
 *
 * 視覚契約の正本は `docs/experience/README.md`:
 *   - 押せない … **破線の枠**で示す。透明度だけに寄せない。**太さは変えない**
 *   - 処理中 … `aria-busy="true"` を付けて無効表現から除外する
 *
 * kiosk 側（`globals.css` の `.btn:disabled:not([aria-busy='true'])`）は実装済みだった。
 * 同じ契約を 2 箇所で別々に書くことになるので、
 * `tests/config/button-visual-contract.test.ts` が両方に同じ条件を課す。
 */
export function buttonStyle(variant: ButtonVariant, state: ButtonState = {}): CSSProperties {
  const base: CSSProperties = {
    minHeight: 34,
    padding: `${space.xs}px ${space.sm}px`,
    borderRadius: radius.sm,
    border: '1px solid transparent',
    fontWeight: 700,
    fontSize: '0.9rem',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  };

  const byVariant = (): CSSProperties => {
    switch (variant) {
      case 'primary':
        return { ...base, background: color.accent, color: color.bg };
      case 'secondary':
        return { ...base, background: color.surface, color: color.text, borderColor: color.borderStrong };
      case 'ghost':
        /*
         * **面を持たない** (#886 / 課題 10)。以前は secondary と**同一オブジェクト**を返して
         * おり、4 variant の API が実際は 3 描画だった。`#778` の「枠が強い＝重要」に沿って、
         * ghost は面も枠も持たず文字だけで立つ。
         */
        return { ...base, background: 'transparent', color: color.text, borderColor: 'transparent' };
      case 'danger':
        return { ...base, background: color.surface, color: color.danger, borderColor: color.danger };
    }
  };

  const style = byVariant();

  // 処理中は無効表現を当てない。**`disabled` 属性自体は外さない**ので二重送信は防がれる。
  if (!state.disabled || state.busy) {
    return state.busy ? { ...style, cursor: 'progress' } : style;
  }

  return {
    ...style,
    /*
     * 面を消して破線の枠へ落とす。**太さは `base` の 1px のまま**（`borderStyle` だけを
     * 変え `borderWidth` に触れない）—— 太らせると有効化の瞬間に寸法が動き、
     * 「押せるようになった」ではなく「画面が動いた」と受け取られる。
     */
    background: variant === 'ghost' ? 'transparent' : color.surface,
    borderStyle: 'dashed',
    borderColor: color.muted,
    color: color.muted,
    cursor: 'not-allowed',
  };
}

export function Button({
  variant = 'secondary',
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  // `aria-busy` は rest 経由で渡る。**文字列で来る**ので厳密に比較する。
  const busy = rest['aria-busy'] === true || rest['aria-busy'] === 'true';
  return (
    <button
      type="button"
      data-testid="ui-button"
      data-variant={variant}
      // 状態を属性でも出す。VRT / e2e が「押せない」を DOM から引けるようにするため。
      data-state={rest.disabled ? (busy ? 'busy' : 'disabled') : undefined}
      style={{ ...buttonStyle(variant, { disabled: rest.disabled, busy }), ...style }}
      {...rest}
    />
  );
}
