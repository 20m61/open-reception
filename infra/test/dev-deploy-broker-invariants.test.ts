import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  BROKER_NOT_ARMED_RESULT_SCRIPT,
  BROKER_REVISION_CHECK_SCRIPT,
  DevDeployBrokerStack,
  VALIDATION_EVIDENCE_SCRIPT,
  nodeEval,
} from '../lib/stacks/dev-deploy-broker-stack';

/**
 * Adversarial Phase 1 invariants for the dev deploy broker (#1146).
 *
 * Every assertion runs against the synthesized template (or executes the exact command text
 * that the template carries), so a regression in the stack cannot hide behind a helper.
 */

type Json = Record<string, unknown>;
type Statement = { Effect: string; Action: string | string[]; Resource: unknown };

const VALIDATION_PROJECT = 'OpenReceptionDevDeployValidation';
const BROKER_PROJECT = 'OpenReceptionTrustedDevDeployBroker';
const VALIDATION_ROLE = 'OpenReceptionDevDeployValidationRole';
const BROKER_ROLE = 'OpenReceptionTrustedDevDeployBrokerRole';
const TRUSTED_COMMIT_ID = '#{OpenReceptionSource.CommitId}';

const REV_A = 'a'.repeat(40);
const REV_B = '0123456789abcdef0123456789abcdef01234567';

const template = (() => {
  const app = new cdk.App();
  const stack = new DevDeployBrokerStack(app, 'TestDevDeployBroker', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  return Template.fromStack(stack);
})();
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: Json }>;

const byType = (type: string) =>
  Object.entries(resources).filter(([, r]) => r.Type === type);

const pipelineResource = () => {
  const pipelines = byType('AWS::CodePipeline::Pipeline');
  expect(pipelines).toHaveLength(1);
  return pipelines[0]![1];
};

const project = (name: string): Json => {
  const found = byType('AWS::CodeBuild::Project').find(([, r]) => r.Properties.Name === name);
  expect(found, `project ${name}`).toBeDefined();
  return found![1].Properties;
};

const buildSpecText = (name: string): string => {
  const source = project(name).Source as { Type: string; BuildSpec: unknown };
  expect(typeof source.BuildSpec, `${name} BuildSpec must be an inline string`).toBe('string');
  return source.BuildSpec as string;
};

const buildSpec = (name: string) =>
  JSON.parse(buildSpecText(name)) as {
    version: string;
    phases: Record<string, { commands: string[] }>;
    artifacts?: unknown;
  };

const allCommands = (name: string): string[] =>
  Object.values(buildSpec(name).phases).flatMap((phase) => phase.commands);

const roleLogicalId = (roleName: string): string => {
  const found = byType('AWS::IAM::Role').find(([, r]) => r.Properties.RoleName === roleName);
  expect(found, `role ${roleName}`).toBeDefined();
  return found![0];
};

const statementsFor = (roleLogical: string): Statement[] =>
  byType('AWS::IAM::Policy')
    .filter(([, r]) =>
      ((r.Properties.Roles ?? []) as Array<{ Ref?: string }>).some((x) => x?.Ref === roleLogical),
    )
    .flatMap(([, r]) => (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement);

const actionsOf = (s: Statement): string[] =>
  (Array.isArray(s.Action) ? s.Action : [s.Action]).map((a) => a.toLowerCase());

const allowedActions = (roleName: string): string[] =>
  statementsFor(roleLogicalId(roleName))
    .filter((s) => s.Effect === 'Allow')
    .flatMap(actionsOf);

const ARTIFACT_BUCKET = byType('AWS::S3::Bucket').map(([id]) => id);

const FORBIDDEN_ACTION_PREFIXES = [
  'sts:',
  'iam:',
  'cloudformation:',
  'codestar-connections:',
  'codeconnections:',
  'secretsmanager:',
  'ssm:',
  'kms:',
  'lambda:',
  'dynamodb:',
  'cloudfront:',
  'codepipeline:',
  'codebuild:startbuild',
];

describe('dev deploy broker invariants: validation role (candidate code executes here)', () => {
  it('holds no AssumeRole / PassRole / CloudFormation / connection-token / secret authority', () => {
    const actions = allowedActions(VALIDATION_ROLE);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      for (const prefix of FORBIDDEN_ACTION_PREFIXES) {
        expect(action.startsWith(prefix), `${action} must not be granted to validation`).toBe(false);
      }
      expect(action).not.toBe('*');
    }
  });

  it('can write S3 only to the pipeline artifact bucket (never the CDK asset / deploy buckets)', () => {
    const statements = statementsFor(roleLogicalId(VALIDATION_ROLE)).filter((s) =>
      actionsOf(s).some((a) => a.startsWith('s3:put') || a.startsWith('s3:delete')),
    );
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      const serialized = JSON.stringify(statement.Resource);
      expect(serialized).not.toContain('cdk-');
      expect(serialized).not.toContain('"*"');
      const referenced = ARTIFACT_BUCKET.filter((id) => serialized.includes(id));
      expect(referenced, 'S3 write must be scoped to the pipeline artifact bucket').toHaveLength(1);
    }
  });

  it('runs unprivileged with concurrency 1 and bounded build/queue timeouts (cost guard)', () => {
    const p = project(VALIDATION_PROJECT);
    expect(p.ConcurrentBuildLimit).toBe(1);
    expect(p.TimeoutInMinutes).toBe(30);
    expect(p.QueuedTimeoutInMinutes).toBe(5);
    const env = p.Environment as Json;
    expect(env.PrivilegedMode).toBe(false);
    expect(env.ComputeType).toBe('BUILD_GENERAL1_SMALL');
  });

  it('synthesizes only the three reviewed -dev stacks with env=dev', () => {
    const synth = allCommands(VALIDATION_PROJECT).find((c) => c.includes('cdk synth'));
    expect(synth).toBeDefined();
    const stackNames = synth!.match(/OpenReception-[A-Za-z]+-[a-z]+/g) ?? [];
    expect(stackNames.sort()).toEqual(
      ['OpenReception-CfMon-dev', 'OpenReception-Web-dev', 'OpenReception-WebMonitoring-dev'].sort(),
    );
    expect(synth).toContain('-c env=dev');
    expect(synth).not.toMatch(/cdk (deploy|destroy|bootstrap)/);
  });
});

describe('dev deploy broker invariants: trusted broker (stack-owned buildspec, unarmed)', () => {
  it('both projects take an inline stack-owned buildspec, never a source filename', () => {
    for (const name of [VALIDATION_PROJECT, BROKER_PROJECT]) {
      const source = project(name).Source as { Type: string };
      expect(source.Type).toBe('CODEPIPELINE');
      const text = buildSpecText(name);
      // fromSourceFilename() would synthesize a bare path like "buildspec.yml".
      expect(text.trim().startsWith('{')).toBe(true);
      expect(buildSpec(name).version).toBe('0.2');
    }
  });

  it('never executes files from the candidate artifact', () => {
    const spec = buildSpec(BROKER_PROJECT);
    // Only a build phase: no install/pre_build hook that could run package managers.
    expect(Object.keys(spec.phases)).toEqual(['build']);
    const commands = allCommands(BROKER_PROJECT);
    const allowedShapes = [
      /^test -f [A-Za-z0-9_./-]+\.json$/,
      /^node -e '[^']*'$/,
      /^aws s3 cp "s3:\/\/\$OR_TRUSTED_POLICY_BUCKET\/\$OR_TRUSTED_POLICY_KEY" \/tmp\/open-reception-trusted-policy\.mjs --only-show-errors$/,
      /^node \/tmp\/open-reception-trusted-policy\.mjs --assembly infra\/cdk\.out --account "\$OR_BROKER_TARGET_ACCOUNT" > trusted-policy-result\.json$/,
      /^echo "[^"$`]*" >&2$/,
      /^exit 42$/,
    ];
    for (const command of commands) {
      expect(
        allowedShapes.some((shape) => shape.test(command)),
        `unexpected broker command: ${command}`,
      ).toBe(true);
      if (command.startsWith("node -e '")) {
        // Inline JS may only use the fs builtin: no child processes, dynamic imports or eval.
        const requires = [...command.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]);
        expect(requires.every((r) => r === '"fs"'), `requires: ${requires.join(',')}`).toBe(true);
        expect(command).not.toMatch(/child_process|\bimport\(|\beval\(|new Function|spawn|exec/);
      } else {
        expect(command).not.toMatch(/(^|[\s;&|(])(npm|npx|yarn|pnpm|bash|sh|source|make|cdk)(\s|$)/);
      }
      expect(command).not.toMatch(/(^|\s)\.\//);
      expect(command).not.toContain('scripts/');
      expect(command).not.toContain('require("./');
      expect(command).not.toMatch(/\bimport\(/);
    }
    expect(commands.at(-1)).toBe('exit 42');
  });

  it('holds no sts:AssumeRole or mutation authority; no role in the stack can reach a deploy role', () => {
    const broker = allowedActions(BROKER_ROLE);
    for (const action of broker) {
      for (const prefix of FORBIDDEN_ACTION_PREFIXES) {
        expect(action.startsWith(prefix), `${action} must not be granted to broker`).toBe(false);
      }
      expect(action.startsWith('s3:put') || action.startsWith('s3:delete')).toBe(false);
    }

    // The only AssumeRole in the stack is CodePipeline assuming its own per-action roles.
    const pipelineActionRoles = new Set(
      byType('AWS::IAM::Role')
        .map(([id]) => id)
        .filter((id) => id.startsWith('Pipeline') && id.includes('CodePipelineActionRole')),
    );
    for (const [, policy] of byType('AWS::IAM::Policy')) {
      const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
      for (const statement of statements) {
        if (!actionsOf(statement).some((a) => a.startsWith('sts:'))) continue;
        const target = (statement.Resource as { 'Fn::GetAtt'?: [string, string] })['Fn::GetAtt'];
        expect(target, 'sts:* must target a local pipeline action role').toBeDefined();
        expect(pipelineActionRoles.has(target![0])).toBe(true);
      }
    }
    const serialized = JSON.stringify(template.toJSON());
    expect(serialized).not.toContain('OpenReceptionClaudeDeploy');
    expect(serialized).not.toContain('OpenReceptionClaudeEntry');
    expect(serialized).not.toMatch(/iam:PassRole/i);
  });

  it('runs unprivileged with concurrency 1 and bounded timeouts', () => {
    const p = project(BROKER_PROJECT);
    expect(p.ConcurrentBuildLimit).toBe(1);
    expect(p.TimeoutInMinutes).toBe(10);
    expect(p.QueuedTimeoutInMinutes).toBe(5);
    expect((p.Environment as Json).PrivilegedMode).toBe(false);
  });

  it('pins the policy to the content-addressed asset and exposes its hash for policy_version', () => {
    const vars = Object.fromEntries(
      ((project(BROKER_PROJECT).Environment as Json).EnvironmentVariables as Array<{
        Name: string;
        Value: unknown;
      }>).map((v) => [v.Name, v.Value]),
    );
    expect(vars.OR_TRUSTED_POLICY_ASSET_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(vars.OR_TRUSTED_POLICY_KEY).toBe(`${vars.OR_TRUSTED_POLICY_ASSET_HASH}.mjs`);
    // The trusted revision is NOT a project-level default; only the pipeline action injects it.
    expect(vars.OR_TRUSTED_SOURCE_REVISION).toBeUndefined();
  });
});

describe('dev deploy broker invariants: trusted source revision', () => {
  it('injects OR_TRUSTED_SOURCE_REVISION from the CodeConnections CommitId into both builds', () => {
    const pipeline = pipelineResource();
    const stages = pipeline.Properties.Stages as Array<{
      Name: string;
      Actions: Array<{ Name: string; Configuration: Json }>;
    }>;
    const build = stages.flatMap((s) => s.Actions).filter((a) => 'ProjectName' in a.Configuration);
    expect(build).toHaveLength(2);
    for (const action of build) {
      const vars = JSON.parse(action.Configuration.EnvironmentVariables as string) as Array<{
        name: string;
        type: string;
        value: string;
      }>;
      expect(vars).toEqual([
        { name: 'OR_TRUSTED_SOURCE_REVISION', type: 'PLAINTEXT', value: TRUSTED_COMMIT_ID },
      ]);
    }
    for (const name of [VALIDATION_PROJECT, BROKER_PROJECT]) {
      const text = buildSpecText(name);
      expect(text).not.toContain('CODEBUILD_RESOLVED_SOURCE_VERSION');
      expect(text).not.toContain('rev-parse');
      expect(text).not.toMatch(/\bgit\b/);
    }
  });

  it('the synthesized commands are exactly the exported, tested scripts', () => {
    expect(allCommands(VALIDATION_PROJECT)).toContain(nodeEval(VALIDATION_EVIDENCE_SCRIPT));
    expect(allCommands(BROKER_PROJECT)).toContain(nodeEval(BROKER_REVISION_CHECK_SCRIPT));
    expect(allCommands(BROKER_PROJECT)).toContain(nodeEval(BROKER_NOT_ARMED_RESULT_SCRIPT));
  });

  it('nodeEval refuses snippets that would break shell single quoting', () => {
    expect(() => nodeEval("console.log('x')")).toThrow();
  });
});

// ---- Execute the exact synthesized command text in a scratch workspace -------------------

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const workspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'or-broker-cmd-'));
  dirs.push(dir);
  return dir;
};

const commandContaining = (projectName: string, marker: string): string => {
  const found = allCommands(projectName).filter((c) => c.includes(marker));
  expect(found, `exactly one command containing ${marker}`).toHaveLength(1);
  return found[0]!;
};

const run = (
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
): { ok: boolean; stdout: string; stderr: string } => {
  const cleanEnv: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) cleanEnv[k] = v;
  try {
    const stdout = execFileSync('bash', ['-c', command], {
      cwd,
      env: cleanEnv as NodeJS.ProcessEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

const revisionCheck = () => commandContaining(BROKER_PROJECT, 'broker-evidence.json","utf8"');
const notArmed = () => commandContaining(BROKER_PROJECT, 'BROKER_NOT_ARMED');
const validationEvidence = () =>
  commandContaining(VALIDATION_PROJECT, 'writeFileSync("broker-evidence.json"');

const writeEvidence = (dir: string, evidence: unknown) =>
  writeFileSync(join(dir, 'broker-evidence.json'), JSON.stringify(evidence));

describe('broker revision binding (stale revision / artifact substitution)', () => {
  it('accepts evidence produced by validation for the same trusted CommitId', () => {
    const dir = workspace();
    expect(run(validationEvidence(), dir, { OR_TRUSTED_SOURCE_REVISION: REV_A }).ok).toBe(true);
    expect(run(revisionCheck(), dir, { OR_TRUSTED_SOURCE_REVISION: REV_A }).ok).toBe(true);
  });

  it('rejects evidence from another revision (stale or substituted artifact)', () => {
    const dir = workspace();
    expect(run(validationEvidence(), dir, { OR_TRUSTED_SOURCE_REVISION: REV_B }).ok).toBe(true);
    const r = run(revisionCheck(), dir, { OR_TRUSTED_SOURCE_REVISION: REV_A });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('validation evidence revision mismatch');
  });

  it.each([
    ['short SHA on both sides', REV_A.slice(0, 7), REV_A.slice(0, 7)],
    ['uppercase trusted SHA', REV_A.toUpperCase(), REV_A.toUpperCase()],
    ['missing trusted revision', undefined, REV_A],
    ['empty trusted revision', '', ''],
    ['missing evidence revision', REV_A, undefined],
  ])('fails closed on %s', (_label, trusted, declared) => {
    const dir = workspace();
    writeEvidence(dir, { schemaVersion: 1, sourceRevision: declared });
    expect(run(revisionCheck(), dir, { OR_TRUSTED_SOURCE_REVISION: trusted }).ok).toBe(false);
  });

  it('fails closed on an unknown evidence schema or a missing evidence file', () => {
    const dir = workspace();
    writeEvidence(dir, { schemaVersion: 2, sourceRevision: REV_A });
    expect(run(revisionCheck(), dir, { OR_TRUSTED_SOURCE_REVISION: REV_A }).ok).toBe(false);
    const empty = workspace();
    expect(run(revisionCheck(), empty, { OR_TRUSTED_SOURCE_REVISION: REV_A }).ok).toBe(false);
  });

  it('validation refuses to emit evidence without a full trusted revision', () => {
    for (const bad of [undefined, '', REV_A.slice(0, 12), `${REV_A}0`]) {
      const dir = workspace();
      expect(run(validationEvidence(), dir, { OR_TRUSTED_SOURCE_REVISION: bad }).ok).toBe(false);
      expect(existsSync(join(dir, 'broker-evidence.json'))).toBe(false);
    }
  });
});

describe('BROKER_NOT_ARMED result carries the Foundation S11 fields', () => {
  const HASH = 'f'.repeat(64);
  const allowedPolicy = { policyVersion: 1, result: 'allowed', violations: [], counts: {} };
  const baseEnv = (overrides: Record<string, string | undefined> = {}) => ({
    OR_TRUSTED_SOURCE_REVISION: REV_A,
    CODEBUILD_BUILD_ID: 'OpenReceptionTrustedDevDeployBroker:11111111-1111-1111-1111-111111111111',
    CODEBUILD_BUILD_ARN: 'arn:aws:codebuild:ap-northeast-1:123456789012:build/x',
    OR_TRUSTED_POLICY_ASSET_HASH: HASH,
    ...overrides,
  });
  const prepared = (policy: unknown = allowedPolicy): string => {
    const dir = workspace();
    writeFileSync(join(dir, 'trusted-policy-result.json'), JSON.stringify(policy));
    return dir;
  };
  const result = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'broker-result.json'), 'utf8')) as Record<string, unknown>;

  it('emits denied/BROKER_NOT_ARMED with source_revision, attempt_id, decided_at, policy_version', () => {
    const dir = prepared();
    const r = run(notArmed(), dir, baseEnv());
    expect(r.ok).toBe(true);
    const out = result(dir);
    expect(out).toMatchObject({
      result: 'denied',
      rule: 'BROKER_NOT_ARMED',
      stage: 'broker-bootstrap',
      source_revision: REV_A,
      attempt_id: baseEnv().CODEBUILD_BUILD_ID,
      policy_version: `trusted-policy@1+sha256:${HASH}`,
      resource: null,
      retryable: false,
      evidence_ref: baseEnv().CODEBUILD_BUILD_ARN,
    });
    expect(typeof out.decided_at).toBe('string');
    expect(new Date(out.decided_at as string).toISOString()).toBe(out.decided_at);
    expect(Object.keys(out).sort()).toEqual(
      [
        'attempt_id',
        'decided_at',
        'evidence_ref',
        'policy_version',
        'reason',
        'resource',
        'result',
        'retryable',
        'rule',
        'source_revision',
        'stage',
      ].sort(),
    );
    expect(JSON.parse(r.stdout.trim())).toEqual(out);
  });

  it('two attempts on one revision are distinguishable by attempt_id', () => {
    const a = prepared();
    const b = prepared();
    expect(run(notArmed(), a, baseEnv({ CODEBUILD_BUILD_ID: 'p:attempt-1' })).ok).toBe(true);
    expect(run(notArmed(), b, baseEnv({ CODEBUILD_BUILD_ID: 'p:attempt-2' })).ok).toBe(true);
    expect(result(a).source_revision).toBe(result(b).source_revision);
    expect(result(a).attempt_id).not.toBe(result(b).attempt_id);
  });

  it.each([
    ['short source revision', baseEnv({ OR_TRUSTED_SOURCE_REVISION: REV_A.slice(0, 7) })],
    ['missing source revision', baseEnv({ OR_TRUSTED_SOURCE_REVISION: undefined })],
    ['missing attempt id', baseEnv({ CODEBUILD_BUILD_ID: undefined })],
    ['missing policy asset hash', baseEnv({ OR_TRUSTED_POLICY_ASSET_HASH: undefined })],
    ['malformed policy asset hash', baseEnv({ OR_TRUSTED_POLICY_ASSET_HASH: 'abc' })],
  ])('writes no result and fails on %s', (_label, env) => {
    const dir = prepared();
    expect(run(notArmed(), dir, env).ok).toBe(false);
    expect(existsSync(join(dir, 'broker-result.json'))).toBe(false);
  });

  it('writes no result when the trusted policy result is missing or not allowed', () => {
    const denied = prepared({ ...allowedPolicy, result: 'denied' });
    expect(run(notArmed(), denied, baseEnv()).ok).toBe(false);
    expect(existsSync(join(denied, 'broker-result.json'))).toBe(false);

    const missing = workspace();
    expect(run(notArmed(), missing, baseEnv()).ok).toBe(false);
    expect(existsSync(join(missing, 'broker-result.json'))).toBe(false);
  });
});

describe('dev-only reach', () => {
  it('names no production stage, stack or account alias anywhere in the template', () => {
    const serialized = JSON.stringify(template.toJSON());
    expect(serialized).not.toMatch(/prod/i);
    expect(serialized).not.toMatch(/-stg\b|staging/i);
  });
});

describe('architecture view (S8 repo-side drift check)', () => {
  const doc = readFileSync(
    resolve(__dirname, '../../docs/architecture/aws-dev-deploy-broker.md'),
    'utf8',
  );

  const declaredNames = (): string[] => {
    const start = doc.indexOf('<!-- broker-resource-names:start -->');
    const end = doc.indexOf('<!-- broker-resource-names:end -->');
    expect(start, 'doc must declare the synthesized resource names').toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return [...doc.slice(start, end).matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '').sort();
  };

  const synthesizedNames = (): string[] => {
    const pipeline = pipelineResource();
    const stages = pipeline.Properties.Stages as Array<{ Name: string; Actions: Array<{ Name: string }> }>;
    return [
      pipeline.Properties.Name as string,
      ...stages.map((s) => `${s.Name}`),
      ...stages.flatMap((s) => s.Actions.map((a) => `${s.Name}/${a.Name}`)),
      ...byType('AWS::CodeBuild::Project').map(([, r]) => r.Properties.Name as string),
      ...byType('AWS::IAM::Role')
        .map(([, r]) => r.Properties.RoleName)
        .filter((n): n is string => typeof n === 'string'),
    ].sort();
  };

  it('declares exactly the synthesized pipeline, stages, actions, projects and named roles', () => {
    expect(declaredNames()).toEqual(synthesizedNames());
  });

  it('keeps the Mermaid view on the same boundary nodes', () => {
    const mermaid = /```mermaid\n([\s\S]*?)```/.exec(doc)?.[1] ?? '';
    for (const node of [
      'CodePipeline V1',
      'Validation CodeBuild',
      'Trusted Broker CodeBuild',
      'BROKER_NOT_ARMED',
      'Content-addressed trusted policy S3 asset',
    ]) {
      expect(mermaid).toContain(node);
    }
  });
});
