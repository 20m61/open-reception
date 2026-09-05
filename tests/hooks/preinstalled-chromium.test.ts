/**
 * プリインストール済み Chromium の解決を、実際に bash を起動して検証する。
 *
 * ## 何を直したのか（2026-09-05 に実際に踏んだ）
 *
 * `playwright.config.ts` は「`PW_EXECUTABLE_PATH` 未設定でも `/opt/pw-browsers/chromium` が
 * 在ればそれを使う」自動検出を持つ。**`scripts/vrm-visual-check.mjs` は同じ env を読むのに、
 * この自動検出を持っていなかった。** 結果、`--full` の VRM ステップだけが
 *
 * ```
 * browserType.launch: Executable doesn't exist at
 * /opt/pw-browsers/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell
 * ```
 *
 * で落ちた（e2e は逃げ道を通るので 483 件 PASS していた）。`PW_EXECUTABLE_PATH` を手で
 * 与えると **30/30 PASS** する ―― つまり実描画は健全で、欠けていたのは解決だけだった。
 *
 * 🔴 **これは「同じ規則の写しが複数あり、片方だけ直る」型**（`CLAUDE.md` / runbook ステップ 3
 * と同型）。だから写しを増やさず `scripts/lib/gate-tooling.sh` の 1 箇所へ寄せ、
 * bash の消費者（probe / lighthouse の CHROME_PATH / VRM）はそこを通す。
 *
 * `playwright.config.ts` だけは bash を source できないので TS 側に定数が残る。
 * **その 1 本だけがドリフトしうる**ので、下の「ドリフト検出」で縛る。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stripBashComments } from '../../src/domain/governance/bash-source';

const ROOT = resolve(process.cwd());
const LIB = join(ROOT, 'scripts/lib/gate-tooling.sh');
const TIMEOUT = 60_000;

/** 実行可能な偽 chromium を置いてそのパスを返す。 */
function fakeChromium(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preinstalled-chromium-'));
  const exe = join(dir, 'chromium');
  writeFileSync(exe, '#!/bin/sh\nexit 0\n');
  chmodSync(exe, 0o755);
  return exe;
}

/** lib を source して 1 行の bash を走らせる。 */
function runBash(script: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', `. "${LIB}"; ${script}`], {
    encoding: 'utf8',
    timeout: TIMEOUT,
    env: { ...process.env, ...env },
  });
}

describe('gate_tool_preinstalled_chromium', () => {
  it('実行可能なら、そのパスを stdout に出して成功する', () => {
    const exe = fakeChromium();
    const r = runBash('gate_tool_preinstalled_chromium', {
      GATE_PREINSTALLED_CHROMIUM: exe,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(exe);
  }, TIMEOUT);

  it('実行可能でなければ非ゼロで、パスを出さない', () => {
    const r = runBash('gate_tool_preinstalled_chromium', {
      GATE_PREINSTALLED_CHROMIUM: '/nonexistent/chromium',
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  }, TIMEOUT);

  it('既定は /opt/pw-browsers/chromium を指す', () => {
    // 値そのものを固定する。パスを変える変異はここで落ちる。
    expect(readFileSync(LIB, 'utf8')).toContain('/opt/pw-browsers/chromium');
  }, TIMEOUT);
});

describe('gate_tool_export_chromium_executable', () => {
  /**
   * VRM が使う接ぎ目。`vrm-visual-check.mjs` は `PW_EXECUTABLE_PATH` しか読まないので、
   * 呼ぶ側が解決して渡す。
   */
  it('未設定なら PW_EXECUTABLE_PATH をプリインストール版に設定する', () => {
    const exe = fakeChromium();
    const r = runBash(
      'gate_tool_export_chromium_executable; printf "%s" "${PW_EXECUTABLE_PATH:-unset}"',
      { GATE_PREINSTALLED_CHROMIUM: exe, PW_EXECUTABLE_PATH: '' },
    );
    expect(r.stdout.trim()).toBe(exe);
  }, TIMEOUT);

  /**
   * **下界も縛る。** 「設定する」だけを主張すると、常に上書きする実装が通ってしまう。
   * 呼び出し側の明示指定を奪わないことまで要求する。
   */
  it('既に設定されていれば上書きしない', () => {
    const exe = fakeChromium();
    const r = runBash(
      'gate_tool_export_chromium_executable; printf "%s" "${PW_EXECUTABLE_PATH:-unset}"',
      { GATE_PREINSTALLED_CHROMIUM: exe, PW_EXECUTABLE_PATH: '/my/own/chrome' },
    );
    expect(r.stdout.trim()).toBe('/my/own/chrome');
  }, TIMEOUT);

  /**
   * 🔴 **`${VAR:-...}` ではなく `${VAR-...}` で見る（コロン無し）。**
   *
   * コロン付きは「未設定」と「空文字に設定」を同じに畳むので、`|| return 0` を外して
   * 空文字を export する変異が**素通りした**（変異検証 N6 が生存して判明）。
   * 契約は「触らない」であって「空にする」ではない。子プロセスで明示的に unset して、
   * 実装が本当に手を出していないことを問う。
   */
  it('プリインストール版が無ければ未設定のままにする（存在しないパスを掴ませない）', () => {
    const r = runBash(
      'unset PW_EXECUTABLE_PATH; gate_tool_export_chromium_executable; printf "%s" "${PW_EXECUTABLE_PATH-unset}"',
      { GATE_PREINSTALLED_CHROMIUM: '/nonexistent/chromium' },
    );
    expect(r.stdout.trim()).toBe('unset');
  }, TIMEOUT);
});

describe('消費者がこの 1 箇所を通っているか', () => {
  /**
   * 🔴 **VRM がこれを使うことが、今回の修正の本体。** ここが外れると
   * `--full` の VRM だけが実行時に落ちる状態へ戻る。
   */
  it('vrm-check.sh が node を起動する前に解決を通す', () => {
    // 🔴 **コメントを落としてから見る。** このファイルは注記が本文より長く、コメントが
    // `vrm-visual-check.mjs` を先に言及するので、素の indexOf は**本物の呼び出しを
    // 消しても緑のまま**になる（実際、最初の実装でこれに当たった）。
    const src = stripBashComments(readFileSync(join(ROOT, 'scripts/vrm-check.sh'), 'utf8'));
    expect(src).toContain('gate-tooling.sh');
    expect(src).toContain('gate_tool_export_chromium_executable');
    // 解決が node 起動より前にあること（後ろだと効かない）。
    expect(src.indexOf('gate_tool_export_chromium_executable')).toBeLessThan(
      src.indexOf('vrm-visual-check.mjs'),
    );
  }, TIMEOUT);

  it('quality-gate.sh の lighthouse も同じ解決を使う（パスを直書きしない）', () => {
    const src = readFileSync(join(ROOT, 'scripts/quality-gate.sh'), 'utf8');
    expect(src).toContain('gate_tool_preinstalled_chromium');
    // 直書きのコピーが残っていたら、片方だけ直る型が復活する。
    expect(src).not.toMatch(/CHROME_PATH=\/opt\/pw-browsers\/chromium/);
  }, TIMEOUT);

  /**
   * ドリフト検出: bash を source できない `playwright.config.ts` だけが別の写しを持つ。
   * 値が食い違ったら、e2e と VRM が別のバイナリを見ることになる。
   */
  it('playwright.config.ts の定数が bash 側の既定と一致する', () => {
    const config = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8');
    const m = /const PREINSTALLED_CHROMIUM = '([^']+)'/.exec(config);
    expect(m, 'playwright.config.ts に PREINSTALLED_CHROMIUM が見つからない').not.toBeNull();
    const lib = readFileSync(LIB, 'utf8');
    const libMatch = /GATE_PREINSTALLED_CHROMIUM:-([^}"]+)/.exec(lib);
    expect(libMatch, 'gate-tooling.sh に既定パスが見つからない').not.toBeNull();
    expect(m?.[1]).toBe(libMatch?.[1]);
  }, TIMEOUT);
});
