/**
 * 階層組織の永続化 (#373 増分 2)。
 *
 * 増分 1 で `src/domain/organization/`（型・階層検証・来訪者ディレクトリ・compat reader）を
 * 純ロジックとして作った。ここはその IO 層で、data backend（memory / dynamodb）へ委譲する
 * （`docs/persistence-design.md`）。判定ロジックは持たない。
 *
 * ## テナント別に持つ（最初から）
 *
 * #419 の残増分で、branding / voice / motions / assets / languages / directory が
 * **単一テナントのストアだった**ことが判明し、fail-closed により 2 つ目以降のテナントが
 * 機能を使えない状態になっていた。**新しいストアで同じ轍を踏まない。**
 * キーの決め方は既存ストアと同じ `tenantScopedStoreKey` に揃える（別方式を増やさない）。
 *
 * ## 既存の Department を壊さない
 *
 * #373 は「既存 `Department`/`staff.departmentId` を無改変のまま段階移行する」方針
 * （増分 1 で compat reader を用意済み）。ここでも既存ストアには触れず、別コレクションに
 * 追加するだけに留める。
 */
import type { OrganizationMembership, OrganizationUnit } from '@/domain/organization/types';
import { membershipStoreId } from '@/domain/organization/membership-key';
import { tenantScopedStoreKey } from '@/domain/tenant/store-key';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';
import { getBackend } from '@/lib/data';

const UNIT_COLLECTION = 'organization-unit';
const MEMBERSHIP_COLLECTION = 'organization-membership';

/** 永続化する所属。`collection` が要求する `id` を合成して持たせる。 */
type StoredMembership = OrganizationMembership & { id: string };

const units = (tenantId: string) =>
  getBackend().collection<OrganizationUnit>(
    tenantScopedStoreKey(UNIT_COLLECTION, tenantId, defaultTenantIdFrom()),
  );

const memberships = (tenantId: string) =>
  getBackend().collection<StoredMembership>(
    tenantScopedStoreKey(MEMBERSHIP_COLLECTION, tenantId, defaultTenantIdFrom()),
  );

export async function listOrganizationUnits(tenantId: string): Promise<OrganizationUnit[]> {
  return units(tenantId).list();
}

export async function getOrganizationUnit(
  tenantId: string,
  id: string,
): Promise<OrganizationUnit | undefined> {
  return units(tenantId).get(id);
}

/**
 * 作成または上書き。**階層の妥当性検証は呼び出し側の責務**
 * （`domain/organization/hierarchy.ts`）。ここで再実装すると判定が 2 箇所に散る。
 */
export async function putOrganizationUnit(tenantId: string, unit: OrganizationUnit): Promise<void> {
  await units(tenantId).put(unit);
}

export async function listOrganizationMemberships(
  tenantId: string,
): Promise<OrganizationMembership[]> {
  const stored = await memberships(tenantId).list();
  // 合成 id は永続化の都合なので、ドメインへ返すときは落とす。
  return stored.map(({ id: _id, ...rest }) => rest);
}

/**
 * 所属を追加または更新する。同じ `staffId` × `organizationId` は 1 件に保たれる
 * （合成キーが同じなので put が置換になる）。
 */
export async function putOrganizationMembership(
  tenantId: string,
  membership: OrganizationMembership,
): Promise<void> {
  await memberships(tenantId).put({
    ...membership,
    id: membershipStoreId(membership.staffId, membership.organizationId),
  });
}

export async function deleteOrganizationMembership(
  tenantId: string,
  staffId: string,
  organizationId: string,
): Promise<void> {
  await memberships(tenantId).remove(membershipStoreId(staffId, organizationId));
}

/** テスト用: 空に戻す。 */
export async function __resetOrganization(
  tenantId: string = defaultTenantIdFrom(),
): Promise<void> {
  await units(tenantId).reset();
  await memberships(tenantId).reset();
}
