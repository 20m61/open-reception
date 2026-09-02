import { describe, expect, it } from 'vitest';
import { organizationVisibility } from './visibility';
import type { OrganizationUnit } from './types';

function unit(patch: Partial<OrganizationUnit> = {}): OrganizationUnit {
  return {
    id: 'org-1',
    tenantId: 'internal',
    officialName: '株式会社サンプル 営業本部',
    publicDisplayName: '営業部',
    aliases: [],
    enabled: true,
    publicInDirectory: true,
    displayOrder: 0,
    ...patch,
  };
}

/**
 * 組織が来訪者に見えるか、見えないなら**なぜか** (#373 増分 6)。
 *
 * 運用者にとって最も分かりにくい失敗は「保存したのに来訪者画面に出ない」。無効なのか、
 * 非公開なのか、公開表示名が空なのかで直し方が違うのに、画面が「出ない」としか言わないと
 * 原因に辿り着けない。理由を持つ型にして管理画面へ出す。
 *
 * **読み側（`publicUnitsInScope`）と同じ判定であること**が要点。別々に書くと、管理画面が
 * 「見える」と言っているのに来訪者には出ない、という最悪の食い違いになる。
 */
describe('organizationVisibility', () => {
  it('有効・公開・表示名ありなら見える', () => {
    expect(organizationVisibility(unit())).toEqual({ kind: 'visible' });
  });

  it('無効なら見えない（理由: disabled）', () => {
    expect(organizationVisibility(unit({ enabled: false }))).toEqual({
      kind: 'hidden',
      reason: 'disabled',
    });
  });

  it('非公開なら見えない（理由: not-public）', () => {
    expect(organizationVisibility(unit({ publicInDirectory: false }))).toEqual({
      kind: 'hidden',
      reason: 'not-public',
    });
  });

  it('公開表示名が空なら見えない（理由: no-public-name）', () => {
    expect(organizationVisibility(unit({ publicDisplayName: '   ' }))).toEqual({
      kind: 'hidden',
      reason: 'no-public-name',
    });
  });

  /**
   * 複数の理由が重なるとき、**運用者が最初に直すべきもの**を返す。無効な組織の表示名を
   * 直させても出ない。
   */
  it('理由が重なるときは disabled を優先する', () => {
    expect(
      organizationVisibility(unit({ enabled: false, publicInDirectory: false })),
    ).toEqual({ kind: 'hidden', reason: 'disabled' });
  });
});
