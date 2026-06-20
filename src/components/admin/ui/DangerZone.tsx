import type { ReactNode } from 'react';
import { color, font, radius, space, TONE_SOFT_BG } from './tokens';

/**
 * 管理画面 共有 危険操作セクション（視覚の器） (issue #92, increment 1)。
 *
 * #92 表示ルール: 破壊的操作は通常フォームに紛れ込ませず、明確に分離して「怖く」見せる。
 * 本コンポーネントは **レイアウト/見た目だけ** を担う器であり、確認導線や理由入力などの
 * 挙動（confirm / 二段確認 / 監査連携）は #91 の `components/admin/danger/**` の責務。
 * ここには破壊的アクションの UI（Button variant="danger" など）を children として置く。
 */
export function DangerZone({
  title = '危険な操作',
  description,
  children,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-testid="ui-danger-zone"
      style={{
        border: `1px solid ${color.danger}`,
        background: TONE_SOFT_BG.danger,
        borderRadius: radius.md,
        padding: space.lg,
        display: 'flex',
        flexDirection: 'column',
        gap: space.sm,
      }}
    >
      <h3 style={{ margin: 0, color: color.danger, fontSize: font.label }}>{title}</h3>
      {description ? (
        <p style={{ margin: 0, fontSize: font.small, opacity: 0.85 }}>{description}</p>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm, marginTop: space.xs }}>
        {children}
      </div>
    </section>
  );
}
