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
import { canSetParent } from '@/domain/organization/hierarchy';
import {
  validateOrganizationUnitPatch,
  type OrganizationUnitPatch,
} from '@/domain/organization/update';
import {
  deleteOrganizationMembership,
  listOrganizationMemberships,
  listOrganizationUnits,
  putOrganizationMembership,
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
async function readOrganizationInputs(
  scope: OrganizationScope,
  options: { toleratePartialRead?: boolean } = {},
) {
  const { tenantId } = scope;
  // 互換元（旧 UI が編集する実体）と保存済み（新 UI が編集する実体）を両方読む。
  // 無効なものも含めて読み、除外は合成規則へ委ねる（ここで先に落とすと AND が効かない）。
  const [departments, staff, stored] = await Promise.all([
    listDepartments(tenantId, true),
    listStaff(tenantId, true),
    readStoredOrganization(tenantId, options.toleratePartialRead === true),
  ]);
  return { departments, staff, ...stored };
}

async function readStoredOrganization(
  tenantId: string,
  tolerate: boolean,
): Promise<{ storedUnits: OrganizationUnit[]; storedMemberships: OrganizationMembership[] }> {
  try {
    const [storedUnits, storedMemberships] = await Promise.all([
      listOrganizationUnits(tenantId),
      listOrganizationMemberships(tenantId),
    ]);
    return { storedUnits, storedMemberships };
  } catch (error) {
    if (!tolerate) throw error;
    // **黙って縮退しない。** 保存済み組織を読めない間は「運用者が隠したはずの組織が
    // 露出している」状態。記録が無ければ誰も気づかないまま放置される。
    console.warn(
      '[organization] 保存済み組織を読めませんでした。互換（部署）由来のみで縮退します。' +
        'この間、来訪者への公開可否・公開表示名・表示順の編集は反映されません。',
      error,
    );
    return { storedUnits: [], storedMemberships: [] };
  }
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
  return buildVisitorDirectory(scope, {});
}

async function buildVisitorDirectory(
  scope: TenantScope,
  options: { toleratePartialRead?: boolean },
): Promise<KioskDirectory> {
  const inputs = await readOrganizationInputs(scope, options);
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

  // 親の付け替えは**他の組織との関係**で可否が決まる（循環・深度上限・tenant/site 境界）。
  // 判定は `canSetParent` に委ね、ここでは結果を HTTP へ写すだけ。
  // 循環を作らせないのは、祖先を辿る処理（`ancestorsOf`）が終わらなくなり、
  // 来訪者画面の描画ごと巻き込むため。
  if (patch.parentId !== undefined) {
    const nextParentId = patch.parentId === null ? undefined : patch.parentId;
    const allowed = canSetParent(view.units, id, nextParentId);
    if (!allowed.ok) {
      return {
        ok: false,
        error: {
          code: 'invalid_input',
          message: `parentId is not allowed: ${allowed.issues.map((i) => i.kind).join(', ')}`,
        },
      };
    }
  }

  // `null`（外す）は `OrganizationUnit.parentId` の `undefined` へ写す。patch を丸ごと
  // 展開すると `null` がそのまま入るので、親だけ明示的に組み立てる。
  const { parentId, ...rest } = patch;
  const next: OrganizationUnit = {
    ...current,
    ...rest,
    ...(parentId === undefined ? {} : { parentId: parentId ?? undefined }),
  };
  await putOrganizationUnit(scope.tenantId, next);
  return { ok: true, value: next };
}

/**
 * 縮退経路（`/api/kiosk/directory`）向けのディレクトリ導出 (#597)。
 *
 * ## なぜ専用の入口があるか
 *
 * この経路は `/api/configuration/effective` が落ちたときの逃げ道。**受付を止めないことが
 * 最優先**なので、保存済み組織を読めなくても互換（部署）由来だけで応答を返す。
 * `getVisitorDirectory` と同じにすると、組織コレクションの読み失敗で実効構成も縮退経路も
 * 同時に落ち、来訪者が誰も選べない行き止まりになる。
 *
 * ## 残る fail-open
 *
 * 保存済み組織を読めない間は、運用者が「来訪者に出さない」と設定した組織が**出る**。
 * そこで隠し続けようとすると「部署が 1 つも出ない受付端末」になり受付そのものが止まるため、
 * 可用性を採る。**ゼロにはできない**が、従来（縮退中は常に編集を無視）に比べて
 * fail-open の範囲は「組織の読みが失敗したときだけ」へ狭まる。縮退したことは必ずログに残す。
 */
export async function getVisitorDirectoryForFallback(scope: TenantScope): Promise<KioskDirectory> {
  return buildVisitorDirectory(scope, { toleratePartialRead: true });
}

export type MembershipResult =
  | { ok: true }
  | { ok: false; error: { code: 'invalid_input' | 'not_found'; message: string } };

/**
 * 兼務を追加する (#373 増分 8)。
 *
 * ## 主所属は触らない
 *
 * 主所属の真実源は `staff.departmentId`（既存の担当者管理が編集する）。ここで主所属も
 * 持てるようにすると真実源が二重になり、「どちらが正か」を毎回考えることになる。
 * 主所属と同じ組織を兼務として渡されたら拒否する。
 *
 * ## 代理担当は扱わない
 *
 * 来訪者面に出さない決定（(A)）により消費者が無い。生産者だけ作っても確かめようがないので、
 * #374 の RoutingPolicy が消費者になった時点で足す。
 */
export async function addSecondaryMembership(
  scope: OrganizationScope,
  staffId: string,
  organizationId: string,
): Promise<MembershipResult> {
  const inputs = await readOrganizationInputs(scope);
  const staff = inputs.staff.find((s) => s.id === staffId);
  if (staff === undefined) {
    return { ok: false, error: { code: 'not_found', message: 'staff not found' } };
  }
  // scope 外・存在しない組織は同じ `not_found` にする（他テナントの id の実在を漏らさない）。
  const view = composeOrganizationView(inputs, scope);
  const unit = view.units.find((u) => u.id === organizationId);
  if (unit === undefined) {
    return { ok: false, error: { code: 'not_found', message: 'organization not found' } };
  }
  if (staff.departmentId === organizationId) {
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'already the primary organization' },
    };
  }

  // 同じ組み合わせは `membershipStoreId` が同じキーになるので、二重追加は上書きになる。
  await putOrganizationMembership(scope.tenantId, {
    staffId,
    organizationId,
    relation: 'secondary',
    publicInDirectory: true,
    callable: true,
  });
  return { ok: true };
}

/** 兼務を外す。主所属は対象外（`staff.departmentId` を編集すること）。 */
export async function removeSecondaryMembership(
  scope: OrganizationScope,
  staffId: string,
  organizationId: string,
): Promise<MembershipResult> {
  const inputs = await readOrganizationInputs(scope);
  const staff = inputs.staff.find((s) => s.id === staffId);
  if (staff === undefined) {
    return { ok: false, error: { code: 'not_found', message: 'staff not found' } };
  }
  if (staff.departmentId === organizationId) {
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'primary organization is not a secondary' },
    };
  }
  await deleteOrganizationMembership(scope.tenantId, staffId, organizationId);
  return { ok: true };
}
