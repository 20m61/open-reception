import type { ReactNode } from 'react';

/** ダッシュボードのセクション見出し + グリッド枠 (issue #86, increment 1)。 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 'var(--space-lg, 24px)' }}>
      <h2 style={{ fontSize: '1.1rem', margin: '0 0 12px' }}>{title}</h2>
      {children}
    </section>
  );
}

/** レスポンシブなカードグリッド。 */
export function CardGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}
