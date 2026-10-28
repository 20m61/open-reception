import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StaffKanaPolicy } from '@/domain/staff/kana';
import { kanaFieldState } from './StaffKana';
import { canSubmitStaff, rejectionReason, savedWithKanaWarning, withReason } from './staff-form';

/**
 * 担当者の追加フォームの送信可否と、保存結果の文言 (#1287 レビュー m2 / m3)。
 */
const POLICIES: StaffKanaPolicy[] = ['required', 'encouraged'];

function input(kana: string, policy: StaffKanaPolicy, over: Partial<Parameters<typeof canSubmitStaff>[0]> = {}) {
  return {
    busy: false,
    displayName: '新人 一郎',
    departmentId: 'dept-sales',
    departmentsLoaded: true,
    kanaField: kanaFieldState(kana, policy),
    ...over,
  };
}

describe('canSubmitStaff (#1287 m2)', () => {
  // 下界: 正しい読みと必要な欄が揃えば、どちらの方針でも送信できる。
  for (const policy of POLICIES) {
    it(`${policy}: 正しい読みなら送信できる`, () => {
      expect(canSubmitStaff(input('さとう たろう', policy))).toBe(true);
    });
  }

  it('required: 正しくない読みでは送信しない', () => {
    for (const kana of ['', 'さとうたろう', '佐藤 太郎']) {
      expect(canSubmitStaff(input(kana, 'required'))).toBe(false);
    }
  });

  it('encouraged: 正しくない読みでも送信できる', () => {
    for (const kana of ['', 'さとうたろう', '佐藤 太郎']) {
      expect(canSubmitStaff(input(kana, 'encouraged'))).toBe(true);
    }
  });

  it('氏名・部署・処理中・部署未読のどれかで送信しない', () => {
    expect(canSubmitStaff(input('さとう たろう', 'encouraged', { displayName: '  ' }))).toBe(false);
    expect(canSubmitStaff(input('さとう たろう', 'encouraged', { departmentId: '' }))).toBe(false);
    expect(canSubmitStaff(input('さとう たろう', 'encouraged', { busy: true }))).toBe(false);
    expect(canSubmitStaff(input('さとう たろう', 'encouraged', { departmentsLoaded: false }))).toBe(false);
  });
});

describe('rejectionReason / withReason (#1287 m2)', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('400 の本文の理由を返す（読みの拒否はサーバが日本語で返す）', async () => {
    const res = json(400, { error: 'invalid_input', message: 'よみがなが未登録です。' });
    expect(await rejectionReason(res)).toBe('よみがなが未登録です。');
  });

  it('届かない・400 以外・本文が読めない・理由が無いときは null', async () => {
    expect(await rejectionReason(null)).toBeNull();
    expect(await rejectionReason(json(500, { message: 'x' }))).toBeNull();
    expect(await rejectionReason(json(403, { message: 'x' }))).toBeNull();
    expect(await rejectionReason(new Response('not json', { status: 400 }))).toBeNull();
    expect(await rejectionReason(json(400, { message: '  ' }))).toBeNull();
    expect(await rejectionReason(json(400, { error: 'invalid_input' }))).toBeNull();
  });

  it('理由があれば汎用の文に続けて出し、無ければ汎用の文だけ', () => {
    expect(withReason('担当者を追加できませんでした。', 'よみがなが未登録です。')).toBe(
      '担当者を追加できませんでした。よみがなが未登録です。',
    );
    expect(withReason('担当者を追加できませんでした。', null)).toBe('担当者を追加できませんでした。');
  });
});

describe('savedWithKanaWarning (#1287 m3)', () => {
  it('正しい読みなら保存の文だけ', () => {
    expect(savedWithKanaWarning('変更を保存しました。', 'さとう たろう')).toBe('変更を保存しました。');
  });

  it('正しくない読みなら追加のときと同じ警告を続ける', () => {
    expect(savedWithKanaWarning('変更を保存しました。', 'さとうたろう')).toContain('姓と名');
    expect(savedWithKanaWarning('変更を保存しました。', '')).toBe('変更を保存しました。よみがなが未登録です。');
    expect(savedWithKanaWarning('担当者を追加しました。', undefined)).toBe(
      '担当者を追加しました。よみがなが未登録です。',
    );
  });
});

/**
 * 配線 (#1287 m2 / m3)。`StaffManager` は送信の相互作用を unit で描けないので、
 * 判定と文言が実際にこの画面へ繋がっていることを構造で縛る。
 */
describe('StaffManager の配線 (#1287)', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/admin/StaffManager.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

  it('送信可否は読みの判定（kanaField）を含めて canSubmitStaff で決め、追加の処理とボタンの両方に使う', () => {
    expect(source).toMatch(/const canSubmit = canSubmitStaff\(\{[^}]*\bkanaField\b[^}]*\}\)/);
    expect(source).toMatch(/if \(!canSubmit\) return;/);
    expect(source).toMatch(/disabled=\{!canSubmit\}/);
  });

  it('追加と変更の失敗では、サーバが返した理由を出す', () => {
    expect(source).toMatch(/failure\(withReason\('担当者を追加できませんでした。', await rejectionReason\(res\)\)\)/);
    expect(source).toMatch(/failure\(withReason\('変更を保存できませんでした。', await rejectionReason\(res\)\)\)/);
  });

  it('追加と「よみがなを直す」の保存では、読みの警告を添える', () => {
    expect(source).toMatch(/success\(savedWithKanaWarning\('担当者を追加しました。', kana \|\| undefined\)\)/);
    expect(source).toMatch(
      /onSave=\{\(next\) => patch\(s, \{ kana: next \}, savedWithKanaWarning\('変更を保存しました。', next\)\)\}/,
    );
    // patch は渡された文で成功を告げる（固定の文へ戻すと、上で渡した警告が捨てられる）。
    expect(source).toMatch(/savedMessage = '変更を保存しました。'\) => \{/);
    expect(source).toMatch(/success\(savedMessage\);/);
  });
});
