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
import { listVisitorOrganizations } from '@/domain/organization/directory';
import type { KioskDirectory } from '@/lib/data-stores/directory-store';
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
  return composeOrganizationView(await readOrganizationInputs(scope), scope);
}

/**
 * 合成の材料をまとめて読む。
 *
 * **1 回の読みを使い回す。** 同じ `listStaff` を 2 度読むと、往復が増えるだけでなく
 * 2 つの読みの**間に管理者が担当者を無効化すると、ビューと返却内容が食い違う**窓ができる。
 * 担当者は一番大きいパーティションなので、重複読みは起動レイテンシにも効く。
 */
async function readOrganizationInputs(scope: OrganizationScope) {
  const { tenantId } = scope;
  // 互換元（旧 UI が編集する実体）と保存済み（新 UI が編集する実体）を両方読む。
  // 無効なものも含めて読み、除外は合成規則へ委ねる（ここで先に落とすと AND が効かない）。
  const [departments, staff, storedUnits, storedMemberships] = await Promise.all([
    listDepartments(tenantId, true),
    listStaff(tenantId, true),
    listOrganizationUnits(tenantId),
    listOrganizationMemberships(tenantId),
  ]);
  return { departments, staff, storedUnits, storedMemberships };
}

function composeOrganizationView(
  inputs: Awaited<ReturnType<typeof readOrganizationInputs>>,
  scope: OrganizationScope,
): OrganizationView {
  const { departments, staff, storedUnits, storedMemberships } = inputs;
  const compat = readOrganizationCompat({ departments, staff }, scope);
  return {
    units: mergeOrganizationUnits(compat.units, storedUnits, scope),
    memberships: mergeOrganizationMemberships(compat.memberships, storedMemberships),
    unresolvedStaffIds: compat.unresolvedStaffIds,
  };
}

/** テナント全体スコープ。サイト別は担当者側の絞り込みと同時に入れる（下記参照）。 */
type TenantScope = Extract<OrganizationScope, { kind: 'tenant' }>;

/**
 * 来訪者向けディレクトリを組織モデルから導出する (#373 増分 4)。
 *
 * ## 呼び出し可否は「組織の有効/無効」に波及させない（規則 A・2026-08-02 ユーザー判断）
 *
 * 現行の `getKioskDirectory` は担当者を `staff.enabled` **だけ**で絞っており、所属部署が
 * 無効でも担当者個人は呼べる（`departments[]` に出ないだけ）。組織モデルへ切り替えるときに
 * `unit.enabled` を担当者へ波及させると、**いま到達できている担当者が到達できなくなる**。
 * これは J-OR-01 / J-OR-02 の成功条件（担当者へ到達できる）に直結するため、
 * **後方互換を採る**。「部署は閉じたが人は在席」という運用にも沿う。
 *
 * ## ただし「所属の callable」は効く
 *
 * 規則 A は *組織の* 有効/無効を波及させないという判断であって、運用者が所属単位で明示した
 * 「この人は呼ばせない」まで無効化してよいという意味ではない。所属を 1 件以上持ち、その
 * **全てが `callable: false`** の担当者は落とす。所属を持たない担当者は従来どおり残すので、
 * 規則 A（無効組織の担当者は呼べる）は保たれる。`mergeOrganizationMemberships` の AND は
 * ここで初めて来訪者面へ届く。
 *
 * ## 来訪者へ出す組織は「互換に裏付けられたもの」だけ
 *
 * `Department` 実体を持たない保存済み組織は、`validateStaffInput` が `departmentId` を
 * Department id にしか向けさせないため **原理的に担当者が 0 人**。それを来訪者へ出すと、
 * タップ →（mock adapter が無条件 connected を返し）「おつなぎしています」まで進んで
 * **誰も来ない**。失敗が失敗として見えない最悪の形なので、取次先を決める RoutingPolicy
 * (#374) が入るまで出さない。
 */
export async function getVisitorDirectory(scope: TenantScope): Promise<KioskDirectory> {
  const inputs = await readOrganizationInputs(scope);
  const view = composeOrganizationView(inputs, scope);

  // 互換（Department 実体）に裏付けられた組織だけを来訪者へ出す。
  const compatBackedIds = new Set(inputs.departments.map((d) => d.id));
  const visitorUnits = view.units.filter((u) => compatBackedIds.has(u.id));

  const membershipsByStaff = new Map<string, boolean>();
  for (const membership of view.memberships) {
    membershipsByStaff.set(
      membership.staffId,
      (membershipsByStaff.get(membership.staffId) ?? false) || membership.callable,
    );
  }

  return {
    departments: listVisitorOrganizations(visitorUnits, scope).map((o) => ({
      id: o.id,
      name: o.name,
    })),
    // 検索に必要な kana/aliases は含めるが、内部用の mockCallOutcome/available は含めない
    // （既存 `getKioskDirectory` と同じ公開範囲を保つ）。
    staff: inputs.staff
      .filter((s) => s.enabled && (membershipsByStaff.get(s.id) ?? true))
      .map((s) => ({
        id: s.id,
        displayName: s.displayName,
        kana: s.kana,
        aliases: s.aliases,
        departmentId: s.departmentId,
        available: s.available,
      })),
  };
}
