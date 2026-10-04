/**
 * The broker stack is pinned to ap-northeast-1, and a different configured region is refused.
 *
 * `region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1'` never fell back: the CDK CLI always
 * exports `CDK_DEFAULT_REGION` (falling back to `us-east-1`), and an offline synth produced a
 * `us-east-1` stack. These tests run the real app entry point, so the wiring is pinned, not only
 * the helper.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BROKER_STACK_REGION, brokerStackRegion } from '../lib/config/broker-bootstrap';

const INFRA = resolve(__dirname, '..');

/** Runs `bin/dev-deploy-broker.ts` the way `cdk synth --app …` does, without AWS credentials. */
const synthBin = (outdir: string, region: string | undefined) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AWS_') || key.startsWith('CDK_DEFAULT_')) delete env[key];
  env.CDK_OUTDIR = outdir;
  if (region !== undefined) env.CDK_DEFAULT_REGION = region;
  return execFileSync('npx', ['ts-node', '--prefer-ts-exts', 'bin/dev-deploy-broker.ts'], {
    cwd: INFRA,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

describe('broker stack region (pinned, fail-closed)', () => {
  let outdir: string | undefined;
  afterEach(() => {
    if (outdir !== undefined) rmSync(outdir, { recursive: true, force: true });
    outdir = undefined;
  });

  it('the region is ap-northeast-1', () => {
    expect(BROKER_STACK_REGION).toBe('ap-northeast-1');
    expect(brokerStackRegion({})).toBe('ap-northeast-1');
    expect(brokerStackRegion({ CDK_DEFAULT_REGION: 'ap-northeast-1' })).toBe('ap-northeast-1');
  });

  it.each(['us-east-1', 'ap-northeast-3', ''])('refuses CDK_DEFAULT_REGION=%j instead of overriding it', (region) => {
    expect(() => brokerStackRegion({ CDK_DEFAULT_REGION: region })).toThrow(/must be synthesized for ap-northeast-1/);
  });

  it('🔴 the app entry point refuses a us-east-1 synth (the CLI default without a configured region)', () => {
    outdir = mkdtempSync(join(tmpdir(), 'broker-region-'));
    let stderr = '';
    expect(() => {
      try {
        synthBin(outdir!, 'us-east-1');
      } catch (e) {
        stderr = String((e as { stderr?: string }).stderr);
        throw e;
      }
    }).toThrow();
    expect(stderr).toContain('must be synthesized for ap-northeast-1');
  }, 120_000);

  it('🔴 the app entry point synthesizes the stack for ap-northeast-1, with or without CDK_DEFAULT_REGION', () => {
    for (const region of ['ap-northeast-1', undefined]) {
      outdir = mkdtempSync(join(tmpdir(), 'broker-region-'));
      synthBin(outdir, region);
      const manifest = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8')) as {
        artifacts: Record<string, { type: string; environment?: string }>;
      };
      expect(manifest.artifacts['OpenReception-DevDeployBroker']?.environment, String(region)).toBe(
        'aws://unknown-account/ap-northeast-1',
      );
      rmSync(outdir, { recursive: true, force: true });
    }
    // Two ts-node synths in series; the 60s default timed out under the parallel infra suite once the
    // app entry-point synth (app-stack-region.test.ts, #1221) ran beside it.
  }, 240_000);
});
