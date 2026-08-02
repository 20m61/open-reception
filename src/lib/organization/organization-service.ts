/**
 * 階層組織の合成ビュー (#373 増分 3 = Directory API 配線)。
 *
 * 既存の `Department` / `staff.departmentId`（互換）と、新モデルの保存済み組織・所属を
 * **合成して 1 つのビューにする**のがここの責務。判定・合成規則は
 * `domain/organization/compat.ts` の純関数が持ち、ここは IO の取り回しだけを行う。
 *
 * ## なぜ合成するのか
 *
 * #373 は「既存の部署管理を壊さず段階移行する」方針。旧 UI で部署を編集しても、新 UI で
 * 階層を編集しても、**来訪者から見えるディレクトリは 1 つ**でなければならない。
 * 片方だけを正とすると、移行期に「部署を閉じたのに来訪者から呼べる」ような食い違いが出る。
 *
 * ## fail-closed の合成
 *
 * 無効化・非公開は**どちらの UI から閉じても効く**（AND）。名称・階層・表示順は新 UI が
 * 所有する編集結果なので保存済みが勝つ。この規則は `mergeOrganizationUnits` /
 * `mergeOrganizationMemberships` に書いてあり、ここでは選択しない。
 */
import {
  mergeOrganizationMemberships,
  mergeOrganizationUnits,
  readOrganizationCompat,
} from '@/domain/organization/compat';
import type {
  OrganizationMembership,
  OrganizationScope,
  OrganizationUnit,
} from '@/domain/organization/types';
import { listDepartments, listStaff } from '@/lib/data-stores/directory-store';
import {
  listOrganizationMemberships,
  listOrganizationUnits,
} from './organization-repository';

export type OrganizationView = {
  units: OrganizationUnit[];
  memberships: OrganizationMembership[];
  /**
   * 部署に紐づかない（＝互換組織へ解決できない）担当者。
   *
   * **黙って捨てない。** 移行期にここが増えるのは「新モデルへ載せ替えるべき担当者が
   * 残っている」という信号で、握り潰すと来訪者から呼べない担当者が静かに生まれる。
   */
  unresolvedStaffIds: string[];
};

/**
 * 指定スコープの組織ビューを返す。
 *
 * `tenantId` は**呼び出し側で解決済みの値**を渡すこと（`resolveAdminTenantId()` 等）。
 * リクエスト由来の値をそのまま渡さない（越境参照を組ませない）。
 */
export async function getOrganizationView(scope: OrganizationScope): Promise<OrganizationView> {
  const { tenantId } = scope;
  // 互換元（旧 UI が編集する実体）と保存済み（新 UI が編集する実体）を両方読む。
  // 無効なものも含めて読み、除外は合成規則へ委ねる（ここで先に落とすと AND が効かない）。
  const [departments, staff, storedUnits, storedMemberships] = await Promise.all([
    listDepartments(tenantId, true),
    listStaff(tenantId, true),
    listOrganizationUnits(tenantId),
    listOrganizationMemberships(tenantId),
  ]);

  const compat = readOrganizationCompat({ departments, staff }, scope);
  return {
    units: mergeOrganizationUnits(compat.units, storedUnits, scope),
    memberships: mergeOrganizationMemberships(compat.memberships, storedMemberships),
    unresolvedStaffIds: compat.unresolvedStaffIds,
  };
}
