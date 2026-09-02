import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { color, font, space } from './tokens';

/**
 * 管理画面 共有フォーム部品 (issue #92, increment 1)。
 *
 * `Field` … ラベル + 入力 + 補足/エラーの縦積み。`htmlFor`/`id` を結び、
 *           補足/エラーを `aria-describedby` で入力へ結び付ける。
 * `FormRow` … 複数 Field を横並びにする行コンテナ（密度を上げる）。
 *
 * 入力要素そのものは children として受け取る（select/input/textarea を選ばない）。
 */

/** aria を差し込む対象。`div` 等の wrapper へ付けると読み上げ対象がずれる。 */
const CONTROL_TAGS = new Set(['input', 'select', 'textarea']);

type ControlProps = {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-required'?: boolean | 'true' | 'false';
};

function isControl(node: ReactNode): node is ReactElement<ControlProps> {
  return isValidElement(node) && typeof node.type === 'string' && CONTROL_TAGS.has(node.type);
}

/**
 * children の木を辿り、最初に見つかった入力要素へ aria を差し込む。
 *
 * 🔴 **wrapper には付けない (#892 / 課題 14)。** `Field` は入力を children で受けるので、
 * 呼び出し側が `<div>` で包んでいることがある。木の根へ機械的に付けると
 * 「説明を持つ div」が出来るだけで、入力からは相変わらず辿れない。
 *
 * 呼び出し側が明示した aria は**上書きしない** —— 部品の既定より呼び出し側の意図が強い。
 */
function wireControl(
  node: ReactNode,
  aria: { describedById?: string; invalid: boolean; required: boolean },
): { node: ReactNode; wired: boolean } {
  if (isControl(node)) {
    const props = node.props;
    const next: ControlProps = {};
    if (aria.describedById && props['aria-describedby'] === undefined) {
      next['aria-describedby'] = aria.describedById;
    }
    if (aria.invalid && props['aria-invalid'] === undefined) next['aria-invalid'] = true;
    if (aria.required && props['aria-required'] === undefined) next['aria-required'] = true;
    return { node: cloneElement(node, next), wired: true };
  }

  if (isValidElement<{ children?: ReactNode }>(node) && node.props.children !== undefined) {
    let wired = false;
    const children = Children.map(node.props.children, (child) => {
      if (wired) return child;
      const result = wireControl(child, aria);
      wired = result.wired;
      return result.node;
    });
    return wired ? { node: cloneElement(node, undefined, children), wired } : { node, wired };
  }

  return { node, wired: false };
}

/** children の木から最初の入力要素の `id` を拾う（`htmlFor` 省略時の拠り所）。 */
function findControlId(node: ReactNode): string | undefined {
  if (isControl(node)) return node.props.id;
  if (isValidElement<{ children?: ReactNode }>(node) && node.props.children !== undefined) {
    for (const child of Children.toArray(node.props.children)) {
      const id = findControlId(child);
      if (id) return id;
    }
  }
  return undefined;
}

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
  const description = error ?? hint;
  /*
   * 説明の id は `htmlFor` を第一に、無ければ**入力自身の id** を使う。
   * かつては `htmlFor` が無いと id を振らないまま説明だけを描画しており、
   * 指しようのない説明（＝支援技術からは存在しない説明）が出来ていた。
   */
  const controlId = htmlFor ?? findControlId(children);
  const describedById = description !== undefined && controlId ? `${controlId}-desc` : undefined;

  const { node } = wireControl(children, {
    describedById,
    invalid: error !== undefined,
    required,
  });

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
      {node}
      {error ? (
        <span
          id={describedById}
          data-testid="ui-field-error"
          style={{ fontSize: font.caption, color: color.danger }}
        >
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
