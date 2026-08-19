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
  localFastGate: 'green',
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
    expect(p).toContain('ブランチが出来たこと＝PR が出来たことではない');
  });

  it('マージにも GraphQL を撃つコマンドを指示しない (#702)', () => {
    // 🔴 `gh pr merge` も 403 になる（2026-08-18 / PR #701 で実測）。生成器がこれを
    // 配り続けると、委譲のたびに委譲先が現場で回避策を考える羽目になる（実際そうなった）。
    const p = buildDelegationPrompt(BASE);
    expect(p).not.toContain('gh pr merge <番号>');
    expect(p).toContain('scripts/merge-pull-request.ts');
  });

  it('PR 作成に GraphQL を撃つコマンドを指示しない (#678)', () => {
    // 🔴 **委譲先はクラウドなので、ここで `gh pr create` / `gh pr view` を指示すると
    // 必ず 403 で詰まる。** 2026-08-10 の週次ゲートが実際にこれで落ちた。
    // 生成器が壊れたコマンドを配り続けると、委譲のたびに同じ失敗を再生産する。
    // **配っていた実行形そのものを禁ずる。** 「`gh pr create` は使わないこと」という
    // 注意書きや「`gh pr view --head` は 403」という制約の説明は**残す必要がある**ので、
    // 素の文字列で禁ずると説明ごと消す羽目になる
    // （`bash-source.ts` が扱っているのと同じ「言及 vs 本物」の区別）。
    const p = buildDelegationPrompt(BASE);
    expect(p).not.toContain('gh pr create --base');
    expect(p).not.toContain('gh pr view --json');
    expect(p).toContain('scripts/create-pull-request.ts');
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
    it('既定（省略時）はマージ手順を含める', () => {
      // 既定は「マージまで完結させる」。**手段は REST へ移った (#702)** が、
      // 「既定でマージまで行く」という契約そのものは変えない。
      const p = buildDelegationPrompt(BASE);
      expect(p).toContain('scripts/merge-pull-request.ts');
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
      expect(p).toContain('scripts/create-pull-request.ts');
      expect(p).toContain('ブランチが出来たこと＝PR が出来たことではない');
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
  describe('ローカル --fast の申告 (#705)', () => {
    /**
     * 生成器は「ローカル `--fast` は green」を**無条件で**出していた。入力に無い、
     * 生成器には確かめようがない事実で、2026-08-18 にメモリ枯渇で `--fast` が完走
     * しなかった周回でも「green」と書いた。**断定してよいのは入力から導けることだけ。**
     */
    const ASSERTION = 'ローカル `--fast` は green';

    it('green を申告したときだけ「ローカル --fast は green」と書く', () => {
      expect(buildDelegationPrompt({ ...BASE, localFastGate: 'green' })).toContain(ASSERTION);
    });

    /**
     * 🔴 **`'唯一の根拠'` だけを見てはいけない。** 同じ語は手順 5（change-risk）にも出るので、
     * それだけだと**ローカルゲートの一文が丸ごと消えても通る**（レビューの変異で実証された）。
     * **この行にしか現れない文字列**で縛る。
     */
    const SOLE_EVIDENCE = 'このクラウド実行の `--full` が唯一の根拠です';

    /**
     * 🔴 **「裏取り済みの green」と「測れなかった green」を同じ本文にしない (#711)。**
     * スタンプは worktree ごとに独立で、新しい worktree では**必ず**記録が無い＝判定不能。
     * そこで出力が 1 バイトも変わらなければ、#705 の事象（走らせていないのに green と
     * 申告して委譲する）はその経路で今も無傷のまま通る。fail-open は保つが、
     * **測れなかったことは数える**（#726 の原則）。
     */
    const UNVERIFIED = 'ゲートスタンプでは裏取りできませんでした';

    it('🔴 裏取りできていない green は、その旨と「--full が唯一の根拠」を本文に出す', () => {
      const p = buildDelegationPrompt({ ...BASE, localFastGate: 'green' }, 'unverified');
      expect(p).toContain(UNVERIFIED);
      expect(p).toContain(SOLE_EVIDENCE);
    });

    it('裏取り済みの green はその旨を書き、裏取り不能の警告を出さない', () => {
      const p = buildDelegationPrompt({ ...BASE, localFastGate: 'green' }, 'verified');
      expect(p).toContain('ゲートスタンプで裏取り済み');
      expect(p).not.toContain(UNVERIFIED);
    });

    it('🔴 渡し忘れは「裏取り済み」ではなく「裏取りしていない」へ倒す', () => {
      // 既定を verified にすると、呼び出し側の配線が外れた瞬間に**黙って**
      // 「裏取り済み」と書き始める。安全側は unverified。
      expect(buildDelegationPrompt({ ...BASE, localFastGate: 'green' })).toContain(UNVERIFIED);
    });

    it.each([
      ['not-run', '実行されていません'],
      ['failed', '失敗しました'],
    ] as const)('%s のとき green という断定が出力に現れない', (state, wording) => {
      const p = buildDelegationPrompt({
        ...BASE,
        localFastGate: state,
        localFastGateNote: '負荷でゲートが完走しなかった',
      });
      expect(p).not.toContain(ASSERTION);
      // 委譲先が「ローカルで通っていたのだから環境要因か」と誤読しないよう、
      // 何が唯一の根拠なのかを明示する。
      expect(p).toContain(SOLE_EVIDENCE);
      expect(p).toContain('推測をしないこと');
      expect(p).toContain('負荷でゲートが完走しなかった');
      // **state ごとの語を固定する。** 取り違え（落ちた／実行していない）は委譲先の初動を
      // 変える（既知の赤の再現確認 vs 初回実行）ので、入れ替わっても通ってはいけない。
      expect(p).toContain(wording);
    });

    it('failed で理由が無ければ投げる', () => {
      // Conventional Commits 検査と同じ扱い。理由なしの「失敗」は委譲先が判断に使えない。
      expect(() =>
        buildDelegationPrompt({ ...BASE, localFastGate: 'failed' }),
      ).toThrow(/localFastGateNote|理由/);
      expect(() =>
        buildDelegationPrompt({ ...BASE, localFastGate: 'failed', localFastGateNote: '   ' }),
      ).toThrow(/localFastGateNote|理由/);
    });

    it('not-run は理由が無くても投げないが、green とは書かず「理由の申告なし」と明示する', () => {
      const p = buildDelegationPrompt({ ...BASE, localFastGate: 'not-run' });
      expect(p).not.toContain(ASSERTION);
      expect(p).toContain(SOLE_EVIDENCE);
      // **空欄で濁さない。** 理由が無いこと自体を書く（測れなかったものを黙って空にしない）。
      expect(p).toContain('理由の申告なし');
    });

    it('申告が欠けている spec（JSON 経由）は実行時に投げる', () => {
      // `scripts/delegate-gate-prompt.ts` は spec.json を `as DelegationInput` で
      // キャストするだけなので、型だけでは欠落を止められない。**実際の呼び出し経路が
      // JSON である以上、実行時にも縛る。**
      const { localFastGate: _omitted, ...withoutDeclaration } = BASE;
      expect(() =>
        buildDelegationPrompt(withoutDeclaration as unknown as DelegationInput),
      ).toThrow(/localFastGate/);
      // 🔴 **AC1（省略すると型エラー）を機械で固定する。** 上の実行時チェックは
      // `as unknown as` で型を迂回しているので、将来 `localFastGate?:` と任意化されても
      // typecheck もテストも通ってしまう。`@ts-expect-error` を置くと、任意化した瞬間に
      // 「エラーが出るはずの箇所でエラーが出ない」で typecheck が落ちる。
      expect(() =>
        // @ts-expect-error localFastGate は必須（省略できない / #705）
        buildDelegationPrompt(withoutDeclaration),
      ).toThrow(/localFastGate/);
      expect(() =>
        buildDelegationPrompt({ ...BASE, localFastGate: 'GREEN' as unknown as 'green' }),
      ).toThrow(/localFastGate/);
    });
  });

  describe('停止境界を断定しない (#705)', () => {
    it('「停止境界には触れていません」と断定しない', () => {
      // 生成器は変更が停止境界に触れるかを判断できない。入力にも無い。
      for (const state of ['green', 'not-run', 'failed'] as const) {
        const p = buildDelegationPrompt({
          ...BASE,
          localFastGate: state,
          localFastGateNote: '理由',
        });
        expect(p).not.toContain('停止境界には触れていません');
      }
    });

    it('代わりに change-risk の報告を求める手順が入る', () => {
      // 憶測をやめ、実行したセッションだけが持つ事実（ゲート出力）を根拠にする。
      //
      // 🔴 **`'change-risk'` だけを見てはいけない。** PR 本文の指示にも同じ語が出るので、
      // それだけだと**手順が丸ごと消えてもテストが通る**（変異で実際に生き残った）。
      // 手順にしか現れない文字列で縛る。
      const p = buildDelegationPrompt(BASE);
      expect(p).toContain('`change-risk (停止境界)` 節');
      // 手順として（番号付きで）入っていること。
      expect(p).toMatch(/^\d+\. ゲート出力の `change-risk \(停止境界\)` 節/m);
      // PR 本文側にも貼らせること。
      expect(p).toContain('人間承認が必要な変更');
    });
  });
});
