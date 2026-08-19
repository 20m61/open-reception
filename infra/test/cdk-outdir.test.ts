/**
 * CDK の synth 出力が一時 root に閉じ、後始末されることを固定する (#721)。
 *
 * `infra/test/setup/cdk-outdir.ts`（globalSetup）が `TMPDIR` を向け替えている。
 * **これが外れると `/tmp/cdk.out*` が積み上がり、クラウドのディスクを食い潰して
 * e2e が落ちる**（2026-08-19 に 740 個・26GB で実際に起きた）。
 * 症状（`page.screenshot: Target crashed`）が原因を指さないので、機械で縛る。
 */
import * as cdk from 'aws-cdk-lib';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CDK_TMP_PREFIX, setup, sweepStaleRoots } from './setup/cdk-outdir';

describe('CDK synth 出力の隔離 (#721)', () => {
  it('TMPDIR が周回ごとの一時 root へ向いている', () => {
    expect(tmpdir()).toContain(CDK_TMP_PREFIX);
  });

  it('outdir を指定しない App の出力先がその root 配下に入る', () => {
    // 🔴 `startsWith(tmpdir())` だけでは**設定が外れていても自明に真**になる
    // （`/tmp/cdk.outXXX`.startsWith('/tmp')）。root の印まで見る。
    expect(new cdk.App().outdir).toContain(CDK_TMP_PREFIX);
  });
});

describe('setup / teardown の後始末 (#721)', () => {
  /** システム側の tmpdir を汚さないよう、隔離した親ディレクトリで検査する。 */
  let sandbox: string | undefined;
  const originalTmp = process.env.TMPDIR;

  afterEach(() => {
    if (sandbox !== undefined) rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
    process.env.TMPDIR = originalTmp;
  });

  it('🔴 teardown が root を実際に消す', () => {
    // **ここが AC1 の本体。** `rmSync` を no-op にしても他のテストは全部 green だった
    // （レビュー M3）ので、消えることそのものを縛る。
    sandbox = mkdtempSync(join(originalTmp ?? '/tmp', 'cdk-outdir-spec-'));
    process.env.TMPDIR = sandbox;
    const teardown = setup();
    const root = process.env.TMPDIR;
    expect(root).toContain(CDK_TMP_PREFIX);
    writeFileSync(join(root!, 'cdk.outDUMMY-marker'), 'x');
    expect(existsSync(root!)).toBe(true);
    teardown();
    expect(existsSync(root!)).toBe(false);
  });

  it('🔴 setup() が掃除を呼んでいる（配線が落ちても気づける）', () => {
    // `sweepStaleRoots` を直接呼ぶテストだけだと、**`setup()` からの呼び出しを外しても
    // 全部 green のまま**だった（変異で実証）。落ちたときの症状は「静かに積み上がる」
    // なので、配線そのものを縛る。
    sandbox = mkdtempSync(join(originalTmp ?? '/tmp', 'cdk-outdir-spec-'));
    const stale = join(sandbox, `${CDK_TMP_PREFIX}stale`);
    mkdirSync(stale);
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    process.env.TMPDIR = sandbox;
    const teardown = setup();
    try {
      expect(existsSync(stale)).toBe(false);
    } finally {
      teardown();
    }
  });

  it('🔴 SIGKILL で置き去りになった古い root を次の周回が掃く', () => {
    // teardown は SIGKILL では走らない。そして SIGKILL が起きるのは**ディスク枯渇時**
    // ＝まさに #721 の事故状況なので、次の周回が掃かないと積み上がる。
    sandbox = mkdtempSync(join(originalTmp ?? '/tmp', 'cdk-outdir-spec-'));
    const stale = join(sandbox, `${CDK_TMP_PREFIX}stale`);
    mkdirSync(stale);
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    const swept = sweepStaleRoots(sandbox, Date.now());
    expect(swept).toContain(stale);
    expect(existsSync(stale)).toBe(false);
  });

  it('走行中（新しい）root は掃かない（並列トラックを壊さない）', () => {
    // 件数や名前で消すと、同時に走っている worktree の synth を壊す。age で判断する。
    sandbox = mkdtempSync(join(originalTmp ?? '/tmp', 'cdk-outdir-spec-'));
    const fresh = join(sandbox, `${CDK_TMP_PREFIX}fresh`);
    mkdirSync(fresh);

    expect(sweepStaleRoots(sandbox, Date.now())).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  it('無関係な名前のディレクトリは掃かない', () => {
    sandbox = mkdtempSync(join(originalTmp ?? '/tmp', 'cdk-outdir-spec-'));
    const other = join(sandbox, 'someone-elses-temp');
    mkdirSync(other);
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(other, old, old);

    expect(sweepStaleRoots(sandbox, Date.now())).toEqual([]);
    expect(existsSync(other)).toBe(true);
  });
});
