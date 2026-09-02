import { describe, expect, it } from 'vitest';
import { staffAffiliationText } from './staff-affiliation-text';
import { makeT } from '@/lib/i18n';

const DEPARTMENTS = [
  { id: 'dept-sales', name: '営業部' },
  { id: 'dept-dev', name: '技術部' },
];
const ja = makeT('ja');
const en = makeT('en');

/**
 * 候補カードの所属テキスト (#373)。
 *
 * この規則を間違えると、**運用者が来訪者へ出さないと決めた所属が部署名として出戻る**。
 * 実際にレビューで指摘された欠陥がそれで、原因は「空なら値ごと落とす」実装と
 * `?? 部署名` フォールバックの組み合わせだった。
 */
describe('staffAffiliationText', () => {
  it('主所属だけならその名前を出す', () => {
    expect(
      staffAffiliationText(
        { departmentId: 'dept-sales', affiliation: { primary: '営業部', secondary: [] } },
        DEPARTMENTS,
        ja,
      ),
    ).toBe('営業部');
  });

  it('兼務があれば併記する', () => {
    expect(
      staffAffiliationText(
        {
          departmentId: 'dept-sales',
          affiliation: { primary: '営業部', secondary: ['技術部', '広報部'] },
        },
        DEPARTMENTS,
        ja,
      ),
    ).toBe('営業部（兼: 技術部・広報部）');
  });

  /**
   * 整形は locale 依存。サーバ側で文字列にすると版スナップショットへ日本語が焼き込まれ、
   * 後から locale 対応するのに移行が要る。だから構造で受け取ってここで整形する。
   */
  it('locale ごとに整形が変わる（サーバは構造だけを返す）', () => {
    expect(
      staffAffiliationText(
        { departmentId: 'dept-sales', affiliation: { primary: 'Sales', secondary: ['Tech'] } },
        DEPARTMENTS,
        en,
      ),
    ).toBe('Sales (also Tech)');
  });

  /**
   * **本題。** 空の構造は「出せる所属が無い」という結論であって欠落ではない。
   * 部署名で埋め戻すと、非公開にした所属（`membership.publicInDirectory: false`）が
   * そのまま画面に出る。運用者は管理画面上「非公開」に見えるので気づけない。
   */
  it('所属が空なら何も出さない（部署名へ出戻らせない）', () => {
    expect(
      staffAffiliationText(
        { departmentId: 'dept-sales', affiliation: { secondary: [] } },
        DEPARTMENTS,
        ja,
      ),
    ).toBe('');
  });

  /** 主所属が非公開でも兼務が公開なら、識別できる情報を捨てない。 */
  it('主所属が無く兼務だけあるときは兼務を出す（兼務マーカは付けない）', () => {
    expect(
      staffAffiliationText(
        { departmentId: 'dept-sales', affiliation: { secondary: ['技術部'] } },
        DEPARTMENTS,
        ja,
      ),
    ).toBe('技術部');
  });

  /**
   * 旧経路（effective config 失敗時の `/api/kiosk/directory`）は組織モデルを読まないので
   * `affiliation` を持たない。ここでフォールバックしないと、縮退時に所属が全て消える。
   */
  it('affiliation が無いときだけ部署名へフォールバックする', () => {
    expect(staffAffiliationText({ departmentId: 'dept-dev' }, DEPARTMENTS, ja)).toBe('技術部');
  });

  it('部署が一覧に無ければ空（無効な部署の担当者は所属を出さない・規則 A）', () => {
    expect(staffAffiliationText({ departmentId: 'dept-gone' }, DEPARTMENTS, ja)).toBe('');
  });
});
