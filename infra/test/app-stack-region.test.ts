/**
 * The app stacks are pinned to ap-northeast-1, and a different configured region is refused (#1221).
 *
 * `bin/open-reception.ts` used `process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1'`. The CDK CLI always
 * exports `CDK_DEFAULT_REGION` (from `AWS_REGION` / the profile, falling back to `us-east-1`), so a
 * non-Tokyo profile silently moved every app stack (Web / WebMonitoring / Notification / Monitoring /
 * RealtimeRuntime) to that region. #1220 fixed the same pattern for the broker (`brokerStackRegion`,
 * `broker-stack-region.test.ts`); this pins the app the same way. `OpenReception-CfMon-*` stays in
 * `us-east-1` on purpose (CloudFront metrics are published only there).
 *
 * These tests run the real app entry point, so the wiring is pinned, not only the helper.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeArtifactState, openNextArtifactState } from '../lib/build-artifacts';
import { APP_STACK_REGION, appStackRegion } from '../lib/config/stack-region';

const INFRA = resolve(__dirname, '..');

/** Runs `bin/open-reception.ts` the way `cdk synth` does (cdk.json `app`), without AWS credentials. */
const synthBin = (outdir: string, extraEnv: Readonly<Record<string, string>>) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AWS_') || key.startsWith('CDK_DEFAULT_')) delete env[key];
  env.CDK_OUTDIR = outdir;
  Object.assign(env, extraEnv);
  return execFileSync('npx', ['ts-node', '--prefer-ts-exts', 'bin/open-reception.ts'], {
    cwd: INFRA,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 200_000,
  });
};

type Manifest = { artifacts: Record<string, { type: string; environment?: string }> };
const stackEnvironments = (outdir: string): Record<string, string | undefined> => {
  const manifest = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8')) as Manifest;
  return Object.fromEntries(
    Object.entries(manifest.artifacts)
      .filter(([, a]) => a.type === 'aws:cloudformation:stack')
      .map(([name, a]) => [name, a.environment]),
  );
};

// A synth of the whole app needs `.open-next/` (WebStack assets). The refusal does not: it throws
// before any stack is constructed, so that test always runs.
const ARTIFACTS = openNextArtifactState(join(INFRA, '..'));
const OPEN_NEXT_READY = ARTIFACTS.state === 'fresh';
if (!OPEN_NEXT_READY) {
  console.warn(`[infra] app entry-point region synth skipped: ${describeArtifactState(ARTIFACTS)}`);
}

describe('app stack region (pinned, fail-closed)', () => {
  let outdir: string | undefined;
  afterEach(() => {
    if (outdir !== undefined) rmSync(outdir, { recursive: true, force: true });
    outdir = undefined;
  });

  it('the region is ap-northeast-1', () => {
    expect(APP_STACK_REGION).toBe('ap-northeast-1');
    expect(appStackRegion({})).toBe('ap-northeast-1');
    expect(appStackRegion({ CDK_DEFAULT_REGION: 'ap-northeast-1' })).toBe('ap-northeast-1');
  });

  it.each(['us-east-1', 'ap-northeast-3', '', 'AP-NORTHEAST-1', ' ap-northeast-1'])('refuses CDK_DEFAULT_REGION=%j instead of overriding it', (region) => {
    expect(() => appStackRegion({ CDK_DEFAULT_REGION: region })).toThrow(
      /open-reception app stacks must be synthesized for ap-northeast-1, but CDK_DEFAULT_REGION is/,
    );
  });

  it('🔴 the app entry point refuses a us-east-1 synth (the CLI default without a configured region)', () => {
    outdir = mkdtempSync(join(tmpdir(), 'app-region-'));
    let stderr = '';
    expect(() => {
      try {
        synthBin(outdir!, { CDK_DEFAULT_REGION: 'us-east-1' });
      } catch (e) {
        stderr = String((e as { stderr?: string }).stderr);
        throw e;
      }
    }).toThrow();
    expect(stderr).toContain('open-reception app stacks must be synthesized for ap-northeast-1');
  }, 120_000);

  // One full synth only (it bundles the WebStack assets and is heavy; a second one starved the broker's
  // entry-point synth under the parallel suite). An account is set so the cross-region CfMon stack is
  // built too, which pins that the region pin does not swallow CfMon's explicit us-east-1.
  it.runIf(OPEN_NEXT_READY)(
    '🔴 with CDK_DEFAULT_REGION unset the app entry point puts every app stack in ap-northeast-1, and only CfMon in us-east-1',
    () => {
      outdir = mkdtempSync(join(tmpdir(), 'app-region-'));
      synthBin(outdir, { CDK_DEFAULT_ACCOUNT: '123456789012' });
      const envs = stackEnvironments(outdir);
      expect(envs).toEqual({
        'OpenReception-Web-dev': 'aws://123456789012/ap-northeast-1',
        'OpenReception-WebMonitoring-dev': 'aws://123456789012/ap-northeast-1',
        'OpenReception-Notification-dev': 'aws://123456789012/ap-northeast-1',
        'OpenReception-Monitoring-dev': 'aws://123456789012/ap-northeast-1',
        'OpenReception-CfMon-dev': 'aws://123456789012/us-east-1',
      });
    },
    240_000,
  );
});
