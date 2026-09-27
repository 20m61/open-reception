/**
 * 🔴 **テストが作る一時領域は、必ず回収される形でしか作れない (#1136)。**
 *
 * 2026-09-17、`/tmp` に 18,726 エントリが積もり、**ディスクは 22G 空いていたのに**
 * `capability-doc-sync.test.ts` が `Test timed out in 5000ms`（実測 8751ms）で落ちた。
 * 単独実行では 663ms / 16 passed。掃除して green。#721 と同じ「資源が症状を指さない」型である。
 *
 * ## 🔴 走査で綴りを数え上げる方式は撤回した（レビュー 2 周目）
 *
 * 当初は「一時領域を作る形を helper 1 つに限る」をソース走査で担保し、
 * **呼び出しの綴り → import の綴り**と 2 度作り替えた。どちらも fail-open で、
 * 2 周目の実測では **16 綴りのうち 10 が素通り**した（名前空間 import・`node:` 無し・
 * prettier が普通に生成する複数行 import・`require`・動的 `import()`・re-export・
 * `'/tmp/...'` 直書き）。#1136 の支配的な原因を復活させても**ガードは緑だった**。
 *
 * **綴りを足す対処はしない**（このリポジトリが何度も撤回してきた「数え上げ」である）。
 * 方式を裏返し、回収は**実行時の隔離**（`tests/setup/temp-isolation.ts` が
 * テストファイルごとに `TMPDIR` を切る）が担う。`os.tmpdir()` は `TMPDIR` を
 * 呼び出しのたびに読むので、**どの綴りで作られたものも**その root に落ち、
 * ファイル終了時に root ごと消える。
 *
 * ## だからこの走査が見張る面は 2 つだけになった
 *
 * 1. `/tmp`（や `/var/folders`）を**絶対パスで直書き**する ―― `TMPDIR` を通らない
 * 2. 逸脱マーカー（`// temp-ok:`）に**理由を書かない** ―― 唯一の抜け道なので理由は必須
 *
 * 🔴 **「`TMPDIR` の上書き」は走査から外した（レビュー 3 周目 MAJOR 2）。**
 * 代入の綴りを追うのは**まだ数え上げ**で、6 綴りが素通りしていた（実測）。
 * この面は `tests/setup/temp-isolation.ts` の `afterAll` が**実行時に**
 * `os.tmpdir() !== fileRoot` で見る —— 綴りに依らず、逃げたそのファイルで大声で落ちる。
 *
 * この 2 つ以外は走査しない。**綴りの列挙は消えた**（helper 経由で作るのは
 * 「テストごとに小さく保つ」ための作法であって、リークの防壁ではなくなった）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../helpers/temp';
import { SWEEP_AGE_MS, sweepStaleRoots } from '../setup/temp-isolation';

const ROOT = process.cwd();

/**
 * 検査対象。
 *
 * 🔴 **`infra/test/**` は射程外**（別 vitest プロジェクトで、この helper を解決できない）。
 * あちらは `infra/test/setup/cdk-outdir.ts` が独自に回収しており、ゲートの
 * 「一時領域 (#721)」が `open-reception-cdk-*` として**別に数えている**。
 */
// 🔴 **`scripts/**` は射程外（レビュー 2 周目 MINOR 5）。** 今日 `scripts/**` に
//    `tmpdir` / `mkdtemp` は 0 件（走査で確認）。helper は vitest の `afterEach` に
//    依るので `scripts/*.ts`（ゲートから実走されるだけの CLI）からは import できず、
//    「helper 経由にせよ」という指示が出せない。生えたときは別ルールが要る。
const SCANNED_ROOTS = ['tests', 'src'];

/**
 * 🔴 **`tests/e2e/**` は射程外（レビュー 1 周目 MINOR 5）。** playwright の spec は
 * vitest の `afterEach` を使えないので、この helper に**従えない** ——
 * fail-closed にしておくと「検出器を編集して逃げる」しか出口が無くなる。
 * 今日 `tests/e2e/**` に一時領域の生成元は無い（走査で確認済み）。
 */
const EXCLUDED = join('tests', 'e2e') + '/';

/**
 * 走査から外す 2 ファイル。**どちらも機構そのもの**である。
 * - helper … 一時領域を作る作法（テストごとに小さく保つ）
 * - 隔離の setup … `process.env.TMPDIR` を切り替える当事者。ここが当たるのは当然
 */
const HELPER = join('tests', 'helpers', 'temp.ts');
const ISOLATION_SETUP = join('tests', 'setup', 'temp-isolation.ts');

/**
 * 走査の下界のために、わざと隔離を迂回している fixture（実行されない）。
 * 静的に見る面は 2 つだけ:
 * 1. 絶対パスの直書き（`TMPDIR` を通らない）
 * 2. 逸脱マーカーに**理由を書かない**（唯一の抜け道なので理由を必須にしている）
 *
 * 🔴 `TMPDIR` の上書きを代表していた fixture は**撤回した** —— その面は実行時の
 *    不変条件（`temp-isolation.ts` の `afterAll`）が綴りに依らず見るようになったため。
 *
 * 🔴 以前は「import の綴り」を代表する fixture が 3 つ在ったが、隔離が綴りに
 *    依らなくなったので**撤回した** —— 守るものが無い下界は置かない。
 */
const FIXTURES = [
  join('tests', 'fixtures', 'hard-coded-tmp-writer.ts'),
  // 2 つ目は**抜け道側**の面: 理由を書かないマーカーは通らない（実測 T15 で生存した）。
  join('tests', 'fixtures', 'reasonless-opt-out.ts'),
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const scannedFiles = (): string[] =>
  SCANNED_ROOTS.flatMap((root) => listSourceFiles(join(ROOT, root)))
    .map((f) => f.slice(ROOT.length + 1))
    .filter((rel) => !rel.startsWith(EXCLUDED));

/**
 * 隔離を迂回する形のうち、**静的にしか見られないもの**だけを見る。
 *
 * `['"`]/tmp[/'"`$]` … `/tmp` そのもの、`/tmp/...`、`` `/tmp${x}` ``。
 * macOS の実体 `/var/folders/...` も併せて見る。
 *
 * 🔴 **`process.env.TMPDIR` の上書きは、ここでは見ない（レビュー 3 周目 MAJOR 2 で撤回）。**
 * 代入の綴りを正規表現で追うのは**まだ数え上げ**で、`delete process.env.TMPDIR` /
 * `process.env['TMPDIR'] =` / `vi.stubEnv('TMPDIR', …)` / `Object.assign(process.env, …)` /
 * `process.env = {…}` / `const { env } = process; env.TMPDIR =` の **6 綴りが素通り**した
 * （実測）。この面は `tests/setup/temp-isolation.ts` の `afterAll` が
 * **実行時に** `os.tmpdir() !== fileRoot` で見る —— 綴りに依らず、逃げたそのファイルで落ちる。
 *
 * 🔴 **絶対パスの直書きは、今も綴りを見るしかない**（実行時には観測点が無い）。
 * `/var/tmp/...` や `/private/var/folders/...` は**素通りする**。族を数え上げないという
 * 原則と衝突する面なので、ここは「代表的な形だけ止める」と割り切り、
 * 最後の砦はゲートの「一時領域」節（エントリ件数と族の内訳）に置いている。
 */
const ESCAPES_ISOLATION = /['"`]\/tmp[/'"`$]|['"`]\/var\/folders/;

/** 正当な逸脱の印（同じ行か直前の行）。**理由を書かないと通らない。** */
const OPT_OUT = /\/\/\s*temp-ok:\s*\S/;

/**
 * 一時領域に触っている**行**を返す（`<path>:<行番号>` の形）。
 *
 * 🔴 **ファイル単位の免除をやめた（レビュー 1 周目 BLOCKER 1）。**
 * 当初は「`tmpdir()` を使うファイルは helper を import していれば通す」としていた。
 * ところが移行後の 28 ファイルは**全部 helper を import している**ので、
 * `join(tmpdir(), …)` による作成が**恒久的に免除**されていた ——
 * まさに #1136 の**支配的な原因そのもの**（18,726 件中 10,317 件）の形である。
 * 実測: `aws-preflight.test.ts` を #1136 以前の原文へ戻すと、
 * **ガードは緑のまま 1 回の実行で 9 件が残った**。
 */
function isolationEscapingLines(): string[] {
  const out: string[] = [];
  for (const rel of scannedFiles()) {
    if (rel === HELPER || rel === ISOLATION_SETUP) continue;
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    let inBlockComment = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        return;
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      const offends = ESCAPES_ISOLATION.test(line);
      if (!offends) return;
      // 🔴 マーカーは**同じ行**でも**直前の行**でもよい（このリポジトリは理由を上に書く）。
      if (OPT_OUT.test(line) || OPT_OUT.test(lines[index - 1] ?? '')) return;
      out.push(`${rel}:${index + 1}`);
    });
  }
  return out.sort();
}

describe('一時領域の後始末 (#1136)', () => {
  it('走査がテストツリーを歩けている（下界）', () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(200);
    // 下界: 実際に一時領域を作っているファイルが走査に入っていること。
    expect(files).toContain(join('tests', 'hooks', 'aws-preflight.test.ts'));
    expect(files).toContain(HELPER);
  });

  /**
   * 🔴 **検出器そのものの下界（実測 T06 / T07）。** 当初は「違反が空であること」しか
   * 主張しておらず、検出器を `return false` に潰す変異も「常に helper 扱い」にする変異も
   * **生存した**。わざと直書きする fixture を 1 つ置き、**それが報告されること**を縛る。
   */
  it.each(FIXTURES)('🔴 隔離を迂回する fixture (%s) は必ず報告される（走査の下界）', (fixture) => {
    expect(isolationEscapingLines().map((entry) => entry.split(':')[0])).toContain(fixture);
  });

  it('🔴 隔離を迂回する行は無い（絶対パスの直書き）', () => {
    expect(
      isolationEscapingLines().filter((entry) => !FIXTURES.includes(entry.split(':')[0] ?? '')),
      '一時領域は os.tmpdir() 経由で作ること（tests/setup/temp-isolation.ts がファイルごとに ' +
        'TMPDIR を切って回収する）。絶対パスの直書きは隔離を外す。' +
        '作らずに参照するだけなら、その行へ `// temp-ok: <理由>` を書くこと（#1136）',
    ).toEqual([]);
  });

  /**
   * 🔴 **隔離が「今このファイルで」効いていることの下界。**
   *
   * 走査を撤回した結果、リークを防いでいるのは実行時の隔離だけになった。
   * `setupFiles` を外す / セレクタを絞る等で**隔離が黙って切れる**形を倒すため、
   * このファイル自身が隔離の中に居ることを確かめる。
   */
  it('🔴 このテストファイルは専用の TMPDIR の中に居る（隔離が効いている）', () => {
    const current = tmpdir();
    expect(current).toContain(join('or-vitest', ''));
    // 下界: そこが実在し、書けること（パスの文字列だけを見ていると空虚に通る）。
    expect(existsSync(current)).toBe(true);
    expect(makeTempDir('isolation-lower-bound-').startsWith(current)).toBe(true);
  });

  /**
   * 🔴 **実行時の不変条件そのものの下界（足した機構は必ず縛る）。**
   *
   * 走査の面 2（`TMPDIR` の上書き）を撤回した代わりに、`temp-isolation.ts` の
   * `afterAll` が `os.tmpdir() !== fileRoot` を見る。**その検査が効いていること**を
   * 子 vitest で測る —— 書き換えたまま戻さないファイルは**落ちなければならない**。
   * これが無いと「検査を外す退行」が静かに通り、面 2 が丸ごと無防備になる。
   */
  it(
    '🔴 TMPDIR を書き換えたまま戻さないファイルは落ちる（実行時の不変条件）',
    () => {
      let failed = false;
      let stderr = '';
      try {
        execFileSync(
          join(ROOT, 'node_modules', '.bin', 'vitest'),
          ['run', join('tests', 'config', 'isolation-escape-probe.spec.ts')],
          {
            cwd: ROOT,
            encoding: 'utf8',
            env: { ...process.env, ISOLATION_ESCAPE_PROBE: '1' },
            timeout: 120_000,
          },
        );
      } catch (e) {
        failed = true;
        stderr = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`;
      }
      expect(failed, 'TMPDIR を外したまま終わったのに落ちていない').toBe(true);
      expect(stderr).toContain('一時領域の隔離が外れています');
    },
    60_000,
  );

  /**
   * 🔴 **負の対照（同じ probe を env なしで走らせる）。**
   * 上の主張が「子 vitest はいつも落ちる」で空虚に通らないことを見る。
   */
  it(
    '🔴 同じ probe は、書き換えなければ通る（負の対照）',
    () => {
      const out = execFileSync(
        join(ROOT, 'node_modules', '.bin', 'vitest'),
        ['run', join('tests', 'config', 'isolation-escape-probe.spec.ts')],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env }, timeout: 120_000 },
      );
      expect(out).toContain('1 passed');
    },
    60_000,
  );

  /**
   * 🔴 **掃き出しの「呼び出し」の下界。**
   *
   * 下の 2 本は関数を直接呼ぶので、**setup から呼ぶのをやめる退行**は素通りする。
   * 子 vitest を起こす前に古い root を置き、**起動しただけで消えている**ことを見る。
   */
  it(
    '🔴 setup は起動時に掃き出しを呼ぶ（古い root が消える）',
    () => {
      // 子は親の TMPDIR を継ぐので、子の RUN_ROOT は <このファイルの root>/or-vitest。
      const childRunRoot = join(tmpdir(), basename(dirname(tmpdir())));
      mkdirSync(childRunRoot, { recursive: true });
      const stale = join(childRunRoot, 'stale-by-parent');
      mkdirSync(stale, { recursive: true });
      const old = (Date.now() - 7 * 60 * 60 * 1000) / 1000;
      utimesSync(stale, old, old);

      execFileSync(
        join(ROOT, 'node_modules', '.bin', 'vitest'),
        ['run', join('tests', 'config', 'isolation-escape-probe.spec.ts')],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env }, timeout: 120_000 },
      );

      expect(existsSync(stale), '古い root が残っている。setup が掃き出しを呼んでいない').toBe(
        false,
      );
    },
    60_000,
  );

  /**
   * 🔴 **掃き出しを両側から縛る（レビュー 3 周目 MAJOR 1）。**
   *
   * `SWEEP_AGE_MS` は**どのテストからも縛られていなかった** —— 0 にする変異が
   * 機構のテストを全部素通りした（実測）。しかも退行の症状は**ハング**である:
   * 走行中の他ワーカーの root を消すので、`tests/hooks` が 54s → 900s の timeout で
   * SIGTERM になる（レビューの実測）。**偽の赤として最も読み違えやすい形**なので、
   * 「古いものは消す」と「新しいものは消さない」の両方を固定する。
   *
   * 形は先行実装（`infra/test/setup/cdk-outdir.ts` ＋ `infra/test/cdk-outdir.test.ts`）に揃えた。
   */
  it('🔴 掃き出しは古い root だけを消す（走行中の root を消さない）', () => {
    const runRoot = makeTempDir('sweep-probe-');
    const stale = join(runRoot, 'stale');
    const live = join(runRoot, 'live');
    mkdirSync(stale);
    mkdirSync(live);
    const now = Date.now();
    // 7 時間前に作られたことにする（しきい値は 6 時間）。
    const staleTime = (now - 7 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, staleTime, staleTime);

    const swept = sweepStaleRoots(runRoot, now);

    expect(swept).toEqual([stale]);
    expect(existsSync(stale), '古い root が残っている').toBe(false);
    // 🔴 下界（負の対照）: **新しい root を消していない**。
    //    これが無いと「全部消す」退行（しきい値 0）が素通りする。
    expect(existsSync(live), '走行中の root を消した').toBe(true);
  });

  it('🔴 しきい値は 6 時間（走行中の並列トラックを壊さない幅）', () => {
    expect(SWEEP_AGE_MS).toBe(6 * 60 * 60 * 1000);
  });

  /**
   * 🔴 **隔離が足すパス長を小さく保つ（実測 2026-09-21）。**
   *
   * 一時パスが深くなると、`tsx` のような **UNIX ドメインソケットを掘る道具**の余白
   * （`sun_path` は 108 バイト）を食う。TMPDIR が 96 文字の環境でフル unit を回した実測:
   * **main でも 29 テストが `EADDRINUSE`** ／ 隔離の名前が 30 文字だと **74 テスト** ／
   * 17 文字なら **8,889 passed で全緑**。症状はアサーション到達前の失敗なので
   * **偽の赤として読み間違えやすい** —— 名前を伸ばす退行をここで止める。
   */
  it('🔴 隔離が足すパスは短い（tsx の UNIX ソケットの余白を食わない）', () => {
    const added = tmpdir().length - dirname(dirname(tmpdir())).length;
    expect(added, `隔離が足すパスが長すぎる: ${tmpdir()}`).toBeLessThanOrEqual(20);
    // 🔴 下界（レビュー 3 周目 MINOR 1）: 以前は `added > 0` と書き、コメントで
    //    「隔離が切れていると 0 になる」と主張していたが**偽だった** ——
    //    隔離が無い `/tmp` でも 3、macOS の `/var/folders/9k/xxxx/T` なら 19 で、
    //    どちらも 0 < added <= 20 を満たす。**隔離の中に居ることを直接見る。**
    expect(tmpdir()).toContain('or-vitest');
  });

  /**
   * 🔴 **「綴りに依らない」ことの実測（隔離の本体）。**
   *
   * probe は**後始末を一切書かず**、走査では捕まらない綴り（名前空間 import・別名・
   * 動的 import）で 2 つ作る。親から見て**両方消えていれば**、回収は綴りに
   * 依存していない。旧方式ではこの 3 綴りはいずれも素通りしていた（実測）。
   */
  it(
    '🔴 後始末を書かない probe の残骸も、綴りに関係なく消えている（子プロセスで測る）',
    () => {
      const work = makeTempDir('isolation-probe-parent-');
      const out = join(work, 'paths.txt');
      execFileSync(
        join(ROOT, 'node_modules', '.bin', 'vitest'),
        ['run', join('tests', 'config', 'isolation-probe.spec.ts')],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, ISOLATION_PROBE_OUT: out },
          timeout: 120_000,
        },
      );
      const leaked = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean);
      // 下界 1: probe が実際に 2 つ作って書き出したこと。
      expect(leaked).toHaveLength(2);
      expect(leaked[0]).toMatch(/isolation-probe-ns-/);
      expect(leaked[1]).toMatch(/isolation-probe-dyn-/);
      // 下界 2: それらが**隔離の中**に作られていたこと（外に作られていたら、
      //         「消えている」は親の /tmp を汚した末に偶然消えた可能性を排除できない）。
      for (const path of leaked) expect(path).toContain('or-vitest');
      // 本体: 後始末を書いていないのに消えている。
      for (const path of leaked) {
        expect(existsSync(path), `${path} が残っている。ファイル単位の隔離が回収していない`).toBe(
          false,
        );
      }
    },
    60_000,
  );

  /**
   * 🔴 **負の対照は「ソースの見た目」ではなく「実際に消えたか」で取る（AC2）。**
   *
   * 上の 2 本はソースを読んでいるだけなので、`afterEach` が**登録されているのに
   * 走らない**形（別の `afterEach` が throw する等）は素通りする。
   * 1 本目で作ったパスを覚え、2 本目で**実際に消えていること**を見る ——
   * テストの実行順に依存するので、`it` の並び順を変えないこと。
   */
  let createdInPreviousTest = '';

  it('helper で一時領域を作る（次のテストで消えていることを見る）', () => {
    createdInPreviousTest = makeTempDir('temp-cleanup-guard-');
    expect(existsSync(createdInPreviousTest)).toBe(true);
  });

  it('🔴 前のテストで作った一時領域は afterEach で実際に消えている（負の対照）', () => {
    // 下界: 前のテストが本当に走って値を入れたこと（空なら主張が空虚に通る）。
    expect(createdInPreviousTest).not.toBe('');
    expect(
      existsSync(createdInPreviousTest),
      `${createdInPreviousTest} が残っている。helper の afterEach が走っていない`,
    ).toBe(false);
  });

  /**
   * 🔴 **共有ぶんの子 vitest probe は撤回した（2026-09-17）。**
   *
   * `makeSharedTempDir` の登録（`perFile` ＋ `afterAll`）自体を撤回したので、
   * それを測る probe（`tests/config/shared-temp-probe.spec.ts`）も要らなくなった ——
   * ファイル終了時の回収は**隔離**の仕事で、それは上の isolation probe が測っている。
   * 機構を 1 つ減らし、下界も 1 つ減った（増やしていない）。
   */

  it('🔴 helper の回収は afterEach に載っている（成功パスに書かない）', () => {
    // 🔴 **コメントを落としてから見る（実測 T02）。** `toContain` だけだと、
    //    行を `//` でコメントアウトしても部分文字列は残るので**素通りした**。
    const src = readFileSync(join(ROOT, HELPER), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(src).toContain('afterEach(() => drain(perTest));');
    expect(src).toContain('rmSync');
    // 🔴 **1 件の throw で残りを落とさない（実測 T24。レビュー 1 周目 MINOR 7）。**
    //    `splice(0)` で先に全部取り出すので、途中で throw すると**残りが registry から
    //    消えたまま回収されない**。今日 `rmSync` が throw する経路は無いため
    //    実行時の対照は作れない（`force: true` で ENOENT は無害）—— ソースで縛る面である。
    expect(src).toMatch(/for \(const path of paths\.splice\(0\)\)[\s\S]*?try\s*{[\s\S]*?rmSync/);
    // 下界: 成功パスに書いていないこと（`finally` へ戻す退行を赤にする）。
    expect(src).not.toMatch(/}\s*finally\s*{[\s\S]*rmSync/);
  });
});
