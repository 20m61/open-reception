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

/** variant → インラインスタイル（純ロジック・テスト対象）。 */
export function buttonStyle(variant: ButtonVariant): CSSProperties {
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
  switch (variant) {
    case 'primary':
      return { ...base, background: color.accent, color: color.bg };
    case 'secondary':
      return { ...base, background: color.surface, color: color.text, borderColor: color.borderStrong };
    case 'ghost':
      return { ...base, background: color.surface, color: color.text, borderColor: color.borderStrong };
    case 'danger':
      return { ...base, background: color.surface, color: color.danger, borderColor: color.danger };
  }
}

export function Button({
  variant = 'secondary',
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      data-testid="ui-button"
      data-variant={variant}
      style={{ ...buttonStyle(variant), ...style }}
      {...rest}
    />
  );
}
