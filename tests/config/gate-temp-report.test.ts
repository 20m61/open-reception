/**
 * 🔴 **ゲートの「一時領域 (#721/#1136)」節が、件数でも警告することを縛る。**
 *
 * 2026-09-17、`/tmp` に 18,726 エントリが積もって unit が
 * `Test timed out in 5000ms`（実測 8751ms / 単独では 663ms）で落ちたが、
 * **ディスクは 22G 空いていたのでこの節は「正常」と表示した**。
 * 空き容量だけを見ていたため、**症状が原因を指さない**まま「コードを疑う」方向へ誘導した。
 *
 * ## なぜテストが要るか
 *
 * 件数を出す変更を入れただけでは、**それを縛るものが何も無い**（実測: リポジトリ全体に
 * `report_workspace_state` を検査するテストは 1 つも無かった）。散文が成果物より強い状態を
 * 作らないため、`report_workspace_state` を**実際に動かして**出力を見る。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../helpers/temp';

const GATE = resolve(process.cwd(), 'scripts/quality-gate.sh');

/**
 * `report_workspace_state` だけを切り出して、指定した TMPDIR に対して走らせる。
 *
 * 🔴 **`set -uo pipefail` に揃える（レビュー 1 周目 MINOR 8）。** 抽出実走の売りは
 * 「本物と同じ条件で動かす」ことなので、本体（`scripts/quality-gate.sh`）と同じにする。
 */
function runReport(
  entries: number | readonly string[],
  // 🔴 **文字列も受ける。** 非数値のしきい値でゲートが死なないことを縛るため
  //    （レビュー 2 周目 MAJOR 3）。型で逃げると、その面が測れなくなる。
  threshold?: number | string,
  prefix = 'probe-',
): string {
  const src = readFileSync(GATE, 'utf8');
  const from = src.indexOf('report_workspace_state() {');
  expect(from, 'report_workspace_state が見つからない（走査が陳腐化した）').toBeGreaterThan(-1);
  const to = src.indexOf('\n}\n', from);
  expect(to, '関数の終端が見つからない').toBeGreaterThan(from);

  const sandbox = makeTempDir('gate-temp-report-');
  const tmpRoot = join(sandbox, 'tmproot');
  mkdirSync(tmpRoot, { recursive: true });
  // 🔴 **名前を直接渡せるようにした。** 族の集約は接尾辞の**綴り**に依るので、
  //    連番（数字を含む）だけでは `mkdtemp` の実際の名前（英数ランダム）を再現できない。
  const names =
    typeof entries === 'number' ? Array.from({ length: entries }, (_, i) => `${prefix}${i}`) : entries;
  for (const name of names) mkdirSync(join(tmpRoot, name), { recursive: true });

  const script = join(sandbox, 'run.sh');
  writeFileSync(script, `set -uo pipefail\n${src.slice(from, to + 2)}\nGATE_DISK_START=test\nreport_workspace_state\n`);
  return execFileSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: tmpRoot,
      ...(threshold === undefined ? {} : { TEMP_ENTRY_WARN_THRESHOLD: String(threshold) }),
    },
  });
}

describe('ゲートの一時領域レポート (#1136)', () => {
  it('🔴 エントリ件数を必ず出す（空き容量だけでは今日の症状が見えなかった）', () => {
    const out = runReport(3);
    expect(out).toContain('エントリ: 3 件');
    // 下界: 既存の #721 の表示を落としていない。
    expect(out).toContain('の空き:');
    expect(out).toContain('残骸: cdk.out');
  });

  /**
   * 🔴 **unit の隔離 root は 1 段下を数える (#1136)。**
   *
   * テストファイルごとの一時領域は `<tmp>/open-reception-vitest/f-*` に入るので、
   * **直下の総数からは 1 件にしか見えない** —— kill された run の残骸が、
   * いちばん見せたい状況で不可視になる。ここだけ潜って数えることを縛る。
   */
  it('🔴 隔離 root の中身を 1 段潜って数える（直下の 1 件で隠れない）', () => {
    const out = runReport(['open-reception-vitest/f-a', 'open-reception-vitest/f-b', 'other']);
    expect(out).toContain('unit 隔離 root 2 件');
    // 下界: 直下のほうは 2 件（`open-reception-vitest` と `other`）として数えていること。
    expect(out).toContain('エントリ: 2 件');
  });

  /**
   * 🔴 **内訳はしきい値に関係なく常に出す（レビュー 1 周目 MAJOR 3）。**
   * AC3 は「族をパターンで数える」だった。当初はしきい値超えのときだけ出していたので、
   * **issue が実測した 2,118 件の状況では何も出ず**、「多いのかどうか」が判断できなかった。
   */
  it('🔴 しきい値を超えていなくても内訳（上位 prefix）を出す', () => {
    const out = runReport(3, 5000, 'gate-stamp-');
    expect(out).toContain('内訳:');
    // 🔴 **prefix に集約されていること（実測 T12）。** 以前は `toContain('gate-stamp-')` だけで、
    //    集約をやめて素の一覧にする変異が**素通りした**（`gate-stamp-0` 等が含まれるため）。
    //    「件数 + prefix」の形を見る。
    expect(out).toMatch(/内訳:\s+3 gate-stamp-/);
  });

  /**
   * 🔴 **族はランダム接尾辞を越えて集約されなければ意味が無い（2026-09-17 実測）。**
   *
   * 当初の集約は「最初の数字で切る」だった。`mkdtemp` の接尾辞は**英数 6 文字の
   * ランダム**なので、数字が来る位置が毎回違って**族が砕ける** ―― 実測 7,753
   * エントリでバケット 5,900・1 件バケット 5,606・上位 3 の被覆 **6%**。
   * 最も多い族は 1,562 件あったのに `265` としか出ておらず、
   * **「どれが多いのか」というこの節の唯一の用途を果たしていなかった**。
   *
   * このケースは**数字を 1 つも含まない**名前で族を作る。旧方式では 4 つの
   * 1 件バケットに砕けるので、件数付きの集約を主張すれば倒れる。
   */
  it('🔴 ランダム接尾辞（数字なし）でも族が 1 つに集約される', () => {
    const out = runReport(
      ['kiosk-seed-AbCdEf', 'kiosk-seed-GhIjKl', 'kiosk-seed-MnOpQr', 'kiosk-seed-StUvWx'],
      5000,
    );
    expect(out).toMatch(/内訳:\s+4 kiosk-seed-/);
  });

  /**
   * 🔴 **置き換えた側が守っていた分布を当て直す（レビュー 2 周目 MAJOR 2）。**
   *
   * #1136 の**支配的な漏洩形**は `aws-preflight-test-<pid>-<rand>.json` である
   * （`git show c35b268:tests/hooks/aws-preflight.test.ts` が原文）。
   * 「最後の `-`/`.` 以降を落とす」方式では**拡張子だけが落ちて** pid と乱数が
   * ラベルに残り、**1,000 件の族が `1` と出た**（合成 2,000 件で実測）。
   * 初期方式（最初の数字で切る）はこの分布を正しく出していた ——
   * **方式を替えたときに、前の方式が守っていた分布を測らなかった**のが誤り。
   */
  it('🔴 <prefix>-<pid>-<rand>.json の族も 1 つに集約される（#1136 の当事者の形）', () => {
    const out = runReport(
      [
        'aws-preflight-test-13939-15cwdtrop3mi.json',
        'aws-preflight-test-14022-zwid3xqpf3ab.json',
        'aws-preflight-test-9120-qq71bvz0m4de.json',
      ],
      5000,
    );
    expect(out).toMatch(/内訳:\s+3 aws-preflight-test-/);
  });

  /**
   * 🔴 **下界: 区切りの無い名前を空ラベルへ潰さない。**
   * 「最後の区切り以降を落とす」を素朴に書くと（`s/[^-.]*$//`）、`vitest` のような
   * 区切りを持たない名前が**空文字列**になり、内訳が `1 ` だけの行になる。
   * 集約を強めるほどこちら側が壊れやすいので、両側から縛る。
   */
  it('🔴 区切りの無い名前はそのまま出す（空ラベルへ潰さない）', () => {
    const out = runReport(['vitest', 'chromium'], 5000);
    expect(out).toMatch(/内訳:.*1 vitest/);
    expect(out).toMatch(/内訳:.*1 chromium/);
  });

  /**
   * 🔴 **`find -printf` は GNU 専用（実測 T22。レビュー 1 周目 MINOR 2）。**
   * macOS の BSD find には無く、`2>/dev/null` で潰していたので
   * **darwin では内訳が空のまま出ていた**。ローカル macOS は `--fast` の既定レーンである。
   * linux では両方動くので**実走では差が出ない** —— ソースで縛るしかない面。
   */
  it('🔴 内訳は GNU 専用の find -printf を使わない（darwin で空にならない）', () => {
    // 🔴 コメント行と `awk '{printf …}'`（こちらは可搬）を除いてから見る。
    //
    // 🔴 **行継続（末尾 `\\`）で繋がったコマンドは 1 行として読む（実測 T22）。**
    //    当該の `find` は `\\` で折り返しており、`-printf` へ戻す変異は**次の行**に乗る。
    //    行単位のまま走査していたので、この走査は**変異を当てても空虚に通った**。
    const codeLines = readFileSync(GATE, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .reduce<string[]>((acc, line) => {
        const prev = acc.at(-1);
        if (prev !== undefined && prev.endsWith('\\')) {
          acc[acc.length - 1] = `${prev.slice(0, -1)} ${line.trim()}`;
          return acc;
        }
        acc.push(line);
        return acc;
      }, []);
    // 下界 1: 実際にソースを読めていること。
    expect(codeLines.some((line) => line.includes('report_workspace_state'))).toBe(true);
    // 🔴 下界 2: **畳み込みが「その行」に効いていること**（レビュー 2 周目 MINOR 4）。
    //    以前は「継続が 1 つも残らないこと」を見ていたが、それは畳み込みの恒真式で、
    //    かつ「どこかに継続が 1 つある」も無関係な行で満たせる ——
    //    **当該のパイプラインが 1 要素に繋がったこと**を主張しなければ空虚になる。
    expect(codeLines.filter((line) => /find[^|]*\|.*sed -E/.test(line))).not.toHaveLength(0);
    expect(codeLines.filter((line) => /find[^|]*-printf/.test(line))).toEqual([]);
  });

  /**
   * 🔴 **しきい値を実走で両側から縛る（同 MAJOR 2）。**
   * 以前は `expect(src).toContain('-gt 5000')` だけで、それは **`-gt 500000` を
   * 部分文字列として満たす** —— しきい値を 100 倍に緩める変更が無検出で通った。
   */
  it('🔴 しきい値を超えたら警告する', () => {
    const out = runReport(6, 5);
    expect(out).toContain('エントリが 6 件あります（しきい値 5）');
    expect(out).toContain('容量が空いていても');
  });

  it('🔴 しきい値以下なら警告しない（負の対照）', () => {
    // 🔴 **この枝だけを否定する（同 MINOR 1）。** 以前は `not.toContain('⚠ ')` だったので、
    //    既存の「空きが 2GB を切っています」枝が発火すると落ちた ——
    //    **ディスクが詰まっている環境＝この節が最も要る状況で、unit が余計に赤くなる**形。
    expect(runReport(5, 5)).not.toContain('エントリが');
  });

  /**
   * 🔴 **非数値のしきい値でゲートを死なせない（レビュー 2 周目 MAJOR 3）。**
   *
   * `set -u` 下で `[[ 7 -gt abc ]]` は **unbound variable でスクリプトごと落ちる**。
   * `report_workspace_state` は `finish()` が最初に呼ぶので、**全ステップ PASS のまま
   * summary もスタンプも出ないまま exit 1** になり、以後 PR もマージも止まる（実測）。
   * しきい値を注入できるようにした**私の機構が作った**穴なので、両側を縛る。
   */
  it('🔴 しきい値が非数値でも死なず、既定へ戻す', () => {
    const out = runReport(3, 'abc');
    // 死んでいない（`execFileSync` は非ゼロ終了で throw するので、ここに来ること自体が下界）。
    expect(out).toContain('エントリ: 3 件');
    // 既定（5000）へ戻っているので、3 件では警告しない。
    expect(out).not.toContain('エントリが');
  });

  it('🔴 既定のしきい値は 5000（env が無いときの値）', () => {
    const src = readFileSync(GATE, 'utf8');
    expect(src).toContain('${TEMP_ENTRY_WARN_THRESHOLD:-5000}');
  });
});
