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
import {
  listVisitorOrganizations,
  resolveStaffAffiliations,
  toVisitorAffiliations,
} from '@/domain/organization/directory';
import type { KioskDirectory } from '@/lib/data-stores/directory-store';
import { listDepartments, listStaff } from '@/lib/data-stores/directory-store';
import {
  validateOrganizationUnitPatch,
  type OrganizationUnitPatch,
} from '@/domain/organization/update';
import {
  listOrganizationMemberships,
  listOrganizationUnits,
  putOrganizationUnit,
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

  // 所属を staffId で索引する。担当者ごとに全所属を線形走査すると O(担当者 × 所属) になり、
  // 担当者の上限（1000）付近で構成取得の CPU 時間が跳ねる。呼び出し可否とラベルで
  // 同じ索引を使う。
  const scopedMemberships = new Map<string, OrganizationMembership[]>();
  for (const membership of view.memberships) {
    const list = scopedMemberships.get(membership.staffId);
    if (list === undefined) scopedMemberships.set(membership.staffId, [membership]);
    else list.push(membership);
  }
  const callableByStaff = new Map<string, boolean>();
  for (const [staffId, list] of scopedMemberships) {
    callableByStaff.set(
      staffId,
      list.some((m) => m.callable),
    );
  }

  // 所属ラベルは**公開組織の表示名だけ**で構成する。`toVisitorAffiliations` を通した
  // 時点で内部正式名称は型として持てなくなり、非公開・無効な組織はここで落ちる。
  // 同姓同名の識別のためにラベルを出すのであって、その代償に内部組織の存在を
  // 漏らしてよいわけではない（出せる情報が無ければ空のまま）。
  // `AffiliationQuery.now` は ISO 8601 文字列（Date ではない）。
  //
  // ただし **今の時点では `now` はラベルの出力に影響しない** — `affiliationSummaryLabel` は
  // 主所属と兼務しか使わず、期間を持つのは代理担当（acting）だけだから。ここを
  // 「期限切れ代理担当がラベルに出ないこと」で検査しようとしても、常に通る空のテストになる。
  // 代理担当を来訪者面へ出すようにするときに、初めて意味を持つ検査が書ける。
  const now = new Date().toISOString();
  //
  // 渡すのは `visitorUnits`（互換に裏付けられた組織）であって `view.units` ではない。
  // departments 一覧に出ない組織名がラベルにだけ現れると、来訪者は選べない組織名を
  // 目にすることになる。**「departments に出る集合 ⊇ ラベルに出る組織名の集合」**を保つ。
  //
  // `includeAncestors: false` は性能のため。`affiliationSummaryLabel` を options 無しで
  // 呼ぶので祖先は使われない。付けたままだと担当者 × 所属の回数だけ全組織の索引が
  // 作り直され、1000 名規模で構成取得が二桁 ms から三桁 ms へ跳ねる。
  const affiliationFor = (staffId: string): { primary?: string; secondary: string[] } => {
    const visitor = toVisitorAffiliations(
      resolveStaffAffiliations(scopedMemberships.get(staffId) ?? [], visitorUnits, staffId, {
        now,
        scope,
        includeAncestors: false,
      }),
    );
    return {
      ...(visitor.primary === undefined ? {} : { primary: visitor.primary.unit.name }),
      secondary: visitor.secondary.map((a) => a.unit.name),
    };
  };

  return {
    departments: listVisitorOrganizations(visitorUnits, scope).map((o) => ({
      id: o.id,
      name: o.name,
    })),
    // 検索に必要な kana/aliases は含めるが、内部用の mockCallOutcome/available は含めない
    // （既存 `getKioskDirectory` と同じ公開範囲を保つ）。
    staff: inputs.staff
      .filter((s) => s.enabled && (callableByStaff.get(s.id) ?? true))
      .map((s) => ({
        id: s.id,
        displayName: s.displayName,
        kana: s.kana,
        aliases: s.aliases,
        departmentId: s.departmentId,
        available: s.available,
        // **空でも必ず入れる。** キーごと落とすと、画面側が「この経路は出すものが
        // 無いと判断した」と「旧経路なのでキーを持たない」を区別できず、非公開に
        // したはずの所属が部署名として出戻る。空の構造＝「出すものは無い」を明示する。
        affiliation: affiliationFor(s.id),
      })),
  };
}

export type UpdateOrganizationResult =
  | { ok: true; value: OrganizationUnit }
  | { ok: false; error: { code: 'invalid_input' | 'not_found'; message: string } };

/**
 * 組織を編集する (#373 増分 5)。
 *
 * ## 合成ビューから引く（保存済みだけを見ない）
 *
 * 編集対象の大半は**まだ保存されていない互換組織**（`Department` 由来）。保存済みだけを
 * 探すと「一覧に出ているのに編集できない」になる。合成ビューから現在値を取り、
 * patch を当てて丸ごと保存する ＝ **その組織の初回編集が、そのまま新モデルへの載せ替え**になる。
 *
 * ## 全体を保存する理由
 *
 * `putOrganizationUnit` は置換なので、patch だけを保存すると他フィールドが消える。
 * 合成後の値を土台にすることで、旧 UI で編集した名称なども保たれる。
 *
 * `tenantId` は**呼び出し側で解決済みの値**を渡すこと（`resolveAdminTenantId()` 等）。
 */
export async function updateOrganizationUnit(
  scope: OrganizationScope,
  id: string,
  input: unknown,
): Promise<UpdateOrganizationResult> {
  const validated = validateOrganizationUnitPatch(input);
  if (!validated.ok) return validated;

  const view = await getOrganizationView(scope);
  const current = view.units.find((u) => u.id === id);
  // scope 外・存在しない id は同じ `not_found` にする。「在るが見えない」と「無い」を
  // 区別できると、他テナントの組織 id の実在を当てられる。
  if (current === undefined) {
    return { ok: false, error: { code: 'not_found', message: 'organization not found' } };
  }

  const patch: OrganizationUnitPatch = validated.value;
  const next: OrganizationUnit = { ...current, ...patch };
  await putOrganizationUnit(scope.tenantId, next);
  return { ok: true, value: next };
}
