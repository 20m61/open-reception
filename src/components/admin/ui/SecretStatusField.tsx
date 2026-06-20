import type { ReactNode } from 'react';
import { color, font, radius, space, SECRET_META, type SecretPresence } from './tokens';

/**
 * 管理画面 共有 シークレット状態表示（視覚のみ） (issue #92, increment 1)。
 *
 * 既存 integrations/SecretStatusField を正準化した **見た目の器**。
 * #92 表示ルール: 機密値そのものは決して受け取らず、状態（登録済み/未設定/要更新）と
 * 最終更新・接続確認などのメタのみを見せる。本コンポーネントは props に value を
 * 持たない（型で禁止）。操作ボタンは `actions` として呼び出し側が差し込む。
 */
export function SecretStatusField({
  name,
  presence,
  updatedLabel,
  actions,
}: {
  /** シークレットの識別名（キー名）。値は含めない。 */
  name: string;
  presence: SecretPresence;
  /** 「最終更新: …」などのメタ表示文字列（任意）。 */
  updatedLabel?: string;
  /** 「更新済みにする」「要更新」等の操作。視覚の器に差し込む。 */
  actions?: ReactNode;
}) {
  const meta = SECRET_META[presence];
  return (
    <div
      data-testid="ui-secret-status-field"
      data-presence={presence}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.sm,
        padding: '10px 12px',
        borderRadius: radius.sm,
        border: `1px solid ${color.surface2}`,
        background: color.surface,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <code style={{ fontWeight: 700 }}>{name}</code>
        <span data-testid="ui-secret-presence" style={{ fontSize: font.small, color: meta.color }}>
          {meta.label}
        </span>
        {updatedLabel ? (
          <span style={{ fontSize: font.caption, opacity: 0.6 }}>{updatedLabel}</span>
        ) : null}
      </div>
      {actions ? <div style={{ display: 'flex', gap: space.xs }}>{actions}</div> : null}
    </div>
  );
}
