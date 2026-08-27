/**
 * 担当者を部署でまとめる (#787)。
 *
 * ## なぜ純関数にするか
 *
 * 「どの担当者にもタッチだけで到達できる」は**この関数だけで決まる**不変条件で、
 * 描画を通さずに総当りで縛れる。群に分ける実装は、分け方を間違えると**誰かがどの群にも
 * 入らない**形で壊れ、その人はタッチで永久に到達不能になる（＝呼べない）。
 *
 * ## 所属不明を捨てない
 *
 * 🔴 **名簿に無い `departmentId` を持つ担当者を落とさない。** `DirStaff.departmentId` は
 * 必須だが、部署一覧と整合している保証は無い（縮退時の `/api/kiosk/directory` は組織モデルを
 * 読まないので、部署側だけ欠けることがある）。素直に `departments` を回して該当者を拾う実装だと、
 * こういう担当者が**静かに消える**。ここでは受け皿の群を作って必ず拾う。
 */
import type { DirDepartment, DirStaff } from './useEffectiveConfiguration';

/** 所属不明の受け皿の群 id。実在する部署 id と衝突しないよう `#` で始める。 */
export const UNGROUPED_DEPARTMENT_ID = '#ungrouped';

export type StaffGroup = {
  /** 部署 id、または所属不明の受け皿。 */
  readonly id: string;
  /** 部署名。受け皿は名前を持たない（表示側が locale で解決する）。 */
  readonly name?: string;
  readonly staff: readonly DirStaff[];
};

/**
 * 担当者を部署ごとの群へ分ける。**全員がちょうど 1 つの群に入る**（落とさない・重複させない）。
 *
 * 空の部署は群を作らない —— 押した先に誰も居ないカードは、来訪者から見れば
 * 行き止まりへの案内でしかない（#776 の「次の一手は中身があるものだけ」と同じ判断）。
 */
export function staffGroupsFor(
  staff: readonly DirStaff[],
  departments: readonly DirDepartment[],
): readonly StaffGroup[] {
  const known = new Set(departments.map((d) => d.id));
  const groups: StaffGroup[] = [];

  for (const department of departments) {
    const members = staff.filter((s) => s.departmentId === department.id);
    if (members.length > 0) groups.push({ id: department.id, name: department.name, staff: members });
  }

  // 名簿に無い所属（空文字を含む）は最後の受け皿へ。正規の部署を押しのけない。
  const orphans = staff.filter((s) => !known.has(s.departmentId));
  if (orphans.length > 0) groups.push({ id: UNGROUPED_DEPARTMENT_ID, staff: orphans });

  return groups;
}
