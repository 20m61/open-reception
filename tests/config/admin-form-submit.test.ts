import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * admin の CRUD / 設定保存が `<form>` として送信できる (#892 / #893 / 課題 13)。
 *
 * `Field.test.tsx` が部品の振る舞いを、`tests/e2e/admin-form-enter-submit.spec.ts` が
 * 実ブラウザでの Enter 送信を縛る。ここが見るのは**構造の退行**——
 * 変換済みの画面が `<div>` + `onClick` へ戻ること、および
 * 「`<form>` にはしたが送信ボタンが無い」（＝ Enter で何も起きないまま形だけ整う）状態。
 *
 * 🔴 **残りを暗黙にしない (#893)。** #893 の本文は「残っているのは 8 画面 + 2」と書いて
 * いたが、実測すると admin の primary ボタンは 25 個あり、form 形なのに一覧から漏れていた
 * ものが 2 つあった（`flow-add` / `staff-response-config-message-save`）。棚卸しを散文で
 * 持つと必ずこうなるので、**primary ボタンは全部いずれかのバケツに入れる**ことを機械で
 * 強制する。新しい画面を足した人は、それが送信なのか操作なのかを**必ず宣言する**ことになる。
 *
 *   - `CONVERTED` … form 形で、変換済み
 *   - `PENDING`   … form 形だが未変換（理由つき）。**ここが空になったら**レジストリ方式を
 *                   やめて「admin の primary は全部 submit」へ締める（#893 AC）
 *   - `ACTIONS`   … そもそも form ではない（入力欄を持たない操作ボタン）
 */

const ADMIN_DIR = join(process.cwd(), 'src/components/admin');

/** 変換済みの画面と、その送信ボタンの testId。 */
const CONVERTED: readonly { readonly file: string; readonly submit: string }[] = [
  // #892: 追加 / 作成フォーム
  { file: 'SitesManager.tsx', submit: 'site-add' },
  { file: 'DepartmentsManager.tsx', submit: 'dept-add' },
  { file: 'StaffManager.tsx', submit: 'staff-add' },
  { file: 'AssetsManager.tsx', submit: 'asset-add' },
  { file: 'RoutingPolicyManager.tsx', submit: 'endpoint-add' },
  { file: 'ReservationsManager.tsx', submit: 'rsv-create' },
  { file: 'DevicesManager.tsx', submit: 'device-add' },
  // #893: 設定の保存フォーム
  { file: 'VoiceManager.tsx', submit: 'voice-save' },
  { file: 'BrandingManager.tsx', submit: 'brand-save' },
  { file: 'SecurityManager.tsx', submit: 'security-save' },
  { file: 'OperatingHoursManager.tsx', submit: 'operating-hours-save' },
  { file: 'LanguageSettingsManager.tsx', submit: 'lang-save' },
  { file: 'AiGuidanceManager.tsx', submit: 'ai-guidance-save' },
  { file: 'RoutingPolicyManager.tsx', submit: 'policy-save' },
  { file: 'SignageManager.tsx', submit: 'signage-save' },
  // #893: 一覧から漏れていた form 形（実測で見つけた）
  { file: 'ReceptionFlowsManager.tsx', submit: 'flow-add' },
  { file: 'StaffResponseManager.tsx', submit: 'staff-response-config-message-save' },
  { file: 'StaffEditor.tsx', submit: 'staff-editor-save' },
];

/**
 * form 形だが**まだ変換していない**もの。ここが空になったらレジストリ方式をやめる。
 * 理由を必ず書く（「あとで」は理由ではない）。
 */
const PENDING: readonly { readonly testId: string; readonly why: string }[] = [
  {
    testId: 'device-save',
    why:
      '`DataTable` のセル内にある行内編集。入力欄と保存ボタンが別々の <td> に載るため ' +
      '<form> で囲えず（form は td をまたげない）、`form` 属性で結ぶか行の描画そのものを ' +
      '変えるかの設計判断が要る。#893 の残りとして別増分。',
  },
];

/**
 * そもそも form ではない primary ボタン（入力欄を持たない操作）。
 * `data-testid` の**書かれたとおりの文字列**で照合する（動的 testId も含むため）。
 */
const ACTIONS: readonly { readonly testId: string; readonly why: string }[] = [
  { testId: 'device-reissue', why: '一覧の行操作（受付URL発行の確認ダイアログを開く）' },
  { testId: 'device-reissue-confirm', why: '確認ダイアログの実行ボタン' },
  { testId: 'policy-new', why: '新規ルートのドラフトを開くだけ（入力はその後の policy-save）' },
  { testId: 'emergency-resume', why: '緊急停止の解除。入力欄を持たない' },
  { testId: 'stay-checkout', why: '一覧の行操作（退館）' },
  { testId: 'unsaved-changes-stay', why: '離脱確認ダイアログの「このページに留まる」。入力欄を持たない' },
  { testId: '`integration-${it.id}-test`', why: '接続テストの実行。入力欄を持たない' },
];

/** 注記が主張と一致してしまう事故を避けるため、コメントを落としてから走査する。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function read(file: string): string {
  return stripComments(readFileSync(join(ADMIN_DIR, file), 'utf8'));
}

/** admin 配下の .tsx を再帰的に集める。 */
function adminFiles(dir = ADMIN_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return adminFiles(path);
    return e.isFile() && e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [path] : [];
  });
}

/** `<Form ...>` から対応する `</Form>` までを粗く切り出す（入れ子は使っていない）。 */
function formBodies(source: string): string[] {
  return [...source.matchAll(/<Form\b[\s\S]*?<\/Form>/g)].map((m) => m[0]);
}

/** `<Form ...>` の開始タグだけ。 */
function formOpenTags(source: string): string[] {
  return [...source.matchAll(/<Form\b[^>]*>/g)].map((m) => m[0]);
}

/**
 * `<Button ...>` / 生 `<button ...>` の開始タグを全部。
 * 生ボタンも見るのは、`StaffEditor` のように共有部品を使っていない画面があるため。
 */
function buttonTags(source: string): string[] {
  return [...source.matchAll(/<[Bb]utton\b[^>]*>/g)].map((m) => m[0]);
}

/**
 * タグから `data-testid` の**書かれたとおりの**値を取り出す（動的も文字列として返す）。
 *
 * テンプレートリテラルは `${...}` を内側に含むので、`[^}]*` で切ると
 * `` `integration-${it.id `` のように**途中で切れた別物**になる。バッククォートで括る。
 */
function testIdOf(tag: string): string | undefined {
  return (
    /data-testid="([^"]*)"/.exec(tag)?.[1] ??
    /data-testid=\{(`[^`]*`)\}/.exec(tag)?.[1] ??
    /data-testid=\{([A-Za-z0-9_.$]*)\}/.exec(tag)?.[1]
  );
}

/** primary の見た目を持つボタン（共有部品の variant、または生ボタンの primary スタイル）。 */
function isPrimary(tag: string): boolean {
  return /variant="primary"/.test(tag) || /style=\{primary\}/.test(tag);
}

describe('admin CRUD / 設定保存の form 化 (#892 / #893 / 課題 13)', () => {
  it.each(CONVERTED)('$file は Form を使い、$submit が submit ボタンである', ({ file, submit }) => {
    const source = read(file);
    expect(source).toContain("from '@/components/admin/ui'");
    expect(source).toMatch(/<Form\b/);

    const button = new RegExp(`<[Bb]utton[^>]*data-testid="${submit}"[^>]*>`, 's').exec(source)?.[0];
    expect(button, `${submit} のボタンが見つからない`).toBeTruthy();
    expect(button).toContain('type="submit"');
    /*
     * 下界: `onClick` が残っていないこと。残したままでも動くが、送信経路が 2 本になり
     * 「クリックでは動くが Enter では動かない」退行がテストを素通りする。
     */
    expect(button).not.toContain('onClick');
  });

  it('Form を持つ画面には必ず送信手段がある（形だけの form を作らない）', () => {
    const offenders = adminFiles()
      .map((path) => ({ path, source: stripComments(readFileSync(path, 'utf8')) }))
      .filter(({ source }) => /<Form\b/.test(source))
      .filter(({ source }) => {
        return !formBodies(source).every((body, i) => {
          if (body.includes('type="submit"')) return true;
          /*
           * 送信ボタンが `<form>` の**外**にあることがある（`Section` の `actions` に
           * 置かれている等）。HTML の `form="<id>"` で結べるので、それも送信手段と認める。
           * ただし **id が一致すること**まで見る（別の form の id で通ってしまわないように）。
           */
          const id = /\bid="([^"]+)"/.exec(formOpenTags(source)[i] ?? '')?.[1];
          if (id === undefined) return false;
          return new RegExp(`<[Bb]utton[^>]*form="${id}"[^>]*type="submit"`, 's').test(source)
            || new RegExp(`<[Bb]utton[^>]*type="submit"[^>]*form="${id}"`, 's').test(source);
        });
      });
    expect(offenders.map((o) => o.path)).toEqual([]);
  });

  it('Form の中の生 <button> は type を明示する（既定の submit で誤送信しない）', () => {
    const offenders = adminFiles().flatMap((path) => {
      const source = stripComments(readFileSync(path, 'utf8'));
      return formBodies(source)
        .flatMap((body) => [...body.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]))
        .filter((tag) => !/\btype=/.test(tag))
        .map((tag) => `${path}: ${tag}`);
    });
    expect(offenders).toEqual([]);
  });

  it('Form 部品そのものが遷移を止め、レイアウトを動かさない', () => {
    const source = stripComments(readFileSync(join(ADMIN_DIR, 'ui/Form.tsx'), 'utf8'));
    // 遷移を止める（書き忘れると「動くが画面が真っさらになる」形で出る）。
    expect(source).toContain('preventDefault');
    // ブラウザ既定の制約検証を後から足さない（変換前に通っていた送信を黙って止めないため）。
    expect(source).toContain('noValidate');
    // `<form>` の UA 既定 margin を打ち消す。VRT ベースラインを動かさないための条件。
    expect(source).toContain('margin: 0');
  });

  describe('primary ボタンの棚卸し（散文の一覧を信じない / #893）', () => {
    /** 実測: admin 配下の primary ボタン全部を testId で引く。 */
    function primaryButtons(): { path: string; tag: string; testId: string | undefined }[] {
      return adminFiles().flatMap((path) => {
        const source = stripComments(readFileSync(path, 'utf8'));
        return buttonTags(source)
          .filter(isPrimary)
          .map((tag) => ({ path, tag, testId: testIdOf(tag) }));
      });
    }

    it('primary ボタンは必ず data-testid を持つ（分類できない匿名ボタンを作らない）', () => {
      const anonymous = primaryButtons()
        .filter((b) => b.testId === undefined)
        .map((b) => `${b.path}: ${b.tag}`);
      expect(anonymous).toEqual([]);
    });

    it('primary ボタンは submit か、PENDING / ACTIONS のどれかとして宣言されている', () => {
      const declared = new Set<string>([
        ...PENDING.map((p) => p.testId),
        ...ACTIONS.map((a) => a.testId),
      ]);
      const unclassified = primaryButtons()
        .filter((b) => !b.tag.includes('type="submit"'))
        .filter((b) => b.testId === undefined || !declared.has(b.testId))
        .map((b) => `${b.path}: ${b.testId ?? b.tag}`);
      expect(unclassified).toEqual([]);
    });

    /*
     * 🔴 **下界**。上の主張は「全部 ACTIONS に入れる」で空虚に満たせる。残りの数が
     * 嘘にならないよう、**PENDING / ACTIONS に居るものが実際にまだ submit でないこと**と、
     * **CONVERTED と重なっていないこと**を併せて縛る。
     */
    it('PENDING / ACTIONS に居るものは実際に未変換である（消化済みを残さない）', () => {
      const stale = primaryButtons()
        .filter((b) => b.tag.includes('type="submit"'))
        .filter((b) => b.testId !== undefined)
        .filter((b) => PENDING.some((p) => p.testId === b.testId) || ACTIONS.some((a) => a.testId === b.testId))
        .map((b) => `${b.path}: ${b.testId}`);
      expect(stale).toEqual([]);
    });

    it('CONVERTED と PENDING / ACTIONS は重ならない', () => {
      const converted = new Set(CONVERTED.map((c) => c.submit));
      const overlap = [...PENDING, ...ACTIONS].map((x) => x.testId).filter((id) => converted.has(id));
      expect(overlap).toEqual([]);
    });

    it('PENDING / ACTIONS には理由が書かれている', () => {
      const missing = [...PENDING, ...ACTIONS].filter((x) => x.why.trim().length < 10);
      expect(missing.map((x) => x.testId)).toEqual([]);
    });

    /*
     * AC8 の見張り。PENDING が空になったらこのテストが落ちるので、そのとき
     * レジストリ方式をやめて「admin の primary は全部 submit」へ締める。
     */
    it('PENDING が空になったらレジストリ方式をやめる（#893 AC）', () => {
      expect(
        PENDING.length,
        'PENDING が空になった。CONVERTED / PENDING を廃止し、'
          + '「primary は submit か ACTIONS のどちらか」へ締めること（#893 AC）',
      ).toBeGreaterThan(0);
    });
  });
});
