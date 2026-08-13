import { describe, expect, it } from 'vitest';
import { buildDelegationPrompt, type DelegationInput } from './delegation-prompt';

/**
 * 委譲プロンプトの生成。
 *
 * 固定するのは「**抜けると実害が出た手順**が必ず入ること」。2026-08-08〜09 に 13 回
 * 手書きした中で、抜けたら壊れるものが分かっている。
 */

const BASE: DelegationInput = {
  branch: 'feat/x',
  headSha: 'abc1234',
  baseSha: 'def5678',
  title: 'feat(kiosk): 何かをする',
  summary: '説明。',
  changedFiles: ['src/a.ts'],
  refs: [656],
};

describe('buildDelegationPrompt', () => {
  it('head SHA の突き合わせを必ず要求する', () => {
    // ブランチ取り違えは静かに間違ったものをマージする。最初に潰す。
    const p = buildDelegationPrompt(BASE);
    expect(p).toContain('abc1234');
    expect(p).toContain('そこで止めて報告');
  });

  it('build:open-next を必ず含める', () => {
    // 抜くと `.open-next` が stale 扱いになり、ゲートが green を記録しない（#642）。
    expect(buildDelegationPrompt(BASE)).toContain('build:open-next');
  });

  it('「要約の緑だけを信じるな」と infra の偽 green を必ず含める', () => {
    const p = buildDelegationPrompt(BASE);
    expect(p).toContain('要約の緑だけを信じず');
    expect(p).toContain('138 passed (138)');
  });

  it('PR の実在確認を必ず含める（#656 の再発防止）', () => {
    // **これが抜けると #656 そのもの。** ブランチが出来たこと＝PR が出来たことではない。
    const p = buildDelegationPrompt(BASE);
    expect(p).toContain('gh pr view --json number,url');
    expect(p).toContain('ブランチが出来たこと＝PR が出来たことではない');
  });

  it('クラウドの GraphQL 制約を必ず伝える', () => {
    // 知らないと `gh pr list` を使って 403 で詰まる（今日 4 周分を失った経路）。
    expect(buildDelegationPrompt(BASE)).toContain('GraphQL');
  });

  it('既定の禁止事項を必ず含める', () => {
    const p = buildDelegationPrompt(BASE);
    expect(p).toContain('`--no-verify` を使わないこと');
    expect(p).toContain('テストの削除・skip・弱体化');
  });

  it('Conventional Commits でないタイトルを拒否する', () => {
    // squash 後の main コミットになるので、後から直せない。
    expect(() => buildDelegationPrompt({ ...BASE, title: '何かをする' })).toThrow(
      /Conventional Commits/,
    );
    expect(() => buildDelegationPrompt({ ...BASE, title: 'wip: あとで直す' })).toThrow();
  });

  it('よくある type は通す', () => {
    for (const t of ['feat: a', 'fix(governance): a', 'docs(loop): a', 'refactor!: a']) {
      expect(() => buildDelegationPrompt({ ...BASE, title: t })).not.toThrow();
    }
  });

  it('head SHA が空なら拒否する', () => {
    expect(() => buildDelegationPrompt({ ...BASE, headSha: '  ' })).toThrow(/headSha/);
  });

  it('追加検証があってもゲートとビルドの手順が消えない', () => {
    // 🔴 実際に落としていた。添字で組み立てていたため、追加検証を入れると
    // **ゲートの手順ごと消えていた**。手順が黙って消えるのが最悪の壊れ方。
    const p = buildDelegationPrompt({ ...BASE, extraVerification: ['`npm run 目的の確認`'] });
    expect(p).toContain('quality-gate.sh --full');
    expect(p).toContain('build:open-next');
  });

  it('追加検証はビルドとゲートより前に置く（その周回の目的を先に確かめる）', () => {
    const p = buildDelegationPrompt({ ...BASE, extraVerification: ['`npm run 目的の確認`'] });
    expect(p.indexOf('目的の確認')).toBeLessThan(p.indexOf('quality-gate.sh --full'));
    expect(p.indexOf('目的の確認')).toBeLessThan(p.indexOf('build:open-next'));
  });

  it('追加の禁止事項は既定へ足される（置き換えない）', () => {
    const p = buildDelegationPrompt({ ...BASE, extraProhibitions: ['固有の禁止'] });
    expect(p).toContain('固有の禁止');
    expect(p).toContain('`--no-verify` を使わないこと');
  });

  it('Refs に全 issue 番号を載せる', () => {
    expect(buildDelegationPrompt({ ...BASE, refs: [656, 612] })).toContain('Refs #656 #612');
  });

  describe('stopAfter', () => {
    it('既定（省略時）は現行どおり gh pr merge を手順に含める', () => {
      // 既定の振る舞いは 1 バイトも変えない。
      const p = buildDelegationPrompt(BASE);
      expect(p).toContain('gh pr merge <番号> --squash --delete-branch');
      expect(p).toContain('マージまで**このセッション内で完結**させてください');
    });

    it("stopAfter: 'merge' を明示しても既定と同じ出力になる", () => {
      expect(buildDelegationPrompt({ ...BASE, stopAfter: 'merge' })).toBe(buildDelegationPrompt(BASE));
    });

    it("stopAfter: 'pr' の出力に gh pr merge がどこにも現れない", () => {
      // #680 で実際に起きた自己矛盾（手順は merge、禁止事項も merge 禁止）の再発防止。
      const p = buildDelegationPrompt({ ...BASE, stopAfter: 'pr' });
      expect(p).not.toContain('gh pr merge');
    });

    it("stopAfter: 'pr' は冒頭の「マージまで完結」文言も出さない", () => {
      const p = buildDelegationPrompt({ ...BASE, stopAfter: 'pr' });
      expect(p).not.toContain('マージまで**このセッション内で完結**させてください');
    });

    it("stopAfter: 'pr' はマージ禁止を呼び出し側が書かなくても禁止事項へ自動で入れる", () => {
      const p = buildDelegationPrompt({ ...BASE, stopAfter: 'pr' });
      expect(p).toMatch(/マージ(しない|するな|禁止)/);
    });

    it("stopAfter: 'pr' でも PR 作成の手順・PR 実在確認は残る", () => {
      const p = buildDelegationPrompt({ ...BASE, stopAfter: 'pr' });
      expect(p).toContain('gh pr create --base main');
      expect(p).toContain('gh pr view --json number,url');
    });

    it('手順に gh pr merge が残ったまま、禁止事項に手書きのマージ禁止を足すと矛盾として投げる', () => {
      // #680 で実際にやってしまったこと: extraProhibitions に「マージしないこと」を
      // 手で入れても、既定（stopAfter 省略 = 'merge'）では手順11に gh pr merge が残る。
      // 1 つのプロンプトの中で手順と禁止事項が矛盾する状態を、投げて防ぐ。
      expect(() =>
        buildDelegationPrompt({ ...BASE, extraProhibitions: ['マージしないこと'] }),
      ).toThrow(/矛盾|マージ/);
    });

    it("stopAfter: 'pr' なら extraProhibitions にマージ禁止を書いても（自動追加と重複しても）矛盾にならない", () => {
      // 'pr' では手順側に gh pr merge が無いので、同じ趣旨の禁止事項が重複しても矛盾ではない。
      expect(() =>
        buildDelegationPrompt({
          ...BASE,
          stopAfter: 'pr',
          extraProhibitions: ['マージしないこと'],
        }),
      ).not.toThrow();
    });
  });
});
