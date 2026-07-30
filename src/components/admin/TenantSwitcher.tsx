'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { TenantOption } from '@/lib/tenant/tenant-selection';
import { selectTenant } from '@/lib/tenant/select-tenant-action';
import { TenantContextChip, TenantSelect } from './TenantContextView';

/**
 * 対象テナント切り替え UI (issue #80, increment 3)。
 *
 * AdminShell ヘッダの「対象テナント」表示を置き換える。actor の accessibleTenants から
 * 導出した選択可能テナント（options）を出し、選択を server action（selectTenant）で保存する。
 *   - 単一所属（options 1 件）: 固定表示（切り替え不可）。
 *   - developer / 複数所属（2 件以上）: ドロップダウンで切り替え。
 *
 * **「全テナント横断」は出さない。** admin では常にちょうど 1 つのテナントが対象で、
 * 未選択という状態が無い（platform 側の切替とはそこが違う。`TenantContextView` の表を参照）。
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

  // 単一所属は切り替えできないため固定表示（AdminShell の tenantLabel 表示と同一部品）。
  if (options.length === 1) {
    return <TenantContextChip tenantName={active.name} />;
  }

  return (
    <TenantSelect
      // platform 側と別の testid にする。統合前は両方 `tenant-switcher` で、意味の違う 2 つに
      // 同じ selector が当たり得た（#423）。
      testId="admin-tenant-switcher"
      options={options}
      value={active.id}
      disabled={pending}
      onSelect={(next) => {
        // admin に未選択は無いので null は来ない。同じ選択なら何もしない。
        if (next === null || next === active.id) return;
        startTransition(async () => {
          await selectTenant(next);
          // サーバ側 cookie 更新後に再フェッチして表示を反映する。
          router.refresh();
        });
      }}
    />
  );
}
