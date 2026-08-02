import { describe, expect, it } from 'vitest';
import { staffTargetFor } from './staff-target';
import { makeT } from '@/lib/i18n';

const DEPARTMENTS = [{ id: 'dept-sales', name: '営業部' }];
const tr = makeT('ja');

/**
 * 発信直前の確認画面で同姓同名を区別できるようにする (#591)。
 *
 * 候補一覧と確認画面で**同じ文字列**が出ることが要点。導出が 2 箇所にあると、
 * 一覧では区別できるのに確認画面では別の（あるいは空の）表示になる。
 */
describe('staffTargetFor', () => {
  it('所属を sublabel に入れる（label には混ぜない）', () => {
    const target = staffTargetFor(
      {
        id: 'staff-1',
        displayName: '山田 太郎',
        departmentId: 'dept-sales',
        affiliation: { primary: '営業部', secondary: ['技術部'] },
      },
      DEPARTMENTS,
      tr,
    );
    expect(target.label).toBe('山田 太郎');
    expect(target.sublabel).toBe('営業部（兼: 技術部）');
  });

  /**
   * `label` は読み上げ（TTS）と監査（`targetLabel`）に流れる。所属を混ぜると
   * 読み上げが不自然になり、監査レコードに表示都合の文字列が入る。
   */
  it('label は表示名のみで、所属を含まない', () => {
    const target = staffTargetFor(
      {
        id: 'staff-1',
        displayName: '山田 太郎',
        departmentId: 'dept-sales',
        affiliation: { primary: '営業部', secondary: ['技術部'] },
      },
      DEPARTMENTS,
      tr,
    );
    expect(target.label).not.toContain('営業部');
    expect(target.label).not.toContain('兼');
  });

  it('出せる所属が無ければ sublabel を持たない（確認画面に空行を作らない）', () => {
    const target = staffTargetFor(
      {
        id: 'staff-1',
        displayName: '佐藤 次郎',
        departmentId: 'dept-sales',
        affiliation: { secondary: [] },
      },
      DEPARTMENTS,
      tr,
    );
    expect(target).not.toHaveProperty('sublabel');
  });

  /** 旧経路（縮退時）は `affiliation` を持たない。部署名へフォールバックする。 */
  it('affiliation が無ければ部署名を使う', () => {
    const target = staffTargetFor(
      { id: 'staff-1', displayName: '山田 太郎', departmentId: 'dept-sales' },
      DEPARTMENTS,
      tr,
    );
    expect(target.sublabel).toBe('営業部');
  });
});
