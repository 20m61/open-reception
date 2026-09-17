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
    // 名前空間 import 経由（`osNamespace.tmpdir()`）＋ `mkdtempSync` の別名。
    const viaNamespace = makeDir(join(osNamespace.tmpdir(), 'isolation-probe-ns-'));
    // 動的 import 経由（同じく旧方式では見えない綴り）。
    const os = await import('node:os');
    const viaDynamic = makeDir(join(os.tmpdir(), 'isolation-probe-dyn-'));
    const out = process.env.ISOLATION_PROBE_OUT;
    if (out) writeFileSync(out, `${viaNamespace}\n${viaDynamic}\n`);
    expect(viaNamespace).not.toBe(viaDynamic);
  });
});
