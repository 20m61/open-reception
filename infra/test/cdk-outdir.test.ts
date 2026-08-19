/**
 * CDK の synth 出力が一時 root に閉じていることを固定する (#721)。
 *
 * `infra/test/setup/cdk-outdir.ts`（globalSetup）が `TMPDIR` を向け替えている。
 * **これが外れると `/tmp/cdk.out*` が積み上がり、クラウドのディスクを食い潰して
 * e2e が落ちる**（2026-08-19 に 740 個・26GB で実際に起きた）。
 *
 * 症状（`page.screenshot: Target crashed`）が原因を指さないので、
 * 設定が生きていること自体を機械で縛る。
 */
import * as cdk from 'aws-cdk-lib';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CDK_TMP_PREFIX } from './setup/cdk-outdir';

describe('CDK synth 出力の隔離 (#721)', () => {
  it('TMPDIR が周回ごとの一時 root へ向いている', () => {
    expect(tmpdir()).toContain(CDK_TMP_PREFIX);
  });

  it('outdir を指定しない App の出力先がその root 配下に入る', () => {
    // ここが `/tmp` 直下に戻ると、CDK は消さないので残骸として積み上がる。
    const app = new cdk.App();
    expect(app.outdir.startsWith(tmpdir())).toBe(true);
  });
});
