/**
 * 選択中テナント（active tenant）のサーバ側導線 (issue #80, increment 3)。
 *
 * TenantSwitcher の選択状態を cookie で保持し、read 系画面が「いまどのテナントを見ているか」を
 * 解決するための薄い非純粋ラッパ。判定ロジックは純関数（./tenant-selection.ts）へ委譲する。
 *
 * セキュリティ（重要）:
 *   - cookie の値はそのまま信用しない。resolveActiveTenant が actor の accessibleTenants で
 *     **必ず検証**し、越境（権限外テナント）なら採用せず安全側（選択肢の先頭）へ倒す。
 *   - テナント選択は表示・操作対象の切り替え（UX）であって認可ではない。最終的な認可は
 *     引き続き各 API / service が actor を正として検証する（docs/multitenant-design.md §認可）。
 */
import { cookies } from 'next/headers';
import type { Actor } from '@/domain/tenant/authorization';
import type { Tenant, TenantId } from '@/domain/tenant/types';
import { getTenantStore } from './store';
import {
  resolveActiveTenantId,
  selectableTenants,
  type TenantOption,
} from './tenant-selection';

/** 選択中テナントを保持する cookie 名。HttpOnly・SameSite=Lax で保存する。 */
export const ACTIVE_TENANT_COOKIE = 'or_active_tenant';

export type ActiveTenantView = {
  /** UI に出す選択可能テナント（機密・PII なし）。 */
  options: TenantOption[];
  /** 検証済みの選択中テナント。未所属なら undefined。 */
  activeTenantId: TenantId | undefined;
  /** 選択中テナントの実体（一覧表示や対象テナント表示に使う）。 */
  active: Tenant | undefined;
};

/**
 * actor と全テナント・cookie から、検証済みの選択中テナントと選択肢を解決する。
 * 越境した cookie 値は採用しない（resolveActiveTenantId が安全側へ倒す）。
 */
export async function resolveActiveTenant(actor: Actor): Promise<ActiveTenantView> {
  const allTenants = await getTenantStore().tenants.listTenants();
  const options = selectableTenants(actor, allTenants);
  const jar = await cookies();
  const requested = jar.get(ACTIVE_TENANT_COOKIE)?.value;
  const activeTenantId = resolveActiveTenantId(actor, allTenants, requested);
  const active = activeTenantId ? allTenants.find((t) => t.id === activeTenantId) : undefined;
  return { options, activeTenantId, active };
}
