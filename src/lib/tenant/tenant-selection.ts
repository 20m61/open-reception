/**
 * テナント選択（TenantSwitcher）の純粋ロジック (issue #80, increment 3)。
 *
 * actor の accessibleTenants（developer=all / それ以外=所属テナント）から、UI に出す
 * 「選択可能テナント」を導出し、ユーザーが要求したテナント選択をサーバ側で検証する。
 *
 * セキュリティ（重要）:
 *   - テナント選択はあくまで **表示・操作対象の切り替え（UX）** であり、認可ではない。
 *     最終的な認可は引き続き各 API / service（src/domain/tenant/authorization.ts）で actor を
 *     正として検証する（docs/multitenant-design.md §認可）。
 *   - 選択の越境は本モジュールで拒否する: actor がアクセスできないテナントを選択要求しても
 *     resolveActiveTenantId は採用しない（cookie 改竄・URL 直叩き対策の入口検証）。
 *
 * 本モジュールは I/O を持たない純関数のみ。cookie 読み書き等の副作用は呼び出し側
 * （server action / layout）が担う。
 */
import { accessibleTenants, type Actor } from '@/domain/tenant/authorization';
import type { Tenant, TenantId } from '@/domain/tenant/types';

/** TenantSwitcher に渡す選択肢の最小表現（機密・PII は含めない）。 */
export type TenantOption = {
  id: TenantId;
  name: string;
  slug: string;
};

function toOption(t: Tenant): TenantOption {
  return { id: t.id, name: t.name, slug: t.slug };
}

/**
 * actor が選択（=操作対象に）できるテナント一覧を全テナントから絞り込む。
 *   - developer（accessibleTenants=all）: 全テナント。
 *   - それ以外: 所属テナントのみ。
 * 入力 allTenants の順序を保つ。非 active な actor は空（assignments も空になる）。
 */
export function selectableTenants(actor: Actor, allTenants: readonly Tenant[]): TenantOption[] {
  const access = accessibleTenants(actor);
  if (access.scope === 'all') return allTenants.map(toOption);
  const allowed = new Set<TenantId>(access.tenantIds);
  return allTenants.filter((t) => allowed.has(t.id)).map(toOption);
}

/** actor が当該テナントを選択（アクセス）できるか。越境拒否の判定に使う。 */
export function canSelectTenant(actor: Actor, tenantId: TenantId): boolean {
  const access = accessibleTenants(actor);
  if (access.scope === 'all') return true;
  return access.tenantIds.includes(tenantId);
}

/**
 * 要求された選択（cookie 等）を検証し、実際に採用する activeTenantId を決める。
 *   1. requested が選択可能テナントに含まれれば採用。
 *   2. 含まれない（越境・失効・未選択）なら、選択肢の先頭にフォールバック。
 *   3. 選択肢が無ければ undefined（テナント未所属）。
 *
 * requested が越境（権限外）でも例外にせず、安全側（先頭 or undefined）へ倒す。
 * これにより cookie 改竄や旧 cookie 残存があっても他テナントへ越境しない。
 */
export function resolveActiveTenantId(
  actor: Actor,
  allTenants: readonly Tenant[],
  requested?: string | null,
): TenantId | undefined {
  const options = selectableTenants(actor, allTenants);
  const first = options[0];
  if (!first) return undefined;
  if (requested && options.some((o) => o.id === requested)) {
    return requested as TenantId;
  }
  return first.id;
}

/**
 * TenantSwitcher が固定表示か切り替え可能かを判定する。
 * 単一所属（選択肢 1 件）は固定表示、developer / 複数所属（2 件以上）は切り替え可能。
 */
export function isSwitchable(options: readonly TenantOption[]): boolean {
  return options.length > 1;
}
