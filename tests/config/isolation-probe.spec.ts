/**
 * 🔴 **隔離が「綴りに依らない」ことを測るための probe (#1136)。**
 *
 * `tests/config/temp-cleanup-guard.test.ts` が子 vitest としてこれを起動し、
 * ここが作った一時ディレクトリが**親から見て消えていること**を確かめる。
 * 同じファイルの中からは `afterAll` の後を観測できないので、子プロセスで測る。
 *
 * 🔴 **わざと「走査では捕まらない綴り」で作る。** 名前空間 import・別名・動的 import は
 * いずれもレビュー 2 周目の実測で**旧方式の検出器を素通りした**形である。
 * 後始末も**書かない** —— 回収するのは隔離（`TMPDIR` の切り替え）の仕事だから。
 *
 * `ISOLATION_PROBE_OUT` が無ければ何も書かないので、通常の unit レーンでは無害。
 */
import * as osNamespace from 'node:os';
import { mkdtempSync as makeDir, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('隔離の probe（親が結果を読む）', () => {
  it('走査では捕まらない綴りで一時領域を作り、後始末をしない', async () => {
    // 🔴 **親から呼ばれていないときは何も作らない（レビュー 3 周目 MINOR 4）。**
    //    以前は作成を無条件にしており、通常の unit レーンでも 2 件作っていた ——
    //    隔離が外れた瞬間だけ**唯一「二段目の後始末を持たないテスト」**になる。
    //    実際、隔離を壊して測った回の残骸が `/tmp` 直下に 16 件残っていた（sweep の
    //    対象外なので永久に残る）。測定は子プロセス経路でしか意味が無いので、
    //    条件を付けても下界は一切弱まらない。
    const out = process.env.ISOLATION_PROBE_OUT;
    if (out === undefined) {
      expect(out).toBeUndefined();
      return;
    }
    // 名前空間 import 経由（`osNamespace.tmpdir()`）＋ `mkdtempSync` の別名。
    const viaNamespace = makeDir(join(osNamespace.tmpdir(), 'isolation-probe-ns-'));
    // 動的 import 経由（同じく旧方式では見えない綴り）。
    const os = await import('node:os');
    const viaDynamic = makeDir(join(os.tmpdir(), 'isolation-probe-dyn-'));
    writeFileSync(out, `${viaNamespace}\n${viaDynamic}\n`);
    expect(viaNamespace).not.toBe(viaDynamic);
  });
});
