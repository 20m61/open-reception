/**
 * 担当者の読み（よみがな）の規則を、書き込みの全経路（作成・更新・CSV 取り込み）で
 * 両方の方針について縛る (#1287)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Staff } from '@/domain/staff/types';
import type { StaffKanaPolicy } from '@/domain/staff/kana';
import { parseCsvRecords } from '@/lib/csv/parse';
import {
  __resetDirectory,
  createStaff,
  getDirectoryRepository,
  importStaff,
  listStaff,
  updateStaff,
} from './directory-store';

const T = 'internal';
const POLICIES: StaffKanaPolicy[] = ['required', 'encouraged'];
const BAD_KANA = [undefined, '', 'さとうたろう', '佐藤 太郎'] as const;
const GOOD_KANA = ['しんにん いちろう', 'シンニン イチロウ', 'ｼﾝﾆﾝ ｲﾁﾛｳ', 'しんにん　いちろう'];

beforeEach(async () => {
  await __resetDirectory(T);
});

function recs(csv: string) {
  return parseCsvRecords(csv).records;
}

/** 読みの欄を持たない旧レコード（型の任意フィールドが未設定）。 */
async function putLegacyStaffWithoutKana(): Promise<void> {
  const legacy: Staff = {
    id: 'staff-legacy',
    displayName: '旧 登録',
    aliases: [],
    departmentId: 'dept-sales',
    enabled: true,
    available: true,
    callTargets: [],
    fallbackStaffIds: [],
  };
  expect('kana' in legacy).toBe(false);
  await getDirectoryRepository().putStaff(T, legacy);
}

describe('createStaff と読みの方針 (#1287)', () => {
  // 下界: 正しい読みはどちらの方針でも保存できる。
  for (const policy of POLICIES) {
    it.each(GOOD_KANA)(`${policy}: 正しい読み %j は保存できる`, async (kana) => {
      const r = await createStaff(T, { displayName: '新人 一郎', kana, departmentId: 'dept-sales' }, { kanaPolicy: policy });
      expect(r.ok).toBe(true);
      if (r.ok) expect((await listStaff(T)).find((s) => s.id === r.value.id)?.kana).toBe(kana);
    });
  }

  it.each(BAD_KANA)('required: 読み %j は保存できない（何も作られない）', async (kana) => {
    const before = (await listStaff(T, true)).length;
    const r = await createStaff(T, { displayName: '新人 一郎', kana, departmentId: 'dept-sales' }, { kanaPolicy: 'required' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_input');
      expect(r.error.message).toMatch(/よみがな|姓と名/u);
    }
    expect((await listStaff(T, true)).length).toBe(before);
  });

  it.each(BAD_KANA)('encouraged: 読み %j でも保存できる', async (kana) => {
    const r = await createStaff(T, { displayName: '新人 一郎', kana, departmentId: 'dept-sales' }, { kanaPolicy: 'encouraged' });
    expect(r.ok).toBe(true);
  });

  it('方針を渡さなければ既定（STAFF_KANA_POLICY = encouraged）に従い、読みが無くても保存できる', async () => {
    const r = await createStaff(T, { displayName: '新人 一郎', departmentId: 'dept-sales' });
    expect(r.ok).toBe(true);
  });
});

describe('updateStaff と読みの方針 (#1287)', () => {
  it.each(['', 'さとうたろう', 'sato taro'])('required: 読みを %j へ変える更新は拒否し、元の読みを保つ', async (kana) => {
    const r = await updateStaff(T, 'staff-sato', { kana }, { kanaPolicy: 'required' });
    expect(r.ok).toBe(false);
    expect((await listStaff(T, true)).find((s) => s.id === 'staff-sato')?.kana).toBe('さとう たろう');
  });

  it('required: 拒否した更新は、同じ patch の他の欄も保存しない', async () => {
    const r = await updateStaff(T, 'staff-sato', { kana: '', available: false }, { kanaPolicy: 'required' });
    expect(r.ok).toBe(false);
    expect((await listStaff(T, true)).find((s) => s.id === 'staff-sato')?.available).toBe(true);
  });

  for (const policy of POLICIES) {
    it(`${policy}: 正しい読みへの更新は保存できる`, async () => {
      const r = await updateStaff(T, 'staff-sato', { kana: 'サトウ ジロウ' }, { kanaPolicy: policy });
      expect(r.ok).toBe(true);
      expect((await listStaff(T, true)).find((s) => s.id === 'staff-sato')?.kana).toBe('サトウ ジロウ');
    });

    // 旧レコード: 読みの無い担当者も読め、読みに触れない更新（在席の切り替え等）はできる。
    it(`${policy}: 読みの無い旧レコードを読み込め、読みに触れない更新はできる`, async () => {
      await putLegacyStaffWithoutKana();
      const loaded = (await listStaff(T, true)).find((s) => s.id === 'staff-legacy');
      expect(loaded).toBeDefined();
      expect(loaded?.kana).toBeUndefined();
      const r = await updateStaff(T, 'staff-legacy', { available: false }, { kanaPolicy: policy });
      expect(r.ok).toBe(true);
      expect((await listStaff(T, true)).find((s) => s.id === 'staff-legacy')?.available).toBe(false);
    });
  }

  it('encouraged: 区切りの無い読みでも保存できる', async () => {
    const r = await updateStaff(T, 'staff-sato', { kana: 'さとうたろう' }, { kanaPolicy: 'encouraged' });
    expect(r.ok).toBe(true);
  });
});

describe('importStaff と読みの方針 (#1287)', () => {
  const CSV =
    'display_name,kana,department_id\n' +
    '読み 無し,,dept-sales\n' +
    '区切り 無し,くぎりなし,dept-sales\n' +
    '正しい 読み,ただしい よみ,dept-sales';

  it('required: 読みが正しくない行は invalid にし、作らない。正しい行は作る', async () => {
    const summary = await importStaff(T, recs(CSV), 'apply', { kanaPolicy: 'required' });
    expect(summary.created).toBe(1);
    expect(summary.invalid.map((x) => x.row)).toEqual([2, 3]);
    expect(summary.invalid[0]?.reason).toMatch(/よみがな/u);
    expect(summary.invalid[1]?.reason).toMatch(/姓と名/u);
    expect(summary.warnings).toEqual([]);
    const names = (await listStaff(T, true)).map((s) => s.displayName);
    expect(names).toContain('正しい 読み');
    expect(names).not.toContain('読み 無し');
    expect(names).not.toContain('区切り 無し');
  });

  it('required: 既存の担当者の行で読みを空にする更新は invalid（読みを消さない）', async () => {
    const summary = await importStaff(
      T,
      recs('staff_id,display_name,kana,department_id\nstaff-sato,佐藤 太郎,,dept-sales'),
      'apply',
      { kanaPolicy: 'required' },
    );
    expect(summary.updated).toBe(0);
    expect(summary.invalid).toHaveLength(1);
    expect((await listStaff(T, true)).find((s) => s.id === 'staff-sato')?.kana).toBe('さとう たろう');
  });

  for (const mode of ['preview', 'apply'] as const) {
    it(`encouraged (${mode}): 読みが正しくない行も取り込み、行ごとに警告を返す`, async () => {
      const summary = await importStaff(T, recs(CSV), mode, { kanaPolicy: 'encouraged' });
      expect(summary.created).toBe(3);
      expect(summary.invalid).toEqual([]);
      expect(summary.warnings.map((x) => x.row)).toEqual([2, 3]);
      expect(summary.warnings[0]?.reason).toMatch(/よみがな/u);
      expect(summary.warnings[1]?.reason).toMatch(/姓と名/u);
    });
  }

  // 下界: 全行が正しければどちらの方針でも警告もエラーも出ない。
  for (const policy of POLICIES) {
    it(`${policy}: 正しい読みだけの CSV は警告もエラーも無く取り込める`, async () => {
      const summary = await importStaff(
        T,
        recs('display_name,kana,department_id\n新任 太郎,しんにん たろう,dept-sales\n新任 花子,シンニン ハナコ,dept-dev'),
        'apply',
        { kanaPolicy: policy },
      );
      expect(summary).toMatchObject({ created: 2, invalid: [], warnings: [] });
    });
  }
});
