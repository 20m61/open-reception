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
 * 2. テストが自分の `process.env.TMPDIR` を**上書きする** ―― 隔離を自分で外す
 *
 * この 2 つ以外は走査しない。**綴りの列挙は消えた**（helper 経由で作るのは
 * 「テストごとに小さく保つ」ための作法であって、リークの防壁ではなくなった）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../helpers/temp';

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
 * 隔離を裏返したあとに残った面は 2 つ、加えて**抜け道側**が 1 つ:
 * 1. 絶対パスの直書き（`TMPDIR` を通らない）
 * 2. `process.env.TMPDIR` の上書き（隔離を自分で外す）
 * 3. 逸脱マーカーに**理由を書かない**（唯一の抜け道なので理由を必須にしている）
 *
 * 🔴 以前は「import の綴り」を代表する fixture が 3 つ在ったが、隔離が綴りに
 *    依らなくなったので**撤回した** —— 守るものが無い下界は置かない。
 */
const FIXTURES = [
  join('tests', 'fixtures', 'hard-coded-tmp-writer.ts'),
  join('tests', 'fixtures', 'isolation-escaper.ts'),
  // 3 つ目は**抜け道側**の面: 理由を書かないマーカーは通らない（実測 T15 で生存した）。
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
 * 隔離を迂回する 2 つの形。**これしか見ない。**
 *
 * - `['"`]/tmp[/'"`]` … `/tmp` そのもの、および `/tmp/...`。
 *   🔴 以前は `'/tmp'` の**完全一致**しか見ておらず、`'/tmp/leak.json'` が素通りしていた
 *   （レビュー 2 周目 BLOCKER 1 の一部）。macOS の実体 `/var/folders/...` も併せて見る。
 * - `process\.env\.TMPDIR\s*=(?!=)` … **自分の env を上書きする**形だけ。
 *   子プロセスへ `env: { ...process.env, TMPDIR: x }` と**渡す**のは隔離を壊さないので
 *   当たらない（実際に 2 箇所で使っている）。`==` / `===` の比較も除く。
 */
const ESCAPES_ISOLATION =
  /['"`]\/tmp[/'"`]|['"`]\/var\/folders|process\.env\.TMPDIR\s*=(?!=)/;

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

  it('🔴 隔離を迂回する行は無い（絶対パスの直書き / TMPDIR の上書き）', () => {
    expect(
      isolationEscapingLines().filter((entry) => !FIXTURES.includes(entry.split(':')[0] ?? '')),
      '一時領域は os.tmpdir() 経由で作ること（tests/setup/temp-isolation.ts がファイルごとに ' +
        'TMPDIR を切って回収する）。絶対パスの直書きや TMPDIR の上書きは隔離を外す。' +
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
    expect(current).toContain(join('open-reception-vitest', 'f-'));
    // 下界: そこが実在し、書けること（パスの文字列だけを見ていると空虚に通る）。
    expect(existsSync(current)).toBe(true);
    expect(makeTempDir('isolation-lower-bound-').startsWith(current)).toBe(true);
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
      for (const path of leaked) expect(path).toContain('open-reception-vitest');
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
