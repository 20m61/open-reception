import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StaffKanaPolicy } from '@/domain/staff/kana';
import { StaffKanaFlag, StaffKanaNotice, kanaFieldState } from './StaffKana';

/**
 * 管理画面での読み（よみがな）の案内 (#1287)。案 A（required）と案 B（encouraged）の両方を縛る。
 */
const POLICIES: StaffKanaPolicy[] = ['required', 'encouraged'];

describe('kanaFieldState (#1287)', () => {
  // 下界: 正しい読みはどちらの方針でも、送信を止めずエラーも出さない。
  for (const policy of POLICIES) {
    it.each(['さとう たろう', 'サトウ タロウ', 'ｻﾄｳ ﾀﾛｳ'])(`${policy}: 正しい読み %j は送信でき、エラーを出さない`, (kana) => {
      const state = kanaFieldState(kana, policy);
      expect(state.blocksSubmit).toBe(false);
      expect(state.error).toBeUndefined();
    });

    it(`${policy}: 区切りの例を案内に出す`, () => {
      expect(kanaFieldState('', policy).hint).toContain('さとう たろう');
    });
  }

  it('required: 必須の印を付け、正しくない読みは送信を止める', () => {
    expect(kanaFieldState('', 'required')).toMatchObject({ required: true, blocksSubmit: true });
    expect(kanaFieldState('さとうたろう', 'required')).toMatchObject({ blocksSubmit: true });
    expect(kanaFieldState('さとうたろう', 'required').error).toContain('姓と名');
    expect(kanaFieldState('佐藤 太郎', 'required')).toMatchObject({ blocksSubmit: true });
  });

  it('required: 空欄のうちはエラー文を出さない（入力前に赤くしない）', () => {
    expect(kanaFieldState('', 'required').error).toBeUndefined();
  });

  it('encouraged: 正しくない読みでも送信は止めず、警告を出す', () => {
    expect(kanaFieldState('', 'encouraged')).toMatchObject({ required: false, blocksSubmit: false });
    expect(kanaFieldState('', 'encouraged').hint).toContain('自動');
    expect(kanaFieldState('さとうたろう', 'encouraged')).toMatchObject({ blocksSubmit: false });
    expect(kanaFieldState('さとうたろう', 'encouraged').error).toContain('姓と名');
  });

  it('ラベルで方針が分かる', () => {
    expect(kanaFieldState('', 'encouraged').label).toBe('よみがな（推奨）');
    expect(kanaFieldState('', 'required').label).toBe('よみがな');
  });
});

describe('StaffKanaFlag (#1287)', () => {
  it('読みが無い担当者に印を付ける', () => {
    const html = renderToStaticMarkup(<StaffKanaFlag kana={undefined} />);
    expect(html).toContain('data-testid="staff-kana-flag"');
    expect(html).toContain('よみがな未登録');
  });

  it('区切りの無い読みに印を付ける', () => {
    expect(renderToStaticMarkup(<StaffKanaFlag kana="さとうたろう" />)).toContain('区切りなし');
  });

  it('正しい読みには何も描画しない', () => {
    expect(renderToStaticMarkup(<StaffKanaFlag kana="さとう たろう" />)).toBe('');
  });
});

describe('StaffKanaNotice (#1287)', () => {
  it('読みの無い有効な担当者がいれば、人数と音声への影響を示す', () => {
    const html = renderToStaticMarkup(
      <StaffKanaNotice
        staff={[
          { kana: undefined, enabled: true },
          { kana: '', enabled: true },
          { kana: 'さとうたろう', enabled: true },
          { kana: 'すずき はなこ', enabled: true },
        ]}
      />,
    );
    expect(html).toContain('data-testid="staff-kana-notice"');
    expect(html).toContain('よみがな未登録: 2 人');
    expect(html).toContain('姓と名の区切りなし: 1 人');
    expect(html).toContain('自動で確定せず');
  });

  it('全員の読みが正しければ何も描画しない', () => {
    expect(
      renderToStaticMarkup(<StaffKanaNotice staff={[{ kana: 'すずき はなこ', enabled: true }, { kana: undefined, enabled: false }]} />),
    ).toBe('');
  });
});
