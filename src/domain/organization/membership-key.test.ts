import { describe, expect, it } from 'vitest';
import { membershipStoreId } from './membership-key';

/**
 * 所属の永続化キー (#373 増分 2)。
 *
 * 所属は「誰がどの組織に属するか」＝**呼び出し可否の根拠**なので、キーが化けると
 * 別人の所属として扱われる。区切り文字の扱いを固定する。
 */

describe('membershipStoreId', () => {
  it('同じ組は同じキーになる', () => {
    expect(membershipStoreId('staff-1', 'org-1')).toBe(membershipStoreId('staff-1', 'org-1'));
  });

  it('違う組は違うキーになる', () => {
    expect(membershipStoreId('staff-1', 'org-1')).not.toBe(membershipStoreId('staff-2', 'org-1'));
    expect(membershipStoreId('staff-1', 'org-1')).not.toBe(membershipStoreId('staff-1', 'org-2'));
  });

  /**
   * **素朴な連結だと別の組へ化ける。** `a:b` + `c` と `a` + `b:c` が同じキーになり、
   * 所属＝呼び出し可否の根拠が別人のものとして扱われる。
   */
  it('区切り文字を含む id でも他の組と衝突しない', () => {
    expect(membershipStoreId('a:b', 'c')).not.toBe(membershipStoreId('a', 'b:c'));
  });

  it('空の id は拒否する（黙って壊れたキーを作らない）', () => {
    expect(() => membershipStoreId('', 'org-1')).toThrow();
    expect(() => membershipStoreId('staff-1', '')).toThrow();
  });
});
