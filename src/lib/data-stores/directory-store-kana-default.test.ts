/**
 * 書き込みの 3 経路は、方針を渡されなければ `STAFF_KANA_POLICY` に従う (#1287 レビュー m2)。
 *
 * 管理 API（`src/app/api/admin/staff/**`）は方針を渡さず既定に任せる。既定が `encouraged` のままだと
 * 「既定に従う」と「`encouraged` を決め打ちしている」が区別できないので、ここでは定数を `required` へ
 * 差し替えて、3 経路とも既定でその方針になることを縛る（owner が 1 行を切り替えたときに効くこと）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCsvRecords } from '@/lib/csv/parse';

vi.mock('@/domain/staff/kana', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/staff/kana')>()),
  STAFF_KANA_POLICY: 'required',
}));

const { __resetDirectory, createStaff, importStaff, listStaff, updateStaff } = await import('./directory-store');

const T = 'internal';

beforeEach(async () => {
  await __resetDirectory(T);
});

describe('方針を渡さない書き込みは STAFF_KANA_POLICY に従う (#1287)', () => {
  it('createStaff: 読みが無ければ拒否し、理由を日本語で返す', async () => {
    const r = await createStaff(T, { displayName: '新人 一郎', departmentId: 'dept-sales' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/よみがな/u);
  });

  it('updateStaff: 区切りの無い読みへの更新を拒否する', async () => {
    const r = await updateStaff(T, 'staff-sato', { kana: 'さとうたろう' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/姓と名/u);
  });

  it('importStaff: 読みが正しくない行を invalid にする', async () => {
    const summary = await importStaff(
      T,
      parseCsvRecords('display_name,kana,department_id\n読み 無し,,dept-sales').records,
      'apply',
    );
    expect(summary.created).toBe(0);
    expect(summary.invalid).toHaveLength(1);
  });

  // 下界: 正しい読みは既定のままでも保存できる。
  it('正しい読みは 3 経路とも保存できる', async () => {
    expect((await createStaff(T, { displayName: '新人 一郎', kana: 'しんにん いちろう', departmentId: 'dept-sales' })).ok).toBe(
      true,
    );
    expect((await updateStaff(T, 'staff-sato', { kana: 'さとう じろう' })).ok).toBe(true);
    const summary = await importStaff(
      T,
      parseCsvRecords('display_name,kana,department_id\n新任 太郎,しんにん たろう,dept-sales').records,
      'apply',
    );
    expect(summary).toMatchObject({ created: 1, invalid: [] });
    expect((await listStaff(T, true)).map((s) => s.displayName)).toContain('新任 太郎');
  });
});
