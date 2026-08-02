/**
 * 所属（`OrganizationMembership`）の永続化キー (#373 増分 2)。
 *
 * ## なぜ要るか
 *
 * 所属は `staffId` × `organizationId` の**複合キー**で、単独の `id` を持たない。
 * 一方 data backend の `collection<T extends { id: string }>` は `id` を要求するので、
 * 保存時に合成する必要がある。
 *
 * ## 区切り文字をそのまま連結しない
 *
 * `${staffId}:${organizationId}` と素朴に繋ぐと、id に区切り文字を含む値で**別の組へ化ける**
 * （`a:b` + `c` と `a` + `b:c` が同じキーになる）。所属は「誰がどの組織に属するか」＝
 * 呼び出し可否の根拠なので、化けると**別人の所属として扱われる**。
 * `tenantScopedStoreKey`（#419）と同じ理由で encode してから連結する。
 */

const SEPARATOR = ':';

export function membershipStoreId(staffId: string, organizationId: string): string {
  if (staffId === '') throw new Error('membershipStoreId: staffId is empty');
  if (organizationId === '') throw new Error('membershipStoreId: organizationId is empty');
  return `${encodeURIComponent(staffId)}${SEPARATOR}${encodeURIComponent(organizationId)}`;
}
