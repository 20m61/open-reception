import type { ReactNode } from 'react';
import { font, space } from './tokens';

/**
 * 管理画面 セクション見出し + 本文 (issue #92, increment 1)。
 *
 * 既存 dashboard/Section の正準。任意で説明文（description）と右肩のアクション
 * （actions: 検索/追加など）を置ける。見出しは段落構造（h2）を保つ。
 */
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-testid="ui-section" style={{ marginBottom: space.lg }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: space.md,
          marginBottom: space.sm,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 style={{ fontSize: font.label, margin: 0 }}>{title}</h2>
          {description ? (
            <span style={{ fontSize: font.small, opacity: 0.65 }}>{description}</span>
          ) : null}
        </div>
        {actions ? <div style={{ display: 'flex', gap: space.xs }}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
