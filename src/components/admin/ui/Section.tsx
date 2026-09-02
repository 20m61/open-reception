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
  headingLevel = 'h2',
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** ページ根に使うときは 'h1'。既定は節としての 'h2'。 */
  headingLevel?: 'h1' | 'h2';
}) {
  const Heading = headingLevel;
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
          {/*
            ページ根に使う画面では `h1` を出せるようにする (#890 / 課題 16)。
            既定は従来どおり `h2`（節として使う用途がほとんど）。`h2` 固定だったため、
            この部品をページ根に使う 4 画面は**見出しツリーが h2 から始まっていた** ——
            スクリーンリーダーの見出しジャンプで「この画面は何か」に辿り着けない。
          */}
          <Heading style={{ fontSize: font.label, margin: 0 }}>{title}</Heading>
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
