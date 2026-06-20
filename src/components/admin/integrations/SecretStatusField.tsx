'use client';

import type { SecretStatus } from '@/domain/security/integration-status';

/**
 * シークレットの **状態のみ** を表示するフィールド (issue #93)。
 * 値・private key は受け取らず描画もしない（型に value が存在しない）。
 * 表示するのは設定済み/未設定・最終更新日時・更新者・health のみ。
 */
export function SecretStatusField({
  status,
  canManage,
  busy,
  onMarkUpdated,
  onClear,
}: {
  status: SecretStatus;
  canManage: boolean;
  busy: boolean;
  onMarkUpdated: (key: SecretStatus['key']) => void;
  onClear: (key: SecretStatus['key']) => void;
}) {
  const configured = status.presence === 'configured';
  return (
    <div
      data-testid={`secret-${status.key}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--color-surface-2)',
        background: 'var(--color-surface)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <code style={{ fontWeight: 700 }}>{status.key}</code>
        <span data-testid={`secret-${status.key}-presence`} style={{ fontSize: '0.85rem', opacity: 0.85 }}>
          {configured ? '設定済み' : '未設定'}
          {status.health === 'needs_rotation' ? '（要更新）' : ''}
        </span>
        {status.updatedAt ? (
          <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>
            最終更新: {new Date(status.updatedAt).toLocaleString('ja-JP')}
            {status.updatedBy ? `（${status.updatedBy}）` : ''}
          </span>
        ) : null}
      </div>
      {canManage ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            data-testid={`secret-${status.key}-mark`}
            onClick={() => onMarkUpdated(status.key)}
            disabled={busy}
            style={ghost}
          >
            更新済みにする
          </button>
          <button
            type="button"
            data-testid={`secret-${status.key}-clear`}
            onClick={() => onClear(status.key)}
            disabled={busy}
            style={dangerGhost}
          >
            要更新
          </button>
        </div>
      ) : null}
    </div>
  );
}

const ghost: React.CSSProperties = {
  minHeight: 34,
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  cursor: 'pointer',
};
const dangerGhost: React.CSSProperties = {
  ...ghost,
  borderColor: 'var(--color-danger)',
  color: 'var(--color-danger)',
};
