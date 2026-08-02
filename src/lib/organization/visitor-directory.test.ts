import { beforeEach, describe, expect, it } from 'vitest';
import { getVisitorDirectory } from './organization-service';
import {
  __resetOrganization,
  putOrganizationMembership,
  putOrganizationUnit,
} from './organization-repository';
import {
  __resetDirectory,
  createDepartment,
  createStaff,
  getKioskDirectory,
  updateDepartment,
} from '@/lib/data-stores/directory-store';
import { getOrganizationView } from './organization-service';
import type { OrganizationScope } from '@/domain/organization/types';

const T = 'internal';
const SCOPE: OrganizationScope = { kind: 'tenant', tenantId: T };

beforeEach(async () => {
  await __resetDirectory(T);
  await __resetOrganization(T);
});

/**
 * 来訪者向けディレクトリを組織モデルから導出する (#373 増分 4)。
 *
 * ## ここで固定したい判断（規則 A・2026-08-02 ユーザー判断）
 *
 * **無効な組織に所属する担当者は、来訪者から呼べるまま。** 現行の `getKioskDirectory` が
 * 担当者を `staff.enabled` だけで絞っている挙動をそのまま保つ。組織の有効/無効を担当者へ
 * 波及させると、**いま到達できている担当者が到達できなくなる**（J-OR-01 / J-OR-02 の
 * 成功条件＝担当者へ到達できる、に直結する退行）。
 *
 * この規則は明文化しないと簡単に失われる。「組織が無効なら中の人も無効だろう」は直感的に
 * 正しく見えるので、**将来のリファクタで善意から入り込む**。テストで固定する。
 */
describe('getVisitorDirectory (#373 増分 4)', () => {
  it('保存済み組織が無い間は、現行の getKioskDirectory と同じ結果になる（順序込み）', async () => {
    // **複数件で並べる。** 1 件だと順序の食い違いを検出できない。来訪者の画面は
    // この配列順にそのまま並ぶので、順序が変わるのは見た目の変更そのもの。
    for (const name of ['総務部', '営業部', '技術部']) {
      const created = await createDepartment(T, { name });
      if (!created.ok) throw new Error('fixture failed');
    }
    const dept = await createDepartment(T, { name: '広報部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const derived = await getVisitorDirectory(SCOPE);
    const current = await getKioskDirectory(T);

    // 段階移行の前提: 新モデルへ何も保存していない状態では**見えるものが変わらない**。
    expect(derived.departments).toEqual(current.departments);
    // `affiliation` だけは新規追加（上位互換）。旧経路は組織モデルを読まないので
    // 持たない。それ以外のフィールドが 1 つでも変わったら移行の前提が崩れている。
    expect(derived.staff.map(({ affiliation: _affiliation, ...rest }) => rest)).toEqual(
      current.staff,
    );
  });

  /**
   * 追加は**上位互換**であること。旧経路の消費者（縮退時の `/api/kiosk/directory`）は
   * このキーを持たないので、必須として扱われていないことを固定する。
   */
  it('affiliation は追加フィールドで、旧経路の形は壊さない', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const current = await getKioskDirectory(T);
    expect(current.staff.find((s) => s.id === staff.value.id)).not.toHaveProperty('affiliation');
  });

  /**
   * **規則 A の本体。** ここが落ちるということは、組織の無効化が担当者の呼び出し可否へ
   * 波及したということ。受付完遂に直結するので、意図的な仕様変更でない限り実装側を直す。
   */
  it('部署を無効化しても、その部署の担当者は呼べるまま残る', async () => {
    const dept = await createDepartment(T, { name: '総務部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '鈴木 花子', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    await updateDepartment(T, dept.value.id, { enabled: false });

    const directory = await getVisitorDirectory(SCOPE);

    // 組織一覧からは消える（来訪者は「総務部」を選べない）。
    expect(directory.departments.some((d) => d.id === dept.value.id)).toBe(false);
    // だが担当者は名前で呼べる。
    expect(directory.staff.some((s) => s.id === staff.value.id)).toBe(true);
  });

  it('担当者自身を無効化したら呼べなくなる（絞り込みの根拠は staff.enabled だけ）', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '佐藤 次郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const { updateStaff } = await import('@/lib/data-stores/directory-store');
    await updateStaff(T, staff.value.id, { enabled: false });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.staff.some((s) => s.id === staff.value.id)).toBe(false);
  });

  /**
   * 新 UI 側の編集（表示名・非公開）は来訪者向けの組織一覧に効く。ここが効かないと
   * 「新 UI で直したのに来訪者の画面が変わらない」＝消費者ゼロの契約になる。
   */
  it('保存済みの公開表示名が来訪者向けの組織名に反映される', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const unit = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    if (unit === undefined) throw new Error('fixture failed');

    await putOrganizationUnit(T, { ...unit, publicDisplayName: '営業（お客さま窓口）' });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.departments.find((d) => d.id === dept.value.id)?.name).toBe(
      '営業（お客さま窓口）',
    );
  });

  it('非公開にした組織は来訪者向けの一覧に出ない', async () => {
    const dept = await createDepartment(T, { name: '内部監査室' });
    if (!dept.ok) throw new Error('fixture failed');
    const unit = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    if (unit === undefined) throw new Error('fixture failed');

    await putOrganizationUnit(T, { ...unit, publicInDirectory: false });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.departments.some((d) => d.id === dept.value.id)).toBe(false);
  });

  it('別テナントの組織・担当者は混ざらない', async () => {
    await __resetDirectory('acme');
    await __resetOrganization('acme');
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const other = await getVisitorDirectory({ kind: 'tenant', tenantId: 'acme' });
    expect(other.departments.some((d) => d.id === dept.value.id)).toBe(false);
    // **担当者も検査する。** 組織だけ絞られて人が絞られない漏れ方は気づきにくい。
    expect(other.staff.some((s) => s.id === staff.value.id)).toBe(false);
  });
});

/**
 * 保存済み組織が**在る**状態の振る舞い。移行前（保存済みゼロ）の等価性だけを固定しても、
 * 組織編集 UI が入った瞬間に来訪者面へ出るものは何も守られない。
 */
describe('getVisitorDirectory / 保存済み組織が在るとき', () => {
  /**
   * 規則 A は *組織の* 有効/無効を波及させない判断であって、運用者が所属単位で明示した
   * 「呼ばせない」まで無効化してよいという意味ではない。ここが効かないと
   * `mergeOrganizationMemberships` の AND は来訪者面へ永遠に届かない。
   */
  it('所属を全て callable:false にした担当者は呼べなくなる', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const membership = (await getOrganizationView(SCOPE)).memberships.find(
      (m) => m.staffId === staff.value.id,
    );
    if (membership === undefined) throw new Error('fixture failed');
    await putOrganizationMembership(T, { ...membership, callable: false });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.staff.some((s) => s.id === staff.value.id)).toBe(false);
  });

  /** 兼務のうち 1 件でも呼べるなら呼べる（片方を閉じただけで到達不能にしない）。 */
  it('所属が 1 件でも callable なら呼べるまま', async () => {
    const a = await createDepartment(T, { name: '営業部' });
    const b = await createDepartment(T, { name: '技術部' });
    if (!a.ok || !b.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: a.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const primary = (await getOrganizationView(SCOPE)).memberships.find(
      (m) => m.staffId === staff.value.id,
    );
    if (primary === undefined) throw new Error('fixture failed');
    await putOrganizationMembership(T, { ...primary, callable: false });
    await putOrganizationMembership(T, {
      staffId: staff.value.id,
      organizationId: b.value.id,
      relation: 'secondary',
      publicInDirectory: true,
      callable: true,
    });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.staff.some((s) => s.id === staff.value.id)).toBe(true);
  });

  /**
   * `Department` 実体を持たない組織には、`validateStaffInput` の制約により**担当者を
   * 原理的に紐づけられない**。出すと「タップ →『おつなぎしています』→ 誰も来ない」に
   * なる（失敗が失敗として見えない）。取次先を決める #374 が入るまで出さない。
   */
  it('Department 実体を持たない保存済み組織は来訪者へ出さない', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const seed = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    if (seed === undefined) throw new Error('fixture failed');

    await putOrganizationUnit(T, {
      ...seed,
      id: 'org-standalone',
      officialName: '新設室',
      publicDisplayName: '新設室',
      enabled: true,
      publicInDirectory: true,
    });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.departments.some((d) => d.id === 'org-standalone')).toBe(false);
    // 既存の部署は影響を受けない。
    expect(directory.departments.some((d) => d.id === dept.value.id)).toBe(true);
  });

  /** 運用者が新 UI で並べ替えた意図が来訪者の画面順に効かないと、順序を持つ意味が無い。 */
  it('保存済みの displayOrder が来訪者の並び順に効く', async () => {
    const first = await createDepartment(T, { name: '営業部' });
    const second = await createDepartment(T, { name: '技術部' });
    if (!first.ok || !second.ok) throw new Error('fixture failed');

    const view = await getOrganizationView(SCOPE);
    const unit = view.units.find((u) => u.id === second.value.id);
    if (unit === undefined) throw new Error('fixture failed');
    await putOrganizationUnit(T, { ...unit, displayOrder: -1 });

    const directory = await getVisitorDirectory(SCOPE);
    const ids = directory.departments.map((d) => d.id);
    expect(ids.indexOf(second.value.id)).toBeLessThan(ids.indexOf(first.value.id));
  });
});

/**
 * 同姓同名の候補を識別するための所属ラベル (#373「同姓同名候補へ主所属・兼務を表示する」)。
 *
 * `affiliationSummaryLabel` は実装済みだったが**消費者がテストだけ**で、来訪者の画面には
 * 何も出ていなかった。候補カードは `departments.find(d => d.id === s.departmentId)?.name` で
 * 部署名を引いており、兼務は表現できず、組織が一覧に出ない場合は黙って空欄になる。
 */
describe('getVisitorDirectory / 所属ラベル', () => {
  it('主所属だけなら組織名がそのまま出る', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.staff.find((s) => s.id === staff.value.id)?.affiliation).toEqual({
      primary: '営業部',
      secondary: [],
    });
  });

  it('兼務があれば併記される（同姓同名の識別に効く情報を落とさない）', async () => {
    const main = await createDepartment(T, { name: '営業部' });
    const also = await createDepartment(T, { name: '技術部' });
    if (!main.ok || !also.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: main.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    await putOrganizationMembership(T, {
      staffId: staff.value.id,
      organizationId: also.value.id,
      relation: 'secondary',
      publicInDirectory: true,
      callable: true,
    });

    const directory = await getVisitorDirectory(SCOPE);
    // **構造で返す**（整形は locale を知るクライアント側）。
    expect(directory.staff.find((s) => s.id === staff.value.id)?.affiliation).toEqual({
      primary: '営業部',
      secondary: ['技術部'],
    });
  });

  /**
   * **非公開組織の名前は来訪者へ出さない。** ラベルは同姓同名の区別のためにあるが、
   * その代償に内部組織の存在と名称を漏らしてよいわけではない。出せる情報が無いときは
   * 空にする（規則 A により、この担当者自身は呼べるまま残る）。
   */
  it('非公開組織にしか所属しない担当者のラベルは空（内部組織名を漏らさない）', async () => {
    const dept = await createDepartment(T, { name: '内部監査室' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '佐藤 次郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const unit = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    if (unit === undefined) throw new Error('fixture failed');
    await putOrganizationUnit(T, { ...unit, publicInDirectory: false });

    const directory = await getVisitorDirectory(SCOPE);
    const entry = directory.staff.find((s) => s.id === staff.value.id);
    // 担当者自身は呼べる（規則 A）。
    expect(entry).toBeDefined();
    // **空の構造であってキー欠落ではない。** 欠落させると画面側が旧経路と誤認して
    // 部署名を出し戻す（非公開にしたはずの所属が出る）。
    expect(entry?.affiliation).toEqual({ secondary: [] });
    // 組織名が別経路で紛れ込んでいないことも見る。
    expect(JSON.stringify(directory)).not.toContain('内部監査室');
  });
});

describe('getVisitorDirectory / 所属ラベルの露出範囲', () => {
  /**
   * 運用者が所属単位で「来訪者に出さない」と決めた場合。組織自体は公開・有効なので、
   * ラベル生成が落とさなければ組織名がそのまま出る。データ層で空文字になることと、
   * 画面がそれを部署名で埋め戻さないこと（`staffAffiliationText`）の両方が要る。
   */
  it('所属を非公開にしたらラベルは空になる', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const membership = (await getOrganizationView(SCOPE)).memberships.find(
      (m) => m.staffId === staff.value.id,
    );
    if (membership === undefined) throw new Error('fixture failed');
    await putOrganizationMembership(T, { ...membership, publicInDirectory: false });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.staff.find((s) => s.id === staff.value.id)?.affiliation).toEqual({
      secondary: [],
    });
  });

  /**
   * **不変条件: departments に出る組織名 ⊇ ラベルに出る組織名。**
   * ラベルにだけ現れる組織は、来訪者が目にしても選べない。#588 で決めた
   * 「来訪者へ出す組織は Department 実体に裏付けられたものだけ」が、
   * departments 側だけで守られてラベル側で破られていた。
   */
  it('departments に出ない組織名はラベルにも出ない', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const seed = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    if (seed === undefined) throw new Error('fixture failed');
    await putOrganizationUnit(T, {
      ...seed,
      id: 'org-standalone',
      officialName: '特命プロジェクト室',
      publicDisplayName: '特命プロジェクト室',
      enabled: true,
      publicInDirectory: true,
    });
    await putOrganizationMembership(T, {
      staffId: staff.value.id,
      organizationId: 'org-standalone',
      relation: 'secondary',
      publicInDirectory: true,
      callable: true,
    });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.departments.some((d) => d.name === '特命プロジェクト室')).toBe(false);
    expect(JSON.stringify(directory)).not.toContain('特命プロジェクト室');
  });

  it('公開表示名が空の組織は兼務ラベルにも現れない', async () => {
    const main = await createDepartment(T, { name: '営業部' });
    const blank = await createDepartment(T, { name: '技術部' });
    if (!main.ok || !blank.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: main.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const unit = (await getOrganizationView(SCOPE)).units.find((u) => u.id === blank.value.id);
    if (unit === undefined) throw new Error('fixture failed');
    await putOrganizationUnit(T, { ...unit, publicDisplayName: '   ' });
    await putOrganizationMembership(T, {
      staffId: staff.value.id,
      organizationId: blank.value.id,
      relation: 'secondary',
      publicInDirectory: true,
      callable: true,
    });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.staff.find((s) => s.id === staff.value.id)?.affiliation).toEqual({
      primary: '営業部',
      secondary: [],
    });
  });
});

