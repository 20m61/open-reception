/**
 * 担当者グリッドの段階開示 (#787)。
 *
 * ## 何が問題か
 *
 * #776 で相手選択画面の判断対象を「担当者」「部署」の 1 種類ずつに分けたが、**担当者グリッドの
 * 件数は無制限のまま**だった。担当者が数十人のテナントでは、#776 が解いた密度の問題が
 * 「担当者タブの中」へ移動しただけになる。
 *
 * ## 絞ると到達性が落ちる
 *
 * 🔴 **単純な上位 N 件打ち切りは「その人を呼べない」に直結する。** 担当者名を知らない
 * 来訪者は検索できないので、切り捨てた相手はタッチで永久に到達不能になる。
 * そこで**部署で段階開示**する —— 未入力時は部署を出し、選んだ部署の担当者を見せる。
 *
 * ## 縛るべき不変条件
 *
 * 「2〜4 件に収まる」より先に、**どの担当者にもタッチだけで到達できる**ことを縛る。
 * 群に分ける実装は、分け方を間違えると**誰かがどの群にも入らない**形で壊れる。
 */
import { describe, expect, it } from 'vitest';
import { staffGroupsFor, UNGROUPED_DEPARTMENT_ID } from './staff-grouping';
import type { DirStaff, DirDepartment } from './useEffectiveConfiguration';

function staff(id: string, departmentId: string): DirStaff {
  return { id, displayName: id, aliases: [], departmentId, available: true };
}

const DEPARTMENTS: DirDepartment[] = [
  { id: 'sales', name: '営業部' },
  { id: 'dev', name: '開発部' },
];

describe('担当者の部署グルーピング (#787)', () => {
  it('部署ごとにまとめ、件数を持つ', () => {
    const groups = staffGroupsFor(
      [staff('a', 'sales'), staff('b', 'sales'), staff('c', 'dev')],
      DEPARTMENTS,
    );
    expect(groups.map((g) => [g.id, g.staff.length])).toEqual([
      ['sales', 2],
      ['dev', 1],
    ]);
  });

  /**
   * 🔴 **これが本丸。** 分け方を間違えると誰かがどの群にも入らず、その人はタッチで
   * 到達不能になる（＝呼べない）。総当りで縛る。
   */
  it.each([
    ['所属が名簿に無い', [staff('a', 'ghost')]],
    ['所属が空文字', [staff('a', '')]],
    ['名簿に無い所属と正常な所属が混在', [staff('a', 'ghost'), staff('b', 'sales')]],
    ['全員が名簿に無い所属', [staff('a', 'ghost'), staff('b', 'phantom')]],
    ['部署が 1 つも無い', [staff('a', 'sales'), staff('b', 'dev')]],
  ])('%s でも全員がどこかの群に入る', (_label, list) => {
    const departments = _label === '部署が 1 つも無い' ? [] : DEPARTMENTS;
    const groups = staffGroupsFor(list, departments);
    const reachable = groups.flatMap((g) => g.staff.map((s) => s.id)).sort();
    expect(reachable).toEqual(list.map((s) => s.id).sort());
  });

  it('同じ担当者が 2 つの群に現れない（重複して数えさせない）', () => {
    const groups = staffGroupsFor([staff('a', 'sales'), staff('b', 'dev')], DEPARTMENTS);
    const ids = groups.flatMap((g) => g.staff.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  /** 空の部署は出さない。押した先に誰も居ないカードは行き止まりへの案内でしかない（#776 の型）。 */
  it('担当者が 0 人の部署は群を作らない', () => {
    const groups = staffGroupsFor([staff('a', 'sales')], DEPARTMENTS);
    expect(groups.map((g) => g.id)).toEqual(['sales']);
  });

  it('所属不明の受け皿は最後に置く（正規の部署を押しのけない）', () => {
    const groups = staffGroupsFor([staff('a', 'ghost'), staff('b', 'sales')], DEPARTMENTS);
    expect(groups.map((g) => g.id)).toEqual(['sales', UNGROUPED_DEPARTMENT_ID]);
  });

  it('担当者が 0 人なら群も 0（空の器を出さない）', () => {
    expect(staffGroupsFor([], DEPARTMENTS)).toEqual([]);
  });
});
