/**
 * WebStack を synth するテストは、OpenNext バンドルを cdk.out へ**コピーしない** (#1146)。
 *
 * ## なぜ要るか
 *
 * WebStack の synth は `.open-next/`（3,931 ファイル / 90MB）を App ごとの outdir へ
 * コピーする。infra テストは WebStack を数十回 synth するので、1 周で
 * sendfile 121,276 回・4.1GiB の書き込みになっていた（2026-10-09 実測）。
 * ディスク I/O が絞られた CodeBuild Validation（MEDIUM）ではこれで 30 分の
 * project timeout に達した（build efa5f85f）。
 *
 * `aws:cdk:disable-asset-staging` はコピーだけを止める。**asset hash は同じ指紋から
 * 計算される**ので、テンプレート（S3Key 等）は staging ありのときと変わらない。
 * 下の 1 本目がそれを縛る —— ここが崩れると、テストが本番と別のテンプレートを
 * 見ることになる。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Template } from 'aws-cdk-lib/assertions';
import { appWithoutAssetStaging } from './support/app-without-asset-staging';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/**
 * WebStack が持つ asset の種類を 1 つずつ持つスタック: ディレクトリ（Lambda コード /
 * BucketDeployment の source）、単一ファイル（awscli layer zip）、CustomResourceProvider の
 * handler（autoDeleteObjects / cross-region export）。実物の WebStack は 90MB をコピーするので
 * ここでは使わない（実物での一致は #1146 の PR に 37 テンプレートの一致として記録した）。
 */
const synthWithAsset = (app: cdk.App, source: string) => {
  const stack = new cdk.Stack(app, 'AssetStack');
  new lambda.Function(stack, 'Fn', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromAsset(source),
  });
  new s3assets.Asset(stack, 'File', { path: join(source, 'index.js') });
  new s3.Bucket(stack, 'Bucket', { autoDeleteObjects: true, removalPolicy: cdk.RemovalPolicy.DESTROY });
  const template = Template.fromStack(stack).toJSON();
  return { template, outdirEntries: readdirSync(app.outdir) };
};

describe('appWithoutAssetStaging', () => {
  it('🔴 synthesizes the same template as a staging App, without copying the asset', () => {
    const source = tempDir('asset-src-');
    writeFileSync(join(source, 'index.js'), 'exports.handler = async () => ({});\n');

    const staged = synthWithAsset(new cdk.App({ outdir: tempDir('asset-staged-') }), source);
    const unstaged = synthWithAsset(appWithoutAssetStaging({ outdir: tempDir('asset-unstaged-') }), source);

    // The positive control: a plain App copies each of the three assets into its outdir.
    expect(staged.outdirEntries.filter((e) => e.startsWith('asset.'))).toHaveLength(3);
    expect(unstaged.outdirEntries.filter((e) => e.startsWith('asset.'))).toEqual([]);
    expect(unstaged.template).toEqual(staged.template);
  });

  it('keeps the caller\'s context and props', () => {
    const app = appWithoutAssetStaging({ context: { env: 'dev', claudeBoundary: 'B' } });
    expect(app.node.tryGetContext('env')).toBe('dev');
    expect(app.node.tryGetContext('claudeBoundary')).toBe('B');
  });
});

/**
 * WebStack を synth するテストファイルは、App を必ず helper から作る。
 *
 * 新しいテストが `new cdk.App()` で WebStack を synth すると、90MB のコピーが黙って戻る
 * （#1150 の dev-lambda-concurrency は追加された時点で最も遅いファイルになった）。
 */
describe('test files that synthesize WebStack', () => {
  const TEST_DIR = resolve(__dirname);
  // Recursive, and helpers too: a support file could build the App for a test.
  const files = (readdirSync(TEST_DIR, { recursive: true }) as string[]).filter(
    (f) => f.endsWith('.ts') && f !== 'asset-staging.test.ts' && !f.startsWith('fixtures'),
  );
  const webStackFiles = files.filter((f) => /\bnew\s+WebStack\s*\(/.test(readFileSync(join(TEST_DIR, f), 'utf8')));

  it('are found (the scan is not vacuous)', () => {
    expect(webStackFiles).toEqual(
      expect.arrayContaining([
        'claude-deploy-boundary.test.ts',
        'dev-lambda-concurrency.test.ts',
        'web-monitoring-stack.test.ts',
        'web-stack.test.ts',
      ]),
    );
  });

  it.each(webStackFiles)('%s creates every App without asset staging', (file) => {
    const text = readFileSync(join(TEST_DIR, file), 'utf8');
    expect(text).not.toMatch(/\bnew\s+(\w+\.)?App\s*\(/);
    expect(text).not.toMatch(/\bApp\s+as\s+\w+/);
    expect(text).toContain('appWithoutAssetStaging(');
  });
});
