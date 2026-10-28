import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StaffKanaPolicy } from '@/domain/staff/kana';
import { Field } from '@/components/admin/ui';
import { KanaIssueText, StaffKanaEditor, StaffKanaFlag, StaffKanaNotice, kanaFieldState } from './StaffKana';

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
      expect(state.warning).toBeUndefined();
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
  });

  it('encouraged: 問題はエラーではなく警告として返し、案内の位置に出す (m4)', () => {
    for (const kana of ['さとうたろう', '佐藤 太郎']) {
      const state = kanaFieldState(kana, 'encouraged');
      expect(state.error).toBeUndefined();
      expect(state.warning).toBeDefined();
      expect(state.hint).toBe(state.warning);
    }
    expect(kanaFieldState('さとうたろう', 'encouraged').warning).toContain('姓と名');
  });

  it('required: 問題はエラーとして返し、警告にはしない (m4)', () => {
    const state = kanaFieldState('さとうたろう', 'required');
    expect(state.error).toContain('姓と名');
    expect(state.warning).toBeUndefined();
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

/** 追加フォームの入力欄として描いたとき（`StaffManager` と同じ渡し方）。 */
function renderKanaField(kana: string, policy: StaffKanaPolicy): string {
  const state = kanaFieldState(kana, policy);
  return renderToStaticMarkup(
    <Field label={state.label} htmlFor="k" hint={state.hint} error={state.error} required={state.required}>
      <input id="k" value={kana} readOnly />
    </Field>,
  );
}

describe('読みの欄の見た目は方針で変わる (#1287 m4)', () => {
  it('encouraged: 正しくない読みでも aria-invalid を付けず、エラー表示にしない', () => {
    const html = renderKanaField('さとうたろう', 'encouraged');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('ui-field-error');
    expect(html).toContain('姓と名');
  });

  it('required: 正しくない読みはエラー表示にする', () => {
    const html = renderKanaField('さとうたろう', 'required');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('ui-field-error');
  });

  // 下界: 正しい読みはどちらの方針でも、エラーも警告も出さない。
  for (const policy of POLICIES) {
    it(`${policy}: 正しい読みはエラーも警告も出さない`, () => {
      const html = renderKanaField('さとう たろう', policy);
      expect(html).not.toContain('aria-invalid');
      expect(html).not.toContain('ui-field-error');
      expect(renderToStaticMarkup(<KanaIssueText state={kanaFieldState('さとう たろう', policy)} />)).toBe('');
    });
  }
});

describe('KanaIssueText（「よみがなを直す」の欄の案内） (#1287 m4)', () => {
  it('encouraged: 警告として出す（危険色・alert にしない）', () => {
    const html = renderToStaticMarkup(<KanaIssueText state={kanaFieldState('さとうたろう', 'encouraged')} />);
    expect(html).toContain('data-testid="staff-kana-edit-warning"');
    expect(html).toContain('role="status"');
    expect(html).toContain('var(--color-warning)');
    expect(html).not.toContain('var(--color-danger)');
    expect(html).not.toContain('staff-kana-edit-error');
  });

  it('required: エラーとして出す', () => {
    const html = renderToStaticMarkup(<KanaIssueText state={kanaFieldState('さとうたろう', 'required')} />);
    expect(html).toContain('data-testid="staff-kana-edit-error"');
    expect(html).toContain('var(--color-danger)');
    expect(html).not.toContain('staff-kana-edit-warning');
  });
});

describe('StaffKanaEditor を開いたとき (#1287 m4)', () => {
  const render = (kana: string, policy: StaffKanaPolicy) =>
    renderToStaticMarkup(
      <StaffKanaEditor staffId="s1" kana={kana} policy={policy} defaultOpen onSave={async () => true} />,
    );

  it('encouraged: 正しくない読みは警告として出し、aria-invalid にしない', () => {
    const html = render('さとうたろう', 'encouraged');
    expect(html).toContain('data-testid="staff-kana-edit-warning"');
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="staff-s1-kana-edit-issue"');
    expect(html).toContain('id="staff-s1-kana-edit-issue"');
  });

  it('required: 正しくない読みはエラーとして出し、aria-invalid にする', () => {
    const html = render('さとうたろう', 'required');
    expect(html).toContain('data-testid="staff-kana-edit-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="staff-s1-kana-edit-issue"');
  });

  // 下界: 正しい読みはどちらの方針でも、エラーも警告も出さない。
  for (const policy of POLICIES) {
    it(`${policy}: 正しい読みはエラーも警告も出さない`, () => {
      const html = render('さとう たろう', policy);
      expect(html).toContain('data-testid="staff-kana-edit-input"');
      expect(html).not.toContain('aria-invalid="true"');
      expect(html).not.toContain('aria-describedby');
      expect(html).not.toContain('staff-kana-edit-warning');
      expect(html).not.toContain('staff-kana-edit-error');
    });
  }
});
