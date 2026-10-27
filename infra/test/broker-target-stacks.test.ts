import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Target = { stackName: string; region: string };
type Decision = { result: string; rule: string | null; reason: string | null; stacks: Array<Target & { status: string | null }> };
type AwsResult = { ok: true; json: unknown } | { ok: false; stderr: string };
type M = {
  STABLE_STATUSES: readonly string[];
  RULES: Record<string, string>;
  DENIED_EXIT_CODE: number;
  parseStacks: (spec: unknown, region: unknown) => Target[];
  evaluateStacks: (targets: unknown, observed: unknown) => Decision;
  observeStack: (t: Target, runAws: (args: string[]) => AwsResult) => { missing?: true; status?: string };
  runCli: (
    argv: string[],
    opts: { now?: Date; env?: Record<string, string | undefined>; runAws?: (args: string[]) => AwsResult; decisionPath?: string },
  ) => { exitCode: number; record: Decision & { executionId: string | null; revision: string | null } };
};

const MODULE = resolve(__dirname, '../broker/target-stacks.mjs');
let T: M;
beforeAll(async () => {
  T = (await import(pathToFileURL(MODULE).href)) as M;
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const workspace = () => {
  const d = mkdtempSync(join(tmpdir(), 'or-target-stacks-'));
  dirs.push(d);
  return d;
};

const SPEC = 'OpenReception-Web-dev,OpenReception-WebMonitoring-dev,OpenReception-CfMon-dev@us-east-1';
const REGION = 'ap-northeast-1';
const REV = 'a'.repeat(40);
const missingStderr = (name: string) =>
  `\nAn error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${name} does not exist\n`;
const found = (name: string, status: string): AwsResult => ({ ok: true, json: { Stacks: [{ StackName: name, StackStatus: status }] } });

/** A fake CLI keyed by stack name: a status string, 'MISSING', or a raw result. */
const fakeAws = (by: Record<string, string | AwsResult>) => (args: string[]): AwsResult => {
  expect(args.slice(0, 3)).toEqual(['cloudformation', 'describe-stacks', '--stack-name']);
  const name = args[3]!;
  const v = by[name];
  if (v === undefined || v === 'MISSING') return { ok: false, stderr: missingStderr(name) };
  return typeof v === 'string' ? found(name, v) : v;
};

describe('target-stack stability decision (S10a)', () => {
  const targets = (): Target[] => T.parseStacks(SPEC, REGION);

  it('parses the reviewed spec; the default region is the broker region', () => {
    expect(targets()).toEqual([
      { stackName: 'OpenReception-Web-dev', region: REGION },
      { stackName: 'OpenReception-WebMonitoring-dev', region: REGION },
      { stackName: 'OpenReception-CfMon-dev', region: 'us-east-1' },
    ]);
  });

  it.each([
    ['missing spec', undefined, REGION],
    ['empty spec', '', REGION],
    ['missing region', SPEC, undefined],
    ['bad region', SPEC, 'ap-northeast'],
    ['bad name', 'a b', REGION],
    ['double @', 'A@us-east-1@x', REGION],
    ['duplicate', 'A,A', REGION],
    ['empty entry', 'A,,B', REGION],
  ])('refuses %s', (_l, spec, region) => {
    expect(() => T.parseStacks(spec, region)).toThrow();
  });

  it.each(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE', 'IMPORT_ROLLBACK_COMPLETE'])('%s is settled', (status) => {
    const d = T.evaluateStacks(targets(), targets().map(() => ({ status })));
    expect(d).toMatchObject({ result: 'allowed', rule: null });
  });

  it('a stack that does not exist yet is allowed (the promotion creates it)', () => {
    const d = T.evaluateStacks(targets(), [{ missing: true }, { status: 'UPDATE_COMPLETE' }, { missing: true }]);
    expect(d.result).toBe('allowed');
    expect(d.stacks.map((s) => s.status)).toEqual([null, 'UPDATE_COMPLETE', null]);
  });

  it.each([
    'UPDATE_ROLLBACK_FAILED',
    'ROLLBACK_FAILED',
    'ROLLBACK_COMPLETE',
    'DELETE_FAILED',
    'CREATE_FAILED',
    'UPDATE_FAILED',
    'CREATE_IN_PROGRESS',
    'UPDATE_IN_PROGRESS',
    'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
    'UPDATE_ROLLBACK_IN_PROGRESS',
    'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
    'ROLLBACK_IN_PROGRESS',
    'DELETE_IN_PROGRESS',
    'REVIEW_IN_PROGRESS',
    'IMPORT_IN_PROGRESS',
    'IMPORT_ROLLBACK_IN_PROGRESS',
    'IMPORT_ROLLBACK_FAILED',
    'SOMETHING_NEW',
  ])('%s on any one stack denies TARGET_STACK_NOT_STABLE', (status) => {
    const d = T.evaluateStacks(targets(), [{ status: 'UPDATE_COMPLETE' }, { missing: true }, { status }]);
    expect(d).toMatchObject({ result: 'denied', rule: 'TARGET_STACK_NOT_STABLE' });
    expect(d.reason).toContain(`us-east-1/OpenReception-CfMon-dev=${status}`);
  });

  it('an unreadable status denies (never "missing", never "settled")', () => {
    for (const bad of [{}, null, { status: 1 }, { missing: false }, { missing: 'yes' }]) {
      const d = T.evaluateStacks(targets(), [{ status: 'UPDATE_COMPLETE' }, bad, { status: 'UPDATE_COMPLETE' }]);
      expect(d, JSON.stringify(bad)).toMatchObject({ result: 'denied', rule: 'TARGET_STACK_UNVERIFIABLE' });
    }
  });

  it('refuses an empty target list or a length mismatch', () => {
    expect(T.evaluateStacks([], []).rule).toBe('TARGET_STACK_INPUT_INVALID');
    expect(T.evaluateStacks(targets(), [{ status: 'UPDATE_COMPLETE' }]).rule).toBe('TARGET_STACK_INPUT_INVALID');
    expect(T.evaluateStacks(targets(), null).rule).toBe('TARGET_STACK_INPUT_INVALID');
  });
});

describe('reading one stack', () => {
  const t = { stackName: 'OpenReception-Web-dev', region: REGION };

  it('passes name and region to DescribeStacks', () => {
    let seen: string[] = [];
    T.observeStack(t, (args) => {
      seen = args;
      return found(t.stackName, 'UPDATE_COMPLETE');
    });
    expect(seen).toEqual(['cloudformation', 'describe-stacks', '--stack-name', 'OpenReception-Web-dev', '--region', REGION]);
  });

  it('only the exact "does not exist" answer for this name is missing', () => {
    expect(T.observeStack(t, () => ({ ok: false, stderr: missingStderr(t.stackName) }))).toEqual({ missing: true });
    for (const stderr of [
      missingStderr('OpenReception-Web-dev-other'),
      missingStderr('Other'),
      'An error occurred (AccessDenied) when calling the DescribeStacks operation: not authorized',
      'An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded',
      'Stack with id OpenReception-Web-dev does not exist',
      '',
    ]) {
      expect(T.observeStack(t, () => ({ ok: false, stderr })), stderr).toEqual({});
    }
  });

  it('an unexpected answer shape is unknown', () => {
    for (const json of [{}, { Stacks: [] }, { Stacks: [{ StackName: 'Other', StackStatus: 'UPDATE_COMPLETE' }] }, { Stacks: [{ StackName: t.stackName }] }, { Stacks: [{ StackName: t.stackName, StackStatus: 'UPDATE_COMPLETE' }, { StackName: t.stackName, StackStatus: 'UPDATE_COMPLETE' }] }, null]) {
      expect(T.observeStack(t, () => ({ ok: true, json })), JSON.stringify(json)).toEqual({});
    }
  });
});

describe('CLI decision file', () => {
  const env = { OR_BROKER_TARGET_REGION: REGION, OR_PIPELINE_EXECUTION_ID: 'e-1', OR_TRUSTED_SOURCE_REVISION: REV };

  it('writes an allowed decision bound to this execution and revision; exit 0', () => {
    const decisionPath = join(workspace(), 'target-stacks.json');
    const r = T.runCli(['--stacks', SPEC], { env, decisionPath, runAws: fakeAws({ 'OpenReception-Web-dev': 'UPDATE_COMPLETE', 'OpenReception-WebMonitoring-dev': 'UPDATE_ROLLBACK_COMPLETE' }) });
    expect(r.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(decisionPath, 'utf8'));
    expect(written).toMatchObject({ result: 'allowed', rule: null, executionId: 'e-1', revision: REV });
    expect(written.stacks.map((s: { status: string | null }) => s.status)).toEqual(['UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', null]);
  });

  it('a failed rollback denies with exit 46 and still records the decision', () => {
    const decisionPath = join(workspace(), 'target-stacks.json');
    const r = T.runCli(['--stacks', SPEC], { env, decisionPath, runAws: fakeAws({ 'OpenReception-Web-dev': 'UPDATE_ROLLBACK_FAILED' }) });
    expect(r.exitCode).toBe(T.DENIED_EXIT_CODE);
    expect(T.DENIED_EXIT_CODE).toBe(46);
    expect(JSON.parse(readFileSync(decisionPath, 'utf8'))).toMatchObject({ result: 'denied', rule: 'TARGET_STACK_NOT_STABLE' });
  });

  it('an existing decision file is never overwritten (exclusive create); the run denies', () => {
    const decisionPath = join(workspace(), 'target-stacks.json');
    writeFileSync(decisionPath, '{"result":"allowed"}');
    const r = T.runCli(['--stacks', SPEC], { env, decisionPath, runAws: fakeAws({}) });
    expect(r.exitCode).toBe(46);
    expect(readFileSync(decisionPath, 'utf8')).toBe('{"result":"allowed"}');
  });

  it('bad configuration denies before any AWS call', () => {
    const decisionPath = join(workspace(), 'target-stacks.json');
    const r = T.runCli(['--stacks', SPEC], {
      env: { ...env, OR_BROKER_TARGET_REGION: undefined },
      decisionPath,
      runAws: () => {
        throw new Error('must not be called');
      },
    });
    expect(r.exitCode).toBe(46);
    expect(r.record.rule).toBe('TARGET_STACK_INPUT_INVALID');
  });

  it('runs as a program with the AWS CLI from an absolute PATH entry only', () => {
    // The program writes to the broker-owned dir; this test relies on it NOT existing here, so
    // the exclusive create fails and nothing is written outside the scratch dir.
    if (existsSync('/tmp/open-reception-broker-out')) return;
    const dir = workspace();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const fake = (log: string) =>
      [
        '#!/bin/sh',
        `echo "$*" >> ${join(dir, log)}`,
        'case "$4" in',
        '  OpenReception-CfMon-dev) echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id $4 does not exist" >&2; exit 254;;',
        '  *) echo "{\\"Stacks\\":[{\\"StackName\\":\\"$4\\",\\"StackStatus\\":\\"UPDATE_COMPLETE\\"}]}";;',
        'esac',
      ].join('\n');
    writeFileSync(join(bin, 'aws'), fake('calls.log'));
    chmodSync(join(bin, 'aws'), 0o755);
    // A planted `aws` in the working directory (the candidate tree in the broker) is never used.
    const work = join(dir, 'work');
    mkdirSync(work);
    writeFileSync(join(work, 'aws'), fake('planted.log'));
    chmodSync(join(work, 'aws'), 0o755);
    const r = spawnSync('node', [MODULE, '--stacks', SPEC], { cwd: work, env: { PATH: `.::${bin}:${process.env.PATH}`, ...env } as Record<string, string> as NodeJS.ProcessEnv, encoding: 'utf8' });
    expect(r.status).toBe(46);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ event: 'target_stacks.denied', result: 'allowed' });
    expect(existsSync(join(dir, 'planted.log'))).toBe(false);
    expect(readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')).toEqual([
      'cloudformation describe-stacks --stack-name OpenReception-Web-dev --region ap-northeast-1 --output json',
      'cloudformation describe-stacks --stack-name OpenReception-WebMonitoring-dev --region ap-northeast-1 --output json',
      'cloudformation describe-stacks --stack-name OpenReception-CfMon-dev --region us-east-1 --output json',
    ]);
  });
});
