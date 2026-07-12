'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { TenantOption } from '@/lib/tenant/tenant-selection';
import { selectTenant } from '@/lib/tenant/select-tenant-action';

/**
 * 対象テナント切り替え UI (issue #80, increment 3)。
 *
 * AdminShell ヘッダの「対象テナント」表示を置き換える。actor の accessibleTenants から
 * 導出した選択可能テナント（options）を出し、選択を server action（selectTenant）で保存する。
 *   - 単一所属（options 1 件）: 固定表示（切り替え不可）。
 *   - developer / 複数所属（2 件以上）: ドロップダウンで切り替え。
 *
 * セキュリティ:
 *   - これは表示・操作対象の切り替え（UX）であり認可ではない。越境拒否と最終認可は
 *     サーバ側（select-tenant-action.ts / 各 API）が actor を正として検証する。
 *   - options は機密・PII を含まない（id / name / slug のみ）。
 */
export function TenantSwitcher({
  options,
  activeTenantId,
}: {
  options: readonly TenantOption[];
  activeTenantId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const first = options[0];
  if (!first) return null;

  const active = options.find((o) => o.id === activeTenantId) ?? first;

  // 単一所属は切り替えできないため固定表示（既存 tenantLabel 表示と等価）。
  if (options.length === 1) {
    return (
      <span
        data-testid="active-tenant"
        style={{
          fontSize: '0.875rem',
          padding: '4px 10px',
          borderRadius: 999,
          background: 'var(--color-surface-2)',
        }}
      >
        対象テナント: <strong>{active.name}</strong>
      </span>
    );
  }

  return (
    <label
      data-testid="tenant-switcher"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.875rem' }}
    >
      <span style={{ opacity: 0.6 }}>対象テナント:</span>
      <select
        aria-label="対象テナントを選択"
        value={active.id}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          if (next === active.id) return;
          startTransition(async () => {
            await selectTenant(next);
            // サーバ側 cookie 更新後に再フェッチして表示を反映する。
            router.refresh();
          });
        }}
        style={{
          fontSize: '0.875rem',
          padding: '4px 10px',
          borderRadius: 999,
          background: 'var(--color-surface-2)',
          color: 'var(--color-text)',
          border: '1px solid var(--color-border-strong)',
        }}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
