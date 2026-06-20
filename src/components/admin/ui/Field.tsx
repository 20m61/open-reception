import type { ReactNode } from 'react';
import { color, font, space } from './tokens';

/**
 * 管理画面 共有フォーム部品 (issue #92, increment 1)。
 *
 * `Field` … ラベル + 入力 + 補足/エラーの縦積み。`htmlFor`/`id` を結び、
 *           エラー時は `aria-describedby` 相当の補足を赤字で出す。
 * `FormRow` … 複数 Field を横並びにする行コンテナ（密度を上げる）。
 *
 * 入力要素そのものは children として受け取る（select/input/textarea を選ばない）。
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  children,
}: {
  label: string;
  /** 入力要素の id。ラベルと結ぶ。 */
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  const describedById = htmlFor ? `${htmlFor}-desc` : undefined;
  return (
    <div data-testid="ui-field" style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
      <label htmlFor={htmlFor} style={{ fontSize: font.small, color: color.muted }}>
        {label}
        {required ? (
          <span aria-hidden style={{ color: color.danger, marginLeft: 4 }}>
            *
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <span id={describedById} data-testid="ui-field-error" style={{ fontSize: font.caption, color: color.danger }}>
          {error}
        </span>
      ) : hint ? (
        <span id={describedById} style={{ fontSize: font.caption, opacity: 0.6 }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** 複数 Field を横並びにする行（狭い画面では折り返す）。 */
export function FormRow({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="ui-form-row"
      style={{ display: 'flex', flexWrap: 'wrap', gap: space.md, alignItems: 'flex-start' }}
    >
      {children}
    </div>
  );
}
