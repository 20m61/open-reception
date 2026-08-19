import { describe, expect, it } from 'vitest';
import {
  GRAPHQL_OBSERVATIONS,
  GRAPHQL_REST_ROUTE,
  OBSERVATION_CAVEAT,
  OBSERVATION_HEADING,
  REST_UNCONDITIONAL,
  buildDelegationPrompt,
  warnSpecFreeText,
  type DelegationInput,
} from './delegation-prompt';

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

  it('「要約の緑だけを信じるな」と infra の偽 green の見分け方を必ず含める', () => {
    const p = buildDelegationPrompt(BASE);
    expect(p).toContain('要約の緑だけを信じず');
    // 見分け方は残す（#642 の偽 green を検出するために置いた一文）。
    expect(p).toContain('skipped');
  });

  /**
   * 🔴 **実測値を焼き込まない (#710)。** 生成器はテスト件数を数えていない（`DelegationInput`
   * に無い）のに `138 passed (138)` が本物だと書いていた。**単調に増える値**なので放置すれば
   * 必ず陳腐化し、実際に 2026-08-18 の PR #708 では `153 passed (153)` が出ていた。
   * 委譲先は「本物の green を偽と疑う」か「skip 混じりで偶然 138 になった出力を本物と読む」
   * のどちらにも倒れうる —— **検出器として置いた一文が検出器でなくなっていた。**
   *
   * 数値ではなく**性質**（`N passed (N)` の形＝ skip が 0）で書けば、数えなくて済む。
   */
  it('🔴 テスト件数を焼き込まない（数えていない値を断定しない）', () => {
    const p = buildDelegationPrompt(BASE);
    expect(p, '生成器が数えていないテスト件数を本文に書いている').not.toMatch(/\d+ passed/);
    // 置き換えた中身（本物の形と「数えるな」）も残す。片方だけ消えても落ちるように。
    expect(p, '本物の形が書かれていない').toContain('N passed (N)');
    expect(p, '件数を数えるなと言っていない').toMatch(/件数[^。]*数えない/);
  });

  it('🔴 所要時間も焼き込まない（生成器は測っていない）', () => {
    // `3〜5 分` も `DelegationInput` に無く測っていない値。実測が伸びたとき、
    // 委譲先が hang と誤認して kill すると**ゲートが走らないまま終わる**。
    const p = buildDelegationPrompt(BASE);
    expect(p, '測っていない所要時間を書いている').not.toMatch(/\d+\s*〜\s*\d+\s*分/);
    expect(p).toContain('時間の長さで失敗と判断しないこと');
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

  /**
   * 🔴 **委譲先の権限状態を断定しない (#710)。** 403 は `DelegationInput` に無く、生成器は
   * 確かめていない。**同じファイルの数行上に、この危険が自分の言葉で書いてあった** ——
   * 「PR #665 の時点では両方通っていた（当時の記述は正しく、今は誤り）。**通っていたことを
   * 根拠に残さない**」。原則が片方向にしか適用されていなかった。
   *
   * 観測の範囲つきにすれば、次に実測が変わったとき**委譲先が気づいて報告できる**。
   * 一方で**コマンドの指示は無条件のまま**でよい —— REST だけを使う経路は権限状態に
   * よらず通るので、弱める理由が無い（#678 / #702 の損失はここを配り損ねた結果）。
   */
  /** 「環境の既知の制約」節を切り出す。取れなければ落とす（黙って全文を見ない）。 */
  const constraintSection = (stopAfter: 'pr' | 'merge'): string => {
    const p = buildDelegationPrompt({ ...BASE, stopAfter });
    const from = p.indexOf('## 環境の既知の制約');
    const to = p.indexOf('## 禁止事項');
    expect(from, '環境の既知の制約 節が無い').toBeGreaterThan(-1);
    expect(to, '禁止事項 節が 環境の既知の制約 より後ろに無い').toBeGreaterThan(from);
    return p.slice(from, to).trim();
  };

  /**
   * 🔴 **語彙ではなく構造で縛る (#710 レビュー MAJOR-2)。**
   *
   * 最初は「`403 になる` と書かない」「`このセッションでは` と書かない」という*語彙*で
   * 縛ったが、**言い換えた再断定が素通りした** ——「あなたの環境でも必ず 403 です」を
   * 挿しても `時点の観測` と `違っていたら` は前後に残るので通り、
   * 「必ず 403 です —— 違っていたら報告してください」という**自己矛盾した本文が
   * 無検出で出荷可能**だった（レビューの変異で実証）。
   *
   * `gate-stamp-check.ts` に同じ教訓が既に書いてある（語彙リストを足すのではなく
   * 形を変える）。節本文を部品の連結だけで組み立て、**部品から組み直した文字列との
   * 完全一致**で縛る。期待値を `renderEnvironmentConstraints` から作らないこと ——
   * 描画関数どうしの比較はトートロジーで、両辺が同時に動いて通ってしまう（#711 で踏んだ）。
   */
  it.each(['merge', 'pr'] as const)('🔴 stopAfter: %s の制約節は部品の連結だけで出来ている', (stopAfter) => {
    // 期待値は**部品から組み直す**。描画関数と比べるとトートロジー（両辺が同時に動く）。
    const shown = GRAPHQL_OBSERVATIONS.filter((o) => stopAfter === 'merge' || !o.command.includes('merge'));
    const lines = shown.map((o) => `- ${o.date} 時点の観測: \`${o.command}\` が ${o.status}（${o.refs.map((n) => `#${n}`).join(' / ')}）`);
    const expected =
      `${OBSERVATION_HEADING}\n${lines.join('\n')}\n\n  ` +
      OBSERVATION_CAVEAT +
      GRAPHQL_REST_ROUTE[stopAfter] +
      REST_UNCONDITIONAL;
    expect(constraintSection(stopAfter)).toBe(`## 環境の既知の制約\n\n${expected}`);
  });

  /**
   * 🔴 **観測は data で持つ (#728)。** 以前はここが自由文の定数で、断定を書き足す変異が
   * 素通りした（レビューの実測で 6 通り）。行の描画は `environment-observation.ts` の
   * 固定テンプレなので、**観測の行に自由文を入れる場所が無い**。
   */
  it('🔴 観測はすべて日付・コマンド・ステータス・参照を持つ', () => {
    expect(GRAPHQL_OBSERVATIONS.length).toBeGreaterThan(0);
    for (const o of GRAPHQL_OBSERVATIONS) {
      expect(o.date, `観測に日付が無い: ${o.command}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.command).not.toBe('');
      expect(o.status).toBeGreaterThan(0);
      expect(o.refs.length).toBeGreaterThan(0);
    }
  });

  it("🔴 stopAfter: 'pr' の観測に merge 系を混ぜない (#680)", () => {
    expect(constraintSection('pr')).not.toContain('gh pr merge');
  });

  /**
   * 🔴 **等式は部品の「中身」を守らない (#710 レビュー MAJOR-A)。** 期待値も実物も同じ
   * 定数から出来ているので、定数の中へ断定や逃げ道を書き足す変異は**両辺が同時に動いて
   * 通る**。実測で 6 通りの言い換えが素通りした（`あなたの環境でも 403 です` /
   * `とはいえ実際には例外なく 403 です` / `403 は必ず返ります`（語順で正規表現を回避）/
   * `GRAPHQL_REST_ROUTE` を空にする、等）。中身は正の pin と文単位の規則で守る。
   */
  it.each(['merge', 'pr'] as const)('🔴 stopAfter: %s の REST 経路の部品が骨抜きにされていない', (stopAfter) => {
    // 手順節にも同じ文字列が出るので、**定数そのもの**に対して要求する
    // （本文への `toContain` では手順 6 / 11 が満たしてしまい、部品が空でも通った）。
    expect(GRAPHQL_REST_ROUTE[stopAfter]).toContain('scripts/create-pull-request.ts');
    if (stopAfter === 'merge') {
      expect(GRAPHQL_REST_ROUTE[stopAfter]).toContain('scripts/merge-pull-request.ts');
    }
  });

  it.each(['merge', 'pr'] as const)(
    '🔴 stopAfter: %s では、本文の**どこで**403 を語っても観測時点が同居する',
    (stopAfter) => {
      // 🔴 **節スコープでは足りない (#728 R3)。** 手順など制約節の**外**へ
      // 「なおクラウドでは GraphQL は 403 です」を混ぜる変異は、節だけ見ていると素通りする。
      const whole = buildDelegationPrompt({ ...BASE, stopAfter });
      for (const sentence of whole.split(/[。\n]/).filter((t) => t.includes('403'))) {
        expect(sentence, `観測時点の無いまま 403 を語っている: ${sentence}`).toMatch(
          /\d{4}-\d{2}-\d{2}|時点の観測|#\d+/,
        );
      }
    },
  );

  it.each(['merge', 'pr'] as const)(
    '🔴 stopAfter: %s の制約節で、403 を語る文には必ず観測時点が同居する',
    (stopAfter) => {
      // 🔴 **語彙の禁止では足りない。** `必ず 403` を禁じても `403 は必ず返ります` は
      // 語順で抜ける。「403 を主張するなら、いつの観測かを添える」という**文単位の規則**
      // なら語順に依存しない。断定を書き足すには日付を偽るしかなくなる。
      const sentences = constraintSection(stopAfter)
        .split('。')
        .filter((t) => t.includes('403'));
      expect(sentences.length, '403 に触れる文が 1 つも無い').toBeGreaterThan(0);
      for (const sentence of sentences) {
        expect(sentence, `観測時点の無いまま 403 を語っている: ${sentence}`).toMatch(
          /\d{4}-\d{2}-\d{2}|時点の観測|#\d+/,
        );
      }
    },
  );

  it('🔴 但し書きが報告を求めている（限定しすぎてもいない）', () => {
    // REST の失敗は理由を問わず報告してもらう。「403 以外」と書くと、
    // 「REST は権限状態によらず通る」を反証する唯一の観測を報告対象から外すことになる。
    expect(OBSERVATION_CAVEAT).toMatch(/報告してください/);
    expect(OBSERVATION_CAVEAT, 'REST の 403 を報告対象から外している').not.toContain('403 以外');
  });

  it('🔴 見出しは保証でないと言い、但し書きは確かめに行けと言わない', () => {
    expect(OBSERVATION_HEADING, '保証ではないと言っていない').toContain('保証ではありません');
    // 「確かめに行け」と読ませない。全経路を REST に寄せている以上、「通った」を観測できる
    // のは委譲先がわざわざ GraphQL を撃ったときだけになる（レビュー Minor-3）。
    expect(OBSERVATION_CAVEAT).toContain('確かめに行く必要はありません');
  });

  it.each(['merge', 'pr'] as const)('🔴 stopAfter: %s で現在形の断定が残っていない', (stopAfter) => {
    const p = buildDelegationPrompt({ ...BASE, stopAfter });
    expect(p).not.toMatch(/403 に(なる|なります)/);
    expect(p, '委譲先のセッションについて断定している').not.toContain('このセッションでは');
    // 言い換えによる再断定も、節スコープでは意味の側から塞ぐ（構造の縛りとの二重）。
    expect(constraintSection(stopAfter)).not.toMatch(/(必ず|常に|確実に)\s*403/);
  });

  /**
   * 🔴 **禁止文そのものを縛る (#710 レビュー MAJOR-1)。**
   *
   * 前版は `toContain('scripts/create-pull-request.ts')` と
   * `not.toContain('gh pr create --base')` の 2 本で、**どちらも既存テストの真部分集合**
   * だった（＝単独では構造上ほぼ絶対に落ちない）。実際、手順 6 の「使わないこと」を
   * 「もし通るならそれでもよいが」へ弱めても全テストが green のままだった。
   * #678 / #702 の実損（壊れたコマンドを配る）と**対称の欠陥**で、しかも周囲の文言を
   * 書き換えたこの周回こそ、この保護が要るタイミングだった。
   */
  it.each(['merge', 'pr'] as const)('🔴 stopAfter: %s で REST 経路の指示が無条件に残る', (stopAfter) => {
    const p = buildDelegationPrompt({ ...BASE, stopAfter });
    expect(p, 'gh pr create の禁止文が消えている').toContain('`gh pr create` は使わないこと');
    if (stopAfter === 'merge') {
      expect(p, 'gh pr merge の禁止文が消えている').toContain('`gh pr merge` は使わないこと');
      expect(p).toContain('scripts/merge-pull-request.ts');
    }
    expect(p).toContain('scripts/create-pull-request.ts');
    // 断定をやめても指示は弱まらない、という根拠の一文（レビュー Minor-2）。
    expect(constraintSection(stopAfter)).toContain('権限状態によらず通る');
    // 🔴 **緩和語彙は本文全文で禁じ、て/で の両方を拾う (#710 レビュー MAJOR-B)。**
    // 前版は手順節だけを見て `でもよい` を禁じていたので、日本語で最も自然な緩和形
    // `使ってもよい`（**て**）も、制約節や末尾へ足した「通る環境なら使ってもよいです」も
    // 素通りした。禁止文を**残したまま同じ文中で**骨抜きにできる状態だった。
    expect(p, '緩和語彙で禁止文が骨抜きにされている').not.toMatch(
      /(て|で)もよい|(て|で)も構いません|問題ありません|差し支え|可能なら|推奨します|任意です/,
    );
    // 🔴 **`gh pr create` / `gh pr merge` に触れてよいのは「禁じる」か「観測を述べる」
    // ときだけ。** 3 つ目の文脈（勧める・許す）が増えたら落ちる。件数で縛ると正当な
    // 言及（手順の禁止文＋制約節の観測）まで巻き込むので、文ごとの役割で縛る。
    for (const cmd of ['gh pr create', 'gh pr merge']) {
      const mentions = p.split(/[。\n]/).filter((t) => t.includes(cmd));
      for (const sentence of mentions) {
        expect(sentence, `${cmd} を禁止でも観測でもない文脈で挙げている: ${sentence}`).toMatch(
          /使わないこと|403/,
        );
      }
    }
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

describe('headSha の形 (#711 レビュー Minor-3)', () => {
  it('🔴 短すぎる headSha を弾く（委譲先の取り違え検出まで弱まる）', () => {
    // 生成される手順 1 は `git rev-parse HEAD` が headSha で「始まる」ことを見るので、
    // 1 文字なら 16 分の 1 の確率で別コミットでも通ってしまう。
    expect(() => buildDelegationPrompt({ ...BASE, headSha: 'c' })).toThrow(/16 進|7〜64/);
  });

  it('🔴 16 進でない headSha を弾く', () => {
    expect(() => buildDelegationPrompt({ ...BASE, headSha: 'not-a-sha' })).toThrow(/16 進|7〜64/);
  });

  it('7 桁以上の 16 進は通す（大文字も）', () => {
    expect(() => buildDelegationPrompt({ ...BASE, headSha: 'C70EA47' })).not.toThrow();
  });
});

describe('branch の検証 (#711 レビュー Minor-4)', () => {
  it('🔴 branch が欠けたら投げる（委譲先が checkout する対象）', () => {
    // 欠けたまま通すと、委譲先の手順 1 が `git checkout undefined` になり、
    // 裏取りも `origin/undefined` を引いて「まだ push していない」という
    // **誤った理由**で格下げする。headSha より load-bearing。
    const { branch: _omitted, ...withoutBranch } = BASE;
    expect(() => buildDelegationPrompt(withoutBranch as unknown as typeof BASE)).toThrow(/branch/);
    expect(() => buildDelegationPrompt({ ...BASE, branch: '  ' })).toThrow(/branch/);
  });
});

describe('stopAfter の検証 (#710 レビュー Minor-2)', () => {
  it('🔴 不正な stopAfter を弾く（リテラル undefined が本文へ出る回帰）', () => {
    // 🔴 実経路は spec.json の `as DelegationInput` キャストなので、型では止まらない。
    // `Record` 引きにした結果、未知の値だと**リテラル `undefined` が本文に出て
    // REST 経路の一文が消える**（三項演算子だった頃は `pr` 側へ縮退していた）。
    expect(() =>
      buildDelegationPrompt({ ...BASE, stopAfter: 'PR' as unknown as 'pr' }),
    ).toThrow(/stopAfter/);
  });

  it('🔴 どの stopAfter でも本文にリテラル undefined が出ない', () => {
    for (const stopAfter of ['pr', 'merge'] as const) {
      expect(buildDelegationPrompt({ ...BASE, stopAfter })).not.toContain('undefined');
    }
  });
});

describe('spec の自由文の検査を配線する (#729)', () => {
  /**
   * 🔴 **危ないのは配線。** 判定は `spec-free-text.ts` でテスト済みだが、
   * `validateDelegationInput` が呼ばなくなっても、あるいは結果を無視しても、
   * そちらのテストは全部 green のままになる。この一連の周回で何度も踏んでいる型。
   */
  it('🔴 403 になる実行形を含む spec は組み立てを止める', () => {
    expect(() =>
      buildDelegationPrompt({ ...BASE, extraVerification: ['`gh pr create --fill` で PR を作る'] }),
    ).toThrow(/gh pr create/);
  });

  it('🔴 止めた spec の本文をどこにも出さない（嘘の指示を配らない）', () => {
    let built = '';
    try {
      built = buildDelegationPrompt({ ...BASE, summary: '`gh pr merge 123` でマージした。' });
    } catch {
      // 期待どおり
    }
    expect(built).toBe('');
  });

  it('禁止・観測の文脈なら通す（注意書きを書けなくしない）', () => {
    expect(() =>
      buildDelegationPrompt({ ...BASE, extraProhibitions: ['`gh pr create` は使わないこと'] }),
    ).not.toThrow();
  });

  it('緩和語彙は止めず、警告として取り出せる', () => {
    const input = { ...BASE, extraVerification: ['`npm run x` を実行（可能なら 2 回）'] };
    expect(() => buildDelegationPrompt(input)).not.toThrow();
    expect(warnSpecFreeText(input).map((f) => f.severity)).toEqual(['warn']);
  });

  it.each(['refs', 'changedFiles'] as const)('🔴 %s が欠けたら読めるメッセージで止まる', (field) => {
    // 以前は `input.refs.map` の TypeError になり、#711 で回復した「読めるメッセージ」が
    // スタックトレース文字列へ劣化していた。
    const { [field]: _omitted, ...without } = BASE;
    // 動的な `new RegExp(field)` は semgrep の ReDoS ルールに当たる（実際に --full が赤くなった）。
    // 文字列を渡せば vitest は部分一致で見るので、ここでは正規表現が要らない。
    expect(() => buildDelegationPrompt(without as unknown as typeof BASE)).toThrow(field);
  });
});
