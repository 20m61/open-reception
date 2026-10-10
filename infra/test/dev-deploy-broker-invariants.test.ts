import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { createHash } from 'node:crypto';
import {
  BROKER_ACCOUNT_PIN_CHECK_SCRIPT,
  BROKER_NOT_ARMED_RESULT_SCRIPT,
  BROKER_POLICY_HASH_CHECK_SCRIPT,
  BROKER_REVISION_CHECK_SCRIPT,
  DEV_DEPLOY_TARGET_ACCOUNT,
  DevDeployBrokerStack,
  PIPELINE_ARTIFACT_RETENTION_DAYS,
  ARTIFACT_HISTORY_WRITES,
  BROKER_MODULE_HASH_CHECK_SCRIPT,
  PIPELINE_NAME,
  PIPELINE_STAGES,
  BROKER_ASSEMBLY_DIR,
  BROKER_EVIDENCE_PATH,
  BROKER_OUT_DIR,
  BROKER_RESULT_PATH,
  BROKER_VALIDATED_DIR,
  BROKER_WORK_DIR,
  POLICY_RESULT_PATH,
  PROVENANCE_DECISION_PATH,
  PROVENANCE_RESULT_CHECK_SCRIPT,
  BROKER_ABORT_STATES,
  LEDGER_ATTENTION_EVENTS,
  LEDGER_AUDIT_PROTECTED_ACTIONS,
  LEDGER_AUDIT_RETENTION_DAYS,
  LEDGER_AUDIT_TRAIL_NAME,
  LEDGER_DENY_COMMAND,
  LEDGER_LOCAL_DIR,
  LEDGER_MODULE_LOCAL_PATH,
  LEDGER_MODULE_SOURCE_PATH,
  LEDGER_RUNNER_LOCAL_PATH,
  LEDGER_RUNNER_SOURCE_PATH,
  gateCommand,
  LEDGER_GATE_FILE,
  LEDGER_ID_PATTERN,
  PROVENANCE_COMMAND,
  PROVENANCE_LOCAL_PATH,
  PROVENANCE_READ_ACTIONS,
  PROVENANCE_SOURCE_PATH,
  SPARSE_LEDGER_BROKER_ACTIONS,
  SPARSE_LEDGER_PROJECT_KEY,
  TRUSTED_POLICY_LOCAL_PATH,
  TRUSTED_POLICY_SOURCE_PATH,
  VALIDATION_EVIDENCE_SCRIPT,
  ESCALATION_RULES,
  TARGET_STACKS,
  TARGET_STACKS_COMMAND,
  TARGET_STACKS_DECISION_PATH,
  TARGET_STACKS_LOCAL_PATH,
  TARGET_STACKS_RESULT_CHECK_SCRIPT,
  TARGET_STACKS_SOURCE_PATH,
  TARGET_STACK_READ_ACTIONS,
  ACCESS_RESTRICTION_COMMAND,
  ACCESS_RESTRICTION_DECISION_PATH,
  ACCESS_RESTRICTION_LOCAL_PATH,
  ACCESS_RESTRICTION_RESULT_CHECK_SCRIPT,
  ACCESS_RESTRICTION_SOURCE_PATH,
  nodeEval,
  trustedPolicySha256,
} from '../lib/stacks/dev-deploy-broker-stack';
import { BROKER_BOOTSTRAP_QUALIFIER } from '../lib/config/broker-bootstrap';
import {
  CODEBUILD_LINUX_COMPUTE,
  VALIDATION_HEAP_HEADROOM,
  VALIDATION_MEASURED_RUNS,
  VALIDATION_MIN_HEAP_MIB,
  VALIDATION_OS_RESERVE_MIB,
} from '../lib/config/validation-build-resources';
import { VALIDATION_SOURCE_BIND_SCRIPT } from '../lib/config/validation-gate-env';
import {
  DYNAMODB_TABLE_RESOURCE_POLICY_ACTIONS,
  DYNAMODB_TABLE_RESOURCE_POLICY_REJECTED,
} from '../lib/config/dynamodb-resource-policy-actions';

/**
 * Adversarial Phase 1 invariants for the dev deploy broker (#1146).
 *
 * Every assertion runs against the synthesized template (or executes the exact command text
 * that the template carries), so a regression in the stack cannot hide behind a helper.
 */

type Json = Record<string, unknown>;
type Statement = {
  Effect: string;
  Condition?: unknown;
  Action?: string | string[];
  NotAction?: unknown;
  Resource?: unknown;
  NotResource?: unknown;
  Principal?: unknown;
  NotPrincipal?: unknown;
};

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
    env: { account: '822063948773', region: 'ap-northeast-1' },
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

/** Every command the project runs, including `finally` blocks. */
const allCommands = (name: string): string[] =>
  Object.values(buildSpec(name).phases).flatMap((phase) => [
    ...phase.commands,
    ...((phase as { finally?: string[] }).finally ?? []),
  ]);

const roleLogicalId = (roleName: string): string => {
  const found = byType('AWS::IAM::Role').find(([, r]) => r.Properties.RoleName === roleName);
  expect(found, `role ${roleName}`).toBeDefined();
  return found![0];
};

const documentStatements = (doc: unknown): Statement[] => {
  const statement = (doc as { Statement?: Statement | Statement[] } | undefined)?.Statement;
  if (statement === undefined) return [];
  return Array.isArray(statement) ? statement : [statement];
};

/** Does a CloudFormation role reference (`{Ref}`, `{Fn::GetAtt}` or literal name) name this role? */
const refersToRole = (ref: unknown, roleLogical: string): boolean => {
  if (typeof ref === 'string') {
    return ref === roleLogical || ref === resources[roleLogical]?.Properties.RoleName;
  }
  const r = ref as { Ref?: string; 'Fn::GetAtt'?: [string, string] } | null;
  return r?.Ref === roleLogical || r?.['Fn::GetAtt']?.[0] === roleLogical;
};

/**
 * Every identity-policy statement that can take effect for a role, regardless of how it is
 * attached: standalone AWS::IAM::Policy / AWS::IAM::ManagedPolicy (via `Roles`),
 * AWS::IAM::RolePolicy (via `RoleName`), and the role's own inline `Policies`. AWS-managed or
 * external `ManagedPolicyArns` cannot be inspected here, so they are asserted absent separately.
 * A permissions boundary only ever narrows these; the invariants do not rely on one.
 */
const statementsFor = (roleLogical: string): Statement[] => {
  const attached = [...byType('AWS::IAM::Policy'), ...byType('AWS::IAM::ManagedPolicy')]
    .filter(([, r]) =>
      ((r.Properties.Roles ?? []) as unknown[]).some((x) => refersToRole(x, roleLogical)),
    )
    .flatMap(([, r]) => documentStatements(r.Properties.PolicyDocument));
  const rolePolicies = byType('AWS::IAM::RolePolicy')
    .filter(([, r]) => refersToRole(r.Properties.RoleName, roleLogical))
    .flatMap(([, r]) => documentStatements(r.Properties.PolicyDocument));
  const inline = ((resources[roleLogical]?.Properties.Policies ?? []) as Array<{
    PolicyDocument?: unknown;
  }>).flatMap((p) => documentStatements(p.PolicyDocument));
  return [...attached, ...rolePolicies, ...inline];
};

/** Every identity-policy statement in the stack (all roles, all attachment styles). */
const allIdentityStatements = (): Statement[] => [
  ...[
    ...byType('AWS::IAM::Policy'),
    ...byType('AWS::IAM::ManagedPolicy'),
    ...byType('AWS::IAM::RolePolicy'),
  ].flatMap(([, r]) => documentStatements(r.Properties.PolicyDocument)),
  ...byType('AWS::IAM::Role').flatMap(([, r]) =>
    ((r.Properties.Policies ?? []) as Array<{ PolicyDocument?: unknown }>).flatMap((p) =>
      documentStatements(p.PolicyDocument),
    ),
  ),
];

const actionsOf = (s: Statement): string[] =>
  (s.Action === undefined ? [] : Array.isArray(s.Action) ? s.Action : [s.Action]).map((a) =>
    a.toLowerCase(),
  );

/** Exact environment variable names a CodeBuild project declares at project level. */
const projectEnvNames = (name: string): string[] =>
  (((project(name).Environment as Json).EnvironmentVariables ?? []) as Array<{ Name: string }>)
    .map((v) => v.Name)
    .sort();

const allowedActions = (roleName: string): string[] =>
  statementsFor(roleLogicalId(roleName))
    .filter((s) => s.Effect === 'Allow')
    .flatMap(actionsOf);

/** The pipeline's artifact store (the ledger audit bucket is the other bucket in the stack). */
const ARTIFACT_BUCKET = [
  ((byType('AWS::CodePipeline::Pipeline')[0]![1].Properties.ArtifactStore as Json).Location as { Ref: string }).Ref,
];
const artifactBucketEntry = () => byType('AWS::S3::Bucket').find(([id]) => id === ARTIFACT_BUCKET[0])!;

const LEDGER_TABLES = byType('AWS::DynamoDB::Table').map(([id]) => id);

const PIPELINES = byType('AWS::CodePipeline::Pipeline').map(([id]) => id);
const PROJECTS = byType('AWS::CodeBuild::Project');

/** The three reviewed read-only provenance statements (exact actions and resource). */
const isProvenanceStatement = (s: Statement): boolean => {
  const acts = JSON.stringify(actionsOf(s).sort());
  const res = JSON.stringify(s.Resource);
  const same = (xs: readonly string[]) => acts === JSON.stringify(xs.map((a) => a.toLowerCase()).sort());
  const validationProjectId = PROJECTS.find(([, r]) => r.Properties.Name === VALIDATION_PROJECT)?.[0];
  const brokerProjectId = PROJECTS.find(([, r]) => r.Properties.Name === BROKER_PROJECT)?.[0];
  return (
    s.Effect === 'Allow' &&
    s.Condition === undefined &&
    ((same(PROVENANCE_READ_ACTIONS.pipeline) && res === JSON.stringify({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':codepipeline:ap-northeast-1:822063948773:', { Ref: PIPELINES[0] }]] })) ||
      (same(PROVENANCE_READ_ACTIONS.validationBuild) && res === JSON.stringify([{ 'Fn::GetAtt': [validationProjectId, 'Arn'] }, { 'Fn::GetAtt': [brokerProjectId, 'Arn'] }])) ||
      (same(PROVENANCE_READ_ACTIONS.artifactBucket) && res === JSON.stringify({ 'Fn::GetAtt': [ARTIFACT_BUCKET[0], 'Arn'] })))
  );
};

/** The single reviewed target-stack read (S10a): DescribeStacks on exactly the three stack ARNs. */
const TARGET_STACK_ARNS = TARGET_STACKS.map((t) => ({
  'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:cloudformation:${t.region ?? 'ap-northeast-1'}:822063948773:stack/${t.stackName}/*`]],
}));
const isTargetStackStatement = (s: Statement): boolean =>
  s.Effect === 'Allow' &&
  s.Condition === undefined &&
  JSON.stringify(actionsOf(s)) === JSON.stringify(TARGET_STACK_READ_ACTIONS.map((a) => a.toLowerCase())) &&
  JSON.stringify(s.Resource) === JSON.stringify(TARGET_STACK_ARNS);

/** Does a statement's Resource reference the sparse ledger table (any form)? */
const refersToLedger = (s: Statement): boolean =>
  LEDGER_TABLES.some((id) => JSON.stringify(s.Resource ?? null).includes(`"${id}"`));

/** The single reviewed broker statement on the ledger (exact actions, table, leading key). */
const isLedgerStatement = (s: Statement): boolean =>
  s.Effect === 'Allow' &&
  refersToLedger(s) &&
  JSON.stringify(actionsOf(s).sort()) ===
    JSON.stringify(SPARSE_LEDGER_BROKER_ACTIONS.map((a) => a.toLowerCase()).sort()) &&
  JSON.stringify(s.Condition) ===
    JSON.stringify({ 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [SPARSE_LEDGER_PROJECT_KEY] } });

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

describe('dev deploy broker invariants: IAM attachment surface (managed / inline / standalone)', () => {
  it('declares only AWS::IAM::Role and AWS::IAM::Policy (no ManagedPolicy / RolePolicy / User / Group)', () => {
    const iamTypes = [...new Set(Object.values(resources).map((r) => r.Type))]
      .filter((t) => t.startsWith('AWS::IAM::'))
      .sort();
    expect(iamTypes).toEqual(['AWS::IAM::Policy', 'AWS::IAM::Role']);
  });

  it('no role carries ManagedPolicyArns (AWS-managed or external) or inline Policies', () => {
    for (const [id, role] of byType('AWS::IAM::Role')) {
      expect(role.Properties.ManagedPolicyArns, `${id} ManagedPolicyArns`).toBeUndefined();
      expect(role.Properties.Policies, `${id} inline Policies`).toBeUndefined();
    }
  });

  it('validation and broker roles have exactly the reviewed property set', () => {
    for (const roleName of [VALIDATION_ROLE, BROKER_ROLE]) {
      const props = resources[roleLogicalId(roleName)]!.Properties;
      expect(Object.keys(props).sort(), roleName).toEqual(
        ['AssumeRolePolicyDocument', 'Description', 'RoleName', 'Tags'].sort(),
      );
    }
  });

  it('no statement anywhere uses NotAction / NotResource / NotPrincipal or a wildcard action', () => {
    const statements = allIdentityStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      const text = JSON.stringify(statement);
      expect(statement.NotAction, text).toBeUndefined();
      expect(statement.NotResource, text).toBeUndefined();
      expect(statement.NotPrincipal, text).toBeUndefined();
      expect(statement.Action, text).toBeDefined();
      for (const action of actionsOf(statement)) {
        expect(action === '*' || /^[a-z0-9-]+:\*$/.test(action), `wildcard action in ${text}`).toBe(
          false,
        );
      }
    }
  });
});

describe('dev deploy broker invariants: build environment allowlist', () => {
  it('validation project declares exactly the reviewed environment variable names', () => {
    expect(projectEnvNames(VALIDATION_PROJECT)).toEqual(
      [
        'OR_APP_SECRETS_NAME',
        'OR_BROKER_TARGET_ACCOUNT',
        'OR_BROKER_TARGET_REGION',
        'OR_PROVIDER_SECRET_BACKEND',
        'OR_PUBLIC_ORIGIN_OVERRIDE',
      ].sort(),
    );
  });

  it('broker project declares exactly the reviewed environment variable names (no NODE_OPTIONS etc.)', () => {
    expect(projectEnvNames(BROKER_PROJECT)).toEqual(
      [
        'OR_BROKER_TARGET_ACCOUNT',
        'OR_LEDGER_MODULE_BUCKET',
        'OR_LEDGER_MODULE_KEY',
        'OR_LEDGER_MODULE_SHA256',
        'OR_LEDGER_RUNNER_BUCKET',
        'OR_LEDGER_RUNNER_KEY',
        'OR_LEDGER_RUNNER_SHA256',
        'OR_PIPELINE_ARTIFACT_BUCKET',
        'OR_SPARSE_LEDGER_ID',
        'OR_SPARSE_LEDGER_TABLE',
        'OR_PROVENANCE_MODULE_BUCKET',
        'OR_PROVENANCE_MODULE_KEY',
        'OR_PROVENANCE_MODULE_SHA256',
        'OR_TRUSTED_POLICY_BUCKET',
        'OR_TRUSTED_POLICY_KEY',
        'OR_TRUSTED_POLICY_SHA256',
        'OR_TARGET_STACKS_MODULE_BUCKET',
        'OR_TARGET_STACKS_MODULE_KEY',
        'OR_TARGET_STACKS_MODULE_SHA256',
        'OR_ACCESS_RESTRICTION_MODULE_BUCKET',
        'OR_ACCESS_RESTRICTION_MODULE_KEY',
        'OR_ACCESS_RESTRICTION_MODULE_SHA256',
        'OR_BROKER_TARGET_REGION',
      ].sort(),
    );
  });

  it('buildspecs carry no env / proxy / reports / batch sections that could inject variables', () => {
    expect(Object.keys(buildSpec(VALIDATION_PROJECT)).sort()).toEqual(
      ['artifacts', 'phases', 'version'].sort(),
    );
    expect(Object.keys(buildSpec(BROKER_PROJECT)).sort()).toEqual(['phases', 'version'].sort());
  });
});

/**
 * Commands of a buildspec in execution order: phases in CodeBuild's order, each phase's `finally`
 * right after its commands (a `finally` runs before the next phase starts).
 */
const PHASE_ORDER = ['install', 'pre_build', 'build', 'post_build'] as const;
const orderedCommands = (name: string): string[] => {
  const phases = buildSpec(name).phases as Record<string, { commands?: string[]; finally?: string[] } | undefined>;
  return PHASE_ORDER.flatMap((p) => [...(phases[p]?.commands ?? []), ...(phases[p]?.finally ?? [])]);
};
const runsNode = (command: string): boolean => /(^|[\s;&|(])(npm|npx|node)(\s|$)/.test(command);
const HEAP_COMMAND = /^export NODE_OPTIONS=--max-old-space-size=([1-9][0-9]*)$/;
const touchesHeap = (c: string): boolean => c.includes('NODE_OPTIONS') || c.includes('max-old-space-size');

const computeOf = (computeType: unknown) => CODEBUILD_LINUX_COMPUTE.find((c) => c.type === computeType);
const runFor = (c: (typeof CODEBUILD_LINUX_COMPUTE)[number]) => VALIDATION_MEASURED_RUNS.find((r) => r.vcpus === c.vcpus);
/**
 * Does the measured build fit the compute type with `heapMiB` per Node process, within the project
 * timeout? Only a replay on the same number of vCPUs counts (more vCPUs mean more test workers, so a
 * smaller machine's measurement does not carry over; no measurement = not known to fit):
 * - memory: its anon peak, plus the extra heap if the configured heap is larger than the measured
 *   one, plus the OS reserve;
 * - time: no test exceeded its own timeout, and the build phase used at most half of the project
 *   timeout (npm ci, aws:local:test and provisioning are not in the replay).
 */
const fits = (c: (typeof CODEBUILD_LINUX_COMPUTE)[number], heapMiB: number, timeoutMinutes: number): boolean => {
  const run = runFor(c);
  if (!run) return false;
  const memory = run.anonPeakMiB + Math.max(0, heapMiB - run.heapMiB) + VALIDATION_OS_RESERVE_MIB <= c.memoryGiB * 1024;
  const time = run.testTimeoutsExceeded === 0 && run.buildPhaseSeconds <= (timeoutMinutes * 60) / 2;
  return memory && time;
};
const validationTimeout = (): number => project(VALIDATION_PROJECT).TimeoutInMinutes as number;

/** The single heap the Validation buildspec gives Node (and where), asserting there is exactly one. */
const validationHeap = (): { heapMiB: number; index: number } => {
  const mentions = orderedCommands(VALIDATION_PROJECT)
    .map((c, i) => [c, i] as const)
    .filter(([c]) => touchesHeap(c));
  // allCommands also covers phases outside PHASE_ORDER: nothing anywhere may touch the heap twice.
  expect(allCommands(VALIDATION_PROJECT).filter(touchesHeap), 'exactly one command may touch NODE_OPTIONS / the heap').toHaveLength(1);
  expect(mentions).toHaveLength(1);
  const [command, index] = mentions[0]!;
  const m = HEAP_COMMAND.exec(command);
  expect(m, `${command} must only set --max-old-space-size (no other Node flags)`).not.toBeNull();
  return { heapMiB: Number(m![1]), index };
};

describe('dev deploy broker invariants: validation build memory (7.5 OOM, 2026-10-06)', () => {
  it('the measurements are self-consistent (guards the inputs of the checks below)', () => {
    // Node's default heap on a 3 GiB machine (1584 MiB, measured; what SMALL behaved like in 7.5) is
    // below the requirement: that is the failure being fixed. If this stops holding, re-measure.
    expect(VALIDATION_MIN_HEAP_MIB).toBeGreaterThan(1584);
    for (const run of VALIDATION_MEASURED_RUNS) {
      // A replay that ran with less heap than the minimum could not have passed: a typo, not data.
      expect(run.heapMiB).toBeGreaterThanOrEqual(VALIDATION_MIN_HEAP_MIB);
      expect(run.anonPeakMiB).toBeGreaterThan(0);
      expect(run.buildPhaseSeconds).toBeGreaterThan(0);
    }
    const memories = CODEBUILD_LINUX_COMPUTE.map((c) => c.memoryGiB);
    expect([...memories].sort((x, y) => x - y)).toEqual(memories);
  });

  it('the chosen compute type and every cheaper one were measured ("cheapest" is backed by data)', () => {
    const chosen = CODEBUILD_LINUX_COMPUTE.findIndex((c) => c.type === (project(VALIDATION_PROJECT).Environment as Json).ComputeType);
    expect(chosen, 'known compute type').toBeGreaterThanOrEqual(0);
    for (const c of CODEBUILD_LINUX_COMPUTE.slice(0, chosen + 1)) {
      expect(runFor(c), `no replay measured on ${c.vcpus} vCPUs (${c.type})`).toBeDefined();
    }
  });

  it('sets the heap once, before the first npm / node command, and nothing unsets it afterwards', () => {
    const { index } = validationHeap();
    const firstNode = orderedCommands(VALIDATION_PROJECT).findIndex(runsNode);
    expect(firstNode, 'the validation buildspec runs npm').toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(firstNode);
  });

  it('the heap covers the measured minimum with head-room', () => {
    const { heapMiB } = validationHeap();
    expect(heapMiB).toBeGreaterThanOrEqual(Math.ceil(VALIDATION_MIN_HEAP_MIB * VALIDATION_HEAP_HEADROOM));
  });

  it('the heap is at most half of the machine memory (the rest of the measured tree needs the other half)', () => {
    const c = computeOf((project(VALIDATION_PROJECT).Environment as Json).ComputeType);
    expect(c, 'known compute type').toBeDefined();
    expect(validationHeap().heapMiB).toBeLessThanOrEqual((c!.memoryGiB * 1024) / 2);
  });

  it('the compute type fits the measured build: memory with that heap, and time within the project timeout', () => {
    const c = computeOf((project(VALIDATION_PROJECT).Environment as Json).ComputeType);
    expect(c, 'known compute type').toBeDefined();
    expect(fits(c!, validationHeap().heapMiB, validationTimeout())).toBe(true);
  });

  it('the compute type is the cheapest one that fits (cost: no over-provisioning)', () => {
    const { heapMiB } = validationHeap();
    const cheapest = CODEBUILD_LINUX_COMPUTE.find((c) => fits(c, heapMiB, validationTimeout()));
    expect(cheapest, 'some listed compute type must fit').toBeDefined();
    expect((project(VALIDATION_PROJECT).Environment as Json).ComputeType).toBe(cheapest!.type);
  });

  it('NODE_OPTIONS reaches the build only through that buildspec command (not project / action env)', () => {
    expect(projectEnvNames(VALIDATION_PROJECT)).not.toContain('NODE_OPTIONS');
    const actionEnv = JSON.stringify(pipelineResource().Properties.Stages ?? []);
    expect(actionEnv).not.toContain('NODE_OPTIONS');
  });

  it('the trusted broker build is untouched: no NODE_OPTIONS / heap flags, still SMALL', () => {
    for (const c of allCommands(BROKER_PROJECT)) {
      expect(c.includes('NODE_OPTIONS') || c.includes('max-old-space-size'), c).toBe(false);
    }
    expect(projectEnvNames(BROKER_PROJECT)).not.toContain('NODE_OPTIONS');
    expect((project(BROKER_PROJECT).Environment as Json).ComputeType).toBe('BUILD_GENERAL1_SMALL');
  });
});

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
      /^test -f \/tmp\/open-reception-broker-work\/validated\/[A-Za-z0-9_./-]+\.json$/,
      /^mkdir -m 700 \/tmp\/open-reception-broker-out$/,
      /^node -e '[^']*'$/,
      /^aws s3 cp "s3:\/\/\$OR_TRUSTED_POLICY_BUCKET\/\$OR_TRUSTED_POLICY_KEY" \/tmp\/open-reception-trusted-policy\.mjs --only-show-errors$/,
      /^node -e '[^']*' \/tmp\/open-reception-trusted-policy\.mjs$/,
      /^node -e '[^']*'( \/tmp\/open-reception-broker-(work\/validated|out)\/[A-Za-z0-9_.-]+\.json)+$/,
      /^mkdir -p \/tmp\/open-reception-ledger$/,
      /^aws s3 cp "s3:\/\/\$OR_LEDGER_(MODULE|RUNNER)_BUCKET\/\$OR_LEDGER_\1_KEY" \/tmp\/open-reception-ledger\/(sparse-ledger|ledger-runner)\.mjs --only-show-errors$/,
      /^node -e '[^']*' \/tmp\/open-reception-ledger\/(sparse-ledger|ledger-runner)\.mjs OR_LEDGER_(MODULE|RUNNER)_SHA256$/,
      /^echo (BROKER_MODULE_INTEGRITY|TRUSTED_PROVENANCE_DENIED|TRUSTED_REVISION_MISMATCH|TRUSTED_POLICY_DENIED|TARGET_STACK_NOT_STABLE|ACCESS_RESTRICTION_DENIED|BROKER_NOT_ARMED) > \/tmp\/open-reception-ledger\/gate$/,
      /^aws s3 cp "s3:\/\/\$OR_TARGET_STACKS_MODULE_BUCKET\/\$OR_TARGET_STACKS_MODULE_KEY" \/tmp\/open-reception-target-stacks\.mjs --only-show-errors$/,
      /^node -e '[^']*' \/tmp\/open-reception-target-stacks\.mjs OR_TARGET_STACKS_MODULE_SHA256$/,
      new RegExp(`^${TARGET_STACKS_COMMAND.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`),
      /^aws s3 cp "s3:\/\/\$OR_ACCESS_RESTRICTION_MODULE_BUCKET\/\$OR_ACCESS_RESTRICTION_MODULE_KEY" \/tmp\/open-reception-access-restriction\.mjs --only-show-errors$/,
      /^node -e '[^']*' \/tmp\/open-reception-access-restriction\.mjs OR_ACCESS_RESTRICTION_MODULE_SHA256$/,
      /^node \/tmp\/open-reception-access-restriction\.mjs --assembly \/tmp\/open-reception-broker-work\/validated\/infra\/cdk\.out$/,
      new RegExp(`^${LEDGER_DENY_COMMAND.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`),
      /^node \/tmp\/open-reception-trusted-policy\.mjs --assembly \/tmp\/open-reception-broker-work\/validated\/infra\/cdk\.out --account 822063948773 > \/tmp\/open-reception-broker-out\/trusted-policy-result\.json$/,
      /^aws s3 cp "s3:\/\/\$OR_PROVENANCE_MODULE_BUCKET\/\$OR_PROVENANCE_MODULE_KEY" \/tmp\/open-reception-run-provenance\.mjs --only-show-errors$/,
      /^node -e '[^']*' \/tmp\/open-reception-run-provenance\.mjs OR_PROVENANCE_MODULE_SHA256$/,
      new RegExp(`^${PROVENANCE_COMMAND.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`),

      /^echo "[^"$`]*" >&2$/,
      /^exit 42$/,
    ];
    for (const command of commands) {
      expect(
        allowedShapes.some((shape) => shape.test(command)),
        `unexpected broker command: ${command}`,
      ).toBe(true);
      if (command.startsWith("node -e '")) {
        // Inline JS may only use the fs/crypto builtins: no child processes, dynamic imports or eval.
        const requires = [...command.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]);
        expect(
          requires.every((r) => r === '"fs"' || r === '"crypto"'),
          `requires: ${requires.join(',')}`,
        ).toBe(true);
        expect(command).not.toMatch(/child_process|\bimport\(|\beval\(|new Function|\bspawn\w*\(|\bexec\w*\(/);
      } else {
        expect(command).not.toMatch(/(^|[\s;&|(])(npm|npx|yarn|pnpm|bash|sh|source|make|cdk)(\s|$)/);
      }
      expect(command).not.toMatch(/(^|\s)\.\//);
      expect(command).not.toContain('scripts/');
      expect(command).not.toContain('require("./');
      expect(command).not.toMatch(/\bimport\(/);
    }
    expect(buildSpec(BROKER_PROJECT).phases.build!.commands.at(-1)).toBe('exit 42');
  });

  it('holds no sts:AssumeRole or mutation authority; no role in the stack can reach a deploy role', () => {
    // The sparse ledger statement is the one reviewed exception to the dynamodb: ban; its exact
    // shape is pinned in the "sparse deploy ledger" block below.
    // The provenance reads (blockers 2 / 4) are the other reviewed exception; their exact shape is
    // pinned in the "execution provenance" block below. The S10a DescribeStacks read is the third
    // (pinned in the "target-stack stability" block below).
    const broker = statementsFor(roleLogicalId(BROKER_ROLE))
      .filter((s) => s.Effect === 'Allow' && !isLedgerStatement(s) && !isProvenanceStatement(s) && !isTargetStackStatement(s))
      .flatMap(actionsOf);
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

  it('pins the real content SHA-256 of the trusted policy file (not the CDK asset fingerprint)', () => {
    const vars = Object.fromEntries(
      ((project(BROKER_PROJECT).Environment as Json).EnvironmentVariables as Array<{
        Name: string;
        Value: unknown;
      }>).map((v) => [v.Name, v.Value]),
    );
    const contentSha256 = createHash('sha256')
      .update(readFileSync(resolve(__dirname, '../broker/trusted-policy.mjs')))
      .digest('hex');
    expect(TRUSTED_POLICY_SOURCE_PATH).toBe(resolve(__dirname, '../broker/trusted-policy.mjs'));
    expect(trustedPolicySha256()).toBe(contentSha256);
    expect(vars.OR_TRUSTED_POLICY_SHA256).toBe(contentSha256);
    expect(vars.OR_TRUSTED_POLICY_KEY).toMatch(/^[0-9a-f]{64}\.mjs$/);
    // The trusted revision is NOT a project-level default; only the pipeline action injects it.
    expect(vars.OR_TRUSTED_SOURCE_REVISION).toBeUndefined();
  });

  it('verifies the downloaded policy hash immediately after download and before executing it', () => {
    const commands = allCommands(BROKER_PROJECT);
    const download = commands.findIndex((c) => c.startsWith('aws s3 cp "s3://$OR_TRUSTED_POLICY_BUCKET'));
    const verify = commands.indexOf(nodeEval(BROKER_POLICY_HASH_CHECK_SCRIPT, TRUSTED_POLICY_LOCAL_PATH));
    const execute = commands.findIndex((c) => c.startsWith(`node ${TRUSTED_POLICY_LOCAL_PATH} `));
    expect(download).toBeGreaterThanOrEqual(0);
    expect(verify).toBe(download + 1);
    // Only the gate marker sits between verification and execution.
    expect(commands[verify + 1]).toBe(gateCommand('TRUSTED_POLICY_DENIED'));
    expect(execute).toBe(verify + 2);
    // Exactly one download and one execution of the policy file.
    expect(commands.filter((c) => c.includes(TRUSTED_POLICY_LOCAL_PATH))).toHaveLength(3);
  });
});

describe('sparse deploy ledger (#1153, Foundation S6a): broker-only, least privilege', () => {
  it('is one PAY_PER_REQUEST table with PK/SK, deletion protection, PITR and no fixed name', () => {
    expect(LEDGER_TABLES).toHaveLength(1);
    const table = resources[LEDGER_TABLES[0]!]!;
    expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
    expect(table.Properties.KeySchema).toEqual([
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ]);
    expect(table.Properties.DeletionProtectionEnabled).toBe(true);
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(table.Properties.TableName).toBeUndefined();
    // No stream: every ledger ARN then has exactly five colons, which the trusted policy's
    // segment-wise ledger-reach check relies on.
    expect(table.Properties.StreamSpecification).toBeUndefined();
    expect(table.Properties.KinesisStreamSpecification).toBeUndefined();
    expect((table as unknown as { DeletionPolicy?: string }).DeletionPolicy).toBe('Retain');
  });

  it('the broker holds exactly one ledger statement: Get/Put/Update on the table, own partition only', () => {
    const onLedger = statementsFor(roleLogicalId(BROKER_ROLE)).filter(refersToLedger);
    expect(onLedger).toHaveLength(1);
    expect(isLedgerStatement(onLedger[0]!)).toBe(true);
    expect(actionsOf(onLedger[0]!).sort()).toEqual(['dynamodb:getitem', 'dynamodb:putitem', 'dynamodb:updateitem']);
  });

  it('the broker has no other dynamodb authority (no Delete / Scan / Query / Batch / table management)', () => {
    const other = statementsFor(roleLogicalId(BROKER_ROLE))
      .filter((s) => !isLedgerStatement(s))
      .flatMap(actionsOf)
      .filter((a) => a.startsWith('dynamodb:'));
    expect(other).toEqual([]);
  });

  it('no identity statement outside the broker role touches the ledger or any dynamodb action', () => {
    const brokerStatements = new Set(statementsFor(roleLogicalId(BROKER_ROLE)));
    for (const statement of allIdentityStatements()) {
      if (brokerStatements.has(statement)) continue;
      expect(refersToLedger(statement), JSON.stringify(statement)).toBe(false);
      expect(actionsOf(statement).some((a) => a.startsWith('dynamodb:')), JSON.stringify(statement)).toBe(false);
    }
    // Candidate code runs as the validation role: explicitly nothing on the ledger.
    expect(statementsFor(roleLogicalId(VALIDATION_ROLE)).some(refersToLedger)).toBe(false);
    expect(allowedActions(VALIDATION_ROLE).some((a) => a.startsWith('dynamodb:'))).toBe(false);
  });

  // DynamoDB rejects the whole table when its resource policy names an action it does not accept
  // there (2026-10-06: `RestoreTableFromBackup` failed the first create). The emulators do not
  // check this, so every action of every table / stream policy must be on the documented list.
  it('every action in a DynamoDB resource policy is one DynamoDB accepts there (allowlist, not a hand-written set)', () => {
    const allowed = new Set(DYNAMODB_TABLE_RESOURCE_POLICY_ACTIONS.map((a) => a.toLowerCase()));
    const policies = byType('AWS::DynamoDB::Table').flatMap(([id, r]) => {
      const stream = r.Properties.StreamSpecification as { ResourcePolicy?: unknown } | undefined;
      return [
        [id, r.Properties.ResourcePolicy],
        [`${id}/stream`, stream?.ResourcePolicy],
      ].filter(([, p]) => p !== undefined) as Array<[string, { PolicyDocument: unknown }]>;
    });
    // Lower bound: the ledger policy is really inspected (an empty scan would pass vacuously).
    expect(policies.map(([id]) => id)).toEqual(LEDGER_TABLES);
    for (const [id, policy] of policies) {
      const statements = documentStatements(policy.PolicyDocument);
      expect(statements.length, id).toBeGreaterThan(0);
      for (const statement of statements) {
        // NotAction would expand to actions DynamoDB may reject; only explicit names are checkable.
        expect(statement.NotAction, id).toBeUndefined();
        const actions = actionsOf(statement);
        expect(actions.length, id).toBeGreaterThan(0);
        expect(actions.filter((a) => !allowed.has(a)), `${id} ${statement.Effect}`).toEqual([]);
      }
    }
  });

  it('the allowlist excludes every action AWS was observed to reject in a table policy', () => {
    const allowed = DYNAMODB_TABLE_RESOURCE_POLICY_ACTIONS.map((a) => a.toLowerCase());
    for (const rejected of DYNAMODB_TABLE_RESOURCE_POLICY_REJECTED) {
      expect(allowed).not.toContain(rejected.toLowerCase());
    }
  });

  it('the table resource policy denies every write except from the broker role and the human issuer role', () => {
    const table = resources[LEDGER_TABLES[0]!]!;
    const doc = (table.Properties.ResourcePolicy as { PolicyDocument: unknown }).PolicyDocument;
    const statements = documentStatements(doc);
    // Only Deny statements: the resource policy must never grant anything by itself.
    expect(statements.map((st) => st.Effect)).toEqual(['Deny', 'Deny']);
    const [deny, control] = statements;
    expect(control!.Principal).toEqual({ AWS: '*' });
    expect(actionsOf(control!).sort()).toEqual(
      [
        'dynamodb:updatetimetolive',
        'dynamodb:putresourcepolicy',
        'dynamodb:deleteresourcepolicy',
        'dynamodb:updatetable',
        'dynamodb:deletetable',
        'dynamodb:updatecontinuousbackups',
        'dynamodb:restoretabletopointintime',
        'dynamodb:updatekinesisstreamingdestination',
        'dynamodb:enablekinesisstreamingdestination',
        'dynamodb:disablekinesisstreamingdestination',
      ].sort(),
    );
    // The broker never manages the table.
    expect(control!.Condition).toEqual({
      ArnNotEquals: {
        'aws:PrincipalArn': [
          { Ref: 'SparseLedgerOverrideIssuerRoleArn' },
          { Ref: 'SparseLedgerStackDeployRoleArn' },
        ],
      },
    });
    expect(deny!.Principal).toEqual({ AWS: '*' });
    expect(actionsOf(deny!).sort()).toEqual(
      [
        'dynamodb:putitem',
        'dynamodb:updateitem',
        'dynamodb:deleteitem',
        'dynamodb:batchwriteitem',
        'dynamodb:partiqlinsert',
        'dynamodb:partiqlupdate',
        'dynamodb:partiqldelete',
      ].sort(),
    );
    // Every action the broker may write with is covered by the deny's exception list.
    for (const a of SPARSE_LEDGER_BROKER_ACTIONS.filter((x) => x !== 'dynamodb:GetItem')) {
      expect(actionsOf(deny!)).toContain(a.toLowerCase());
    }
    expect(deny!.Condition).toEqual({
      ArnNotEquals: {
        'aws:PrincipalArn': [
          { 'Fn::GetAtt': [roleLogicalId(BROKER_ROLE), 'Arn'] },
          { Ref: 'SparseLedgerOverrideIssuerRoleArn' },
        ],
      },
    });
    expect(deny!.NotPrincipal).toBeUndefined();
  });

  it.each(['SparseLedgerOverrideIssuerRoleArn'])(
    '%s is a deploy-time IAM role ARN parameter without a default (never a stack-created role)',
    (name) => {
      const param = (template.toJSON().Parameters as Record<string, { Type: string; AllowedPattern?: string }>)[name];
      expect(param?.Type).toBe('String');
      expect(param).not.toHaveProperty('Default');
      // JS and Java agree on this subset (anchors, classes, negative lookahead).
      const re = new RegExp(param!.AllowedPattern!);
      for (const ok of [
        'arn:aws:iam::822063948773:role/cdk-hnb659fds-cfn-exec-role-822063948773-ap-northeast-1',
        'arn:aws:iam::822063948773:role/LedgerOverrideIssuer',
        'arn:aws:iam::822063948773:role/humans/LedgerOverrideIssuer',
      ]) {
        expect(re.test(ok), ok).toBe(true);
      }
      for (const bad of [
        'arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1',
        'arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev',
        'arn:aws:iam::822063948773:role/OpenReceptionClaudeEntry',
        'arn:aws:iam::822063948773:role/OpenReceptionTrustedDevDeployBrokerRole',
        'arn:aws:iam::822063948773:role/OpenReceptionDevDeployValidationRole',
        'arn:aws:iam::822063948773:role/OpenReception-Web-dev-ServerFnServiceRole282D3E61-ABC',
        'arn:aws:iam::822063948773:role/some/path/OpenReceptionClaudeDeploy-dev',
        'arn:aws:iam::822063948773:role/nodi-worker',
        'arn:aws:iam::822063948773:role/salon-loop-fn',
        'arn:aws:iam::822063948773:role/KiaffRuntime',
        'arn:aws:iam::822063948773:user/CDK',
        'arn:aws:iam::822063948773:role/x y',
      ]) {
        expect(re.test(bad), bad).toBe(false);
      }
    },
  );

  it('SparseLedgerStackDeployRoleArn only accepts the broker-only bootstrap\'s cfn-exec role (#1146 blocker 8)', () => {
    const param = (template.toJSON().Parameters as Record<string, { Type: string; AllowedPattern?: string }>)
      .SparseLedgerStackDeployRoleArn;
    expect(param?.Type).toBe('String');
    expect(param).not.toHaveProperty('Default');
    const re = new RegExp(param!.AllowedPattern!);
    for (const ok of [
      'arn:aws:iam::822063948773:role/cdk-orbrkr01-cfn-exec-role-822063948773-ap-northeast-1',
      'arn:aws:iam::822063948773:role/cdk-orbrkr01-cfn-exec-role-822063948773-us-east-1',
    ]) {
      expect(re.test(ok), ok).toBe(true);
    }
    for (const bad of [
      'arn:aws:iam::822063948773:role/cdk-hnb659fds-cfn-exec-role-822063948773-ap-northeast-1',
      'arn:aws:iam::822063948773:role/cdk-orcloud01-cfn-exec-role-822063948773-ap-northeast-1',
      'arn:aws:iam::822063948773:role/cdk-orbrkr01-deploy-role-822063948773-ap-northeast-1',
      'arn:aws:iam::822063948773:role/cdk-orbrkr01-cfn-exec-role-822063948773-ap-northeast-1-x/y',
      'arn:aws:iam::822063948773:role/path/cdk-orbrkr01-cfn-exec-role-822063948773-ap-northeast-1',
      'arn:aws:iam::822063948773:role/ledger-stack-deploy-human',
      'arn:aws:iam::822063948773:role/OpenReceptionClaudeDeploy-dev',
    ]) {
      expect(re.test(bad), bad).toBe(false);
    }
    // It is the role the synthesizer actually hands CloudFormation.
    const app = new cdk.App();
    new DevDeployBrokerStack(app, 'QualifiedBrokerExec', {
      stackName: 'OpenReception-DevDeployBroker',
      env: { account: '822063948773', region: 'ap-northeast-1' },
      synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: BROKER_BOOTSTRAP_QUALIFIER }),
    });
    const artifact = app.synth().getStackArtifact('QualifiedBrokerExec');
    const resolve1 = (v?: string) => (v ?? '').replace('${AWS::Partition}', 'aws');
    expect(re.test(resolve1(artifact.cloudFormationExecutionRoleArn)), artifact.cloudFormationExecutionRoleArn).toBe(true);
    for (const arn of [artifact.assumeRoleArn, artifact.cloudFormationExecutionRoleArn, artifact.lookupRole?.arn]) {
      expect(arn).toContain(`cdk-${BROKER_BOOTSTRAP_QUALIFIER}-`);
    }
    expect(artifact.stackTemplateAssetObjectUrl).toContain(`cdk-${BROKER_BOOTSTRAP_QUALIFIER}-assets-`);
  });

  it('the Claude boundary and CFN exec policies deny dynamodb:* on this stack\'s tables', () => {
    for (const name of [
      'claude-boundary.json',
      'claude-cfn-exec.json',
    ]) {
      const doc = JSON.parse(readFileSync(resolve(__dirname, '../../scripts/aws-policies', name), 'utf8'));
      // Folded into the existing foreign-data Deny: the boundary is close to IAM's 6,144-char
      // limit. IAM `*` also spans `/`, so streams / indexes / backups of the table are covered.
      const deny = documentStatements(doc).find(
        (st) => (st as { Sid?: string }).Sid === 'DenyForeignProjectData',
      );
      expect(deny, name).toBeDefined();
      expect(deny!.Effect).toBe('Deny');
      expect(actionsOf(deny!)).toContain('dynamodb:*');
      expect(deny!.Resource).toContain('arn:aws:dynamodb:*:*:table/OpenReception-DevDeployBroker-*');
      // The broker stack itself: otherwise a boundaried role with CloudFormation rights could
      // update it through the stack's previously used (human, admin) service role.
      const stacks = documentStatements(doc).find(
        (st) => (st as { Sid?: string }).Sid === 'DenyForeignProjectStacks',
      );
      expect(stacks?.Effect, name).toBe('Deny');
      expect(actionsOf(stacks!)).toEqual(['cloudformation:*']);
      expect(stacks!.Resource).toContain('arn:aws:cloudformation:*:*:stack/OpenReception-DevDeployBroker/*');
    }
    // The deny prefix is `<stackName>-*`, which is how CloudFormation names an unnamed table.
    const bin = readFileSync(resolve(__dirname, '../bin/dev-deploy-broker.ts'), 'utf8');
    expect(bin).toContain("stackName: 'OpenReception-DevDeployBroker'");
  });

  it('the broker app uses its own bootstrap, whose roles and buckets the Claude chain cannot reach (#1146 blocker 8)', () => {
    const bin = readFileSync(resolve(__dirname, '../bin/dev-deploy-broker.ts'), 'utf8');
    expect(bin).toContain('synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: BROKER_BOOTSTRAP_QUALIFIER })');
    expect(BROKER_BOOTSTRAP_QUALIFIER).toMatch(/^[a-z0-9]{1,10}$/);
    // Not Claude's own bootstrap, and not the shared one.
    expect(['orcloud01', 'hnb659fds']).not.toContain(BROKER_BOOTSTRAP_QUALIFIER);
    for (const name of ['claude-boundary.json', 'claude-cfn-exec.json']) {
      const doc = JSON.parse(readFileSync(resolve(__dirname, '../../scripts/aws-policies', name), 'utf8'));
      const sids = (sid: string) => documentStatements(doc).find((st) => (st as { Sid?: string }).Sid === sid)!;
      expect(sids('DenySharedBootstrapRoles').Resource, name).toContain(`arn:aws:iam::*:role/cdk-${BROKER_BOOTSTRAP_QUALIFIER}-*`);
      expect(sids('DenyForeignProjectData').Resource, name).toContain(`arn:aws:s3:::cdk-${BROKER_BOOTSTRAP_QUALIFIER}-*`);
      expect(sids('DenyForeignProjectData').Resource, name).toContain(
        `arn:aws:ssm:*:*:parameter/cdk-bootstrap/${BROKER_BOOTSTRAP_QUALIFIER}/*`,
      );
      expect(sids('DenyForeignProjectStacks').Resource, name).toContain('arn:aws:cloudformation:*:*:stack/CDKToolkit*/*');
    }
    // The chain's other two layers (the deploy role and the entry role) refuse those roles too.
    for (const [name, sid] of [
      ['claude-deploy-role-restriction.json', 'DenyPassingSharedExecRoles'],
      ['claude-deploy-entry.json', 'DenySharedBootstrapRoles'],
    ] as const) {
      const doc = JSON.parse(readFileSync(resolve(__dirname, '../../scripts/aws-policies', name), 'utf8'));
      const st = documentStatements(doc).find((s) => (s as { Sid?: string }).Sid === sid)!;
      expect(st.Effect, name).toBe('Deny');
      expect(st.Resource, name).toContain(`arn:aws:iam::822063948773:role/cdk-${BROKER_BOOTSTRAP_QUALIFIER}-*`);
    }
    // The synthesized template asks for that bootstrap (version parameter and deploy / exec roles).
    const app = new cdk.App();
    const stack = new DevDeployBrokerStack(app, 'QualifiedBroker', {
      stackName: 'OpenReception-DevDeployBroker',
      env: { account: '822063948773', region: 'ap-northeast-1' },
      synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: BROKER_BOOTSTRAP_QUALIFIER }),
    });
    const template = Template.fromStack(stack).toJSON() as { Parameters: Record<string, { Default?: string }> };
    expect(template.Parameters.BootstrapVersion?.Default).toBe(`/cdk-bootstrap/${BROKER_BOOTSTRAP_QUALIFIER}/version`);
  });

  it('the broker runs the ledger only from sha256-verified stack assets, and does not reserve while unarmed', () => {
    const commands = allCommands(BROKER_PROJECT);
    const ledgerUses = commands.filter((c) => c.includes('ledger-runner') || c.includes('sparse-ledger'));
    // Downloads + verifications in the build phase, one verified deny in finally; nothing else.
    expect(ledgerUses).toEqual([
      `aws s3 cp "s3://$OR_LEDGER_MODULE_BUCKET/$OR_LEDGER_MODULE_KEY" ${LEDGER_MODULE_LOCAL_PATH} --only-show-errors`,
      nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, LEDGER_MODULE_LOCAL_PATH, 'OR_LEDGER_MODULE_SHA256'),
      `aws s3 cp "s3://$OR_LEDGER_RUNNER_BUCKET/$OR_LEDGER_RUNNER_KEY" ${LEDGER_RUNNER_LOCAL_PATH} --only-show-errors`,
      nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, LEDGER_RUNNER_LOCAL_PATH, 'OR_LEDGER_RUNNER_SHA256'),
      LEDGER_DENY_COMMAND,
    ]);
    expect(commands.some((c) => / reserve\b| outcome\b/.test(c))).toBe(false);
    expect(buildSpec(BROKER_PROJECT).phases.build).toHaveProperty('finally', [LEDGER_DENY_COMMAND]);
    // The ledger files are verified before the first gate, i.e. before any denial can happen.
    expect(commands.indexOf(nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, LEDGER_RUNNER_LOCAL_PATH, 'OR_LEDGER_RUNNER_SHA256'))).toBeLessThan(
      commands.indexOf(gateCommand('TRUSTED_PROVENANCE_DENIED')),
    );
  });

  it('the stack pins the same partition key the ledger module writes', async () => {
    const ledger = (await import(
      pathToFileURL(resolve(__dirname, '../broker/sparse-ledger.mjs')).href
    )) as { PROJECT_KEY: string };
    expect(ledger.PROJECT_KEY).toBe(SPARSE_LEDGER_PROJECT_KEY);
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
      const expected = [{ name: 'OR_TRUSTED_SOURCE_REVISION', type: 'PLAINTEXT', value: TRUSTED_COMMIT_ID }];
      if (action.Name === 'TrustedBrokerUnarmed') {
        // CodePipeline's own execution id (never candidate-controlled), for the provenance check.
        expected.unshift({ name: 'OR_PIPELINE_EXECUTION_ID', type: 'PLAINTEXT', value: '#{codepipeline.PipelineExecutionId}' });
      }
      expect(vars).toEqual(expected);
    }
    for (const name of [VALIDATION_PROJECT, BROKER_PROJECT]) {
      const text = buildSpecText(name);
      expect(text).not.toContain('CODEBUILD_RESOLVED_SOURCE_VERSION');
    }
    // The broker never reads git metadata.
    expect(buildSpecText(BROKER_PROJECT)).not.toContain('rev-parse');
    expect(buildSpecText(BROKER_PROJECT)).not.toMatch(/\bgit\b/);
    // Validation runs git in exactly one command (7.5, 2026-10-08: the unit lane needs the history),
    // and that command only checks the checkout against the trusted revision: it takes the revision
    // from OR_TRUSTED_SOURCE_REVISION alone and writes no file, so the evidence (VALIDATION_EVIDENCE_SCRIPT)
    // still carries CodePipeline's CommitId, never one read from git.
    const bindCommand = nodeEval(VALIDATION_SOURCE_BIND_SCRIPT);
    const validationCommands = allCommands(VALIDATION_PROJECT);
    expect(validationCommands.filter((c) => c === bindCommand)).toHaveLength(1);
    const others = JSON.stringify(validationCommands.filter((c) => c !== bindCommand));
    expect(others).not.toContain('rev-parse');
    expect(others).not.toMatch(/\bgit\b/);
    expect(VALIDATION_SOURCE_BIND_SCRIPT.match(/\bsha=/g)).toEqual(['sha=']);
    expect(VALIDATION_SOURCE_BIND_SCRIPT).toContain('const sha=process.env.OR_TRUSTED_SOURCE_REVISION;');
    expect(VALIDATION_SOURCE_BIND_SCRIPT).not.toMatch(/writeFile|appendFile|createWriteStream|console\.|process\.stdout/);
  });

  it('the synthesized commands are exactly the exported, tested scripts', () => {
    expect(allCommands(VALIDATION_PROJECT)).toContain(nodeEval(VALIDATION_EVIDENCE_SCRIPT));
    expect(allCommands(BROKER_PROJECT)).toContain(nodeEval(BROKER_REVISION_CHECK_SCRIPT, BROKER_EVIDENCE_PATH));
    expect(allCommands(BROKER_PROJECT)).toContain(nodeEval(BROKER_NOT_ARMED_RESULT_SCRIPT, POLICY_RESULT_PATH, BROKER_RESULT_PATH));
    expect(allCommands(BROKER_PROJECT)).toContain(nodeEval(PROVENANCE_RESULT_CHECK_SCRIPT, PROVENANCE_DECISION_PATH));
    expect(allCommands(BROKER_PROJECT)).toContain(
      nodeEval(BROKER_POLICY_HASH_CHECK_SCRIPT, TRUSTED_POLICY_LOCAL_PATH),
    );
  });

  it('nodeEval refuses snippets that would break shell single quoting', () => {
    expect(() => nodeEval("console.log('x')")).toThrow();
    expect(() => nodeEval('1', '$(id)')).toThrow();
    expect(() => nodeEval('1', 'a b')).toThrow();
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

/**
 * Run a broker command in a scratch workspace: its broker-owned absolute paths (the materialized
 * artifact and the output dir) are mapped to the workspace, so the exact synthesized text runs.
 */
const localize = (command: string): string =>
  command.split(`${BROKER_VALIDATED_DIR}/`).join('./').split(`${BROKER_OUT_DIR}/`).join('./');
const revisionCheck = () => localize(commandContaining(BROKER_PROJECT, 'validation evidence revision mismatch'));
const notArmed = () => localize(commandContaining(BROKER_PROJECT, 'rule:"BROKER_NOT_ARMED"'));
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
    OR_TRUSTED_POLICY_SHA256: HASH,
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
    ['missing policy sha256', baseEnv({ OR_TRUSTED_POLICY_SHA256: undefined })],
    ['malformed policy sha256', baseEnv({ OR_TRUSTED_POLICY_SHA256: 'abc' })],
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

describe('trusted policy hash pin (shared bootstrap asset bucket substitution)', () => {
  const pinnedSha256 = trustedPolicySha256();
  const hashCheckCommand = () => commandContaining(BROKER_PROJECT, 'trusted policy sha256 mismatch');
  /** Run the exact synthesized check, pointing only its path argument at a scratch copy. */
  const check = (file: string, env: Record<string, string | undefined>) => {
    const command = hashCheckCommand();
    expect(command.endsWith(` ${TRUSTED_POLICY_LOCAL_PATH}`)).toBe(true);
    const scratch = command.slice(0, -TRUSTED_POLICY_LOCAL_PATH.length) + file;
    return run(scratch, dirname(file), env);
  };
  const copyOfPolicy = (mutate: (text: string) => string = (t) => t): string => {
    const dir = workspace();
    const file = join(dir, 'open-reception-trusted-policy.mjs');
    writeFileSync(file, mutate(readFileSync(TRUSTED_POLICY_SOURCE_PATH, 'utf8')));
    return file;
  };

  it('accepts the untouched policy file', () => {
    const r = check(copyOfPolicy(), { OR_TRUSTED_POLICY_SHA256: pinnedSha256 });
    expect(r.ok, r.stderr).toBe(true);
  });

  it.each([
    ['appended statement', (t: string) => `${t}\nprocess.exit(0);\n`],
    ['single byte flip', (t: string) => t.replace('allowed', 'allowes')],
    ['trailing newline removed', (t: string) => t.replace(/\n$/, '')],
    ['empty file', () => ''],
  ])('fails closed on a tampered policy (%s)', (_label, mutate) => {
    const file = copyOfPolicy(mutate);
    expect(readFileSync(file, 'utf8')).not.toBe(readFileSync(TRUSTED_POLICY_SOURCE_PATH, 'utf8'));
    const r = check(file, { OR_TRUSTED_POLICY_SHA256: pinnedSha256 });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('trusted policy sha256 mismatch');
  });

  it.each([
    ['missing pin', undefined],
    ['empty pin', ''],
    ['uppercase pin', pinnedSha256.toUpperCase()],
    ['short pin', pinnedSha256.slice(0, 63)],
  ])('fails closed on %s', (_label, pin) => {
    const r = check(copyOfPolicy(), { OR_TRUSTED_POLICY_SHA256: pin });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('trusted policy sha256 pin missing or invalid');
  });

  it('fails closed when the downloaded file is missing', () => {
    const dir = workspace();
    expect(check(join(dir, 'absent.mjs'), { OR_TRUSTED_POLICY_SHA256: pinnedSha256 }).ok).toBe(false);
  });

  it('a verification failure stops the broker before the policy runs or a result is written', () => {
    // CodeBuild buildspec 0.2 stops a phase at the first failing command; emulate with `set -e`
    // over the exact synthesized verify -> execute -> result sequence, with the path redirected.
    const commands = allCommands(BROKER_PROJECT);
    const start = commands.indexOf(nodeEval(BROKER_POLICY_HASH_CHECK_SCRIPT, TRUSTED_POLICY_LOCAL_PATH));
    const armedGate = commands.indexOf(gateCommand('BROKER_NOT_ARMED'));
    const sequence = [...commands.slice(start, start + 3), ...commands.slice(armedGate, armedGate + 2)];
    expect(sequence[1]).toBe(gateCommand('TRUSTED_POLICY_DENIED'));
    expect(sequence[3]).toBe(gateCommand('BROKER_NOT_ARMED'));
    expect(sequence[4]).toBe(nodeEval(BROKER_NOT_ARMED_RESULT_SCRIPT, POLICY_RESULT_PATH, BROKER_RESULT_PATH));
    const file = copyOfPolicy((t) => `${t}\n// tampered\n`);
    const dir = dirname(file);
    const script = ['set -e', ...sequence.map((c) => localize(c.split(TRUSTED_POLICY_LOCAL_PATH).join(file)))].join('\n');
    const r = run(script, dir, {
      OR_TRUSTED_POLICY_SHA256: pinnedSha256,
      OR_TRUSTED_SOURCE_REVISION: REV_A,
      CODEBUILD_BUILD_ID: 'p:attempt',
      OR_BROKER_TARGET_ACCOUNT: '123456789012',
    });
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir, 'trusted-policy-result.json'))).toBe(false);
    expect(existsSync(join(dir, 'broker-result.json'))).toBe(false);
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
      'Sparse deploy attempt ledger',
    ]) {
      expect(mermaid).toContain(node);
    }
  });
});

describe('deploy account pin (pre-arming blocker 3)', () => {
  const policiesDir = resolve(__dirname, '../../scripts/aws-policies');

  it('is the same account every ADR 0009 policy pins', () => {
    const files = readdirSync(policiesDir).filter((f) => f.endsWith('.json'));
    // The exact set, so a policy that disappears or appears unreviewed fails here (the migration
    // policies were retired by the owner decision of 2026-09-28).
    expect([...files].sort()).toEqual([
      'claude-boundary.json',
      'claude-cfn-exec.json',
      'claude-deploy-entry-trust.json',
      'claude-deploy-entry.json',
      'claude-deploy-role-restriction.json',
    ]);
    for (const file of files) {
      const accounts = new Set(readFileSync(join(policiesDir, file), 'utf8').match(/(?<![0-9])[0-9]{12}(?![0-9])/g) ?? []);
      expect([...accounts], file).toEqual([DEV_DEPLOY_TARGET_ACCOUNT]);
    }
  });

  it('both builds receive the pinned literal, never the stack-derived AWS::AccountId', () => {
    for (const name of [VALIDATION_PROJECT, BROKER_PROJECT]) {
      const project = Object.values(resources).find((r) => r.Type === 'AWS::CodeBuild::Project' && r.Properties.Name === name)!;
      const env = (project.Properties.Environment as { EnvironmentVariables: Array<{ Name: string; Value: unknown }> }).EnvironmentVariables;
      expect(env.find((e) => e.Name === 'OR_BROKER_TARGET_ACCOUNT')?.Value, name).toBe(DEV_DEPLOY_TARGET_ACCOUNT);
    }
  });

  it('carries no CloudFormation rule whose semantics are unverified (parameter-free AWS::AccountId assertion)', () => {
    // Only CDK's own bootstrap-version rule (which references its SSM parameter).
    expect(Object.keys(template.toJSON().Rules ?? {})).toEqual(['CheckBootstrapVersion']);
  });

  it('a concrete synth for another account fails before any template exists', () => {
    const app = new cdk.App();
    expect(() => new DevDeployBrokerStack(app, 'Other', { env: { account: '123456789012', region: 'ap-northeast-1' } })).toThrow(/822063948773/);
    // Environment-agnostic synth is allowed; the broker's first command refuses any other account.
    expect(() => new DevDeployBrokerStack(new cdk.App(), 'Agnostic')).not.toThrow();
  });

  it('the broker checks its own account first, before reading any candidate file', () => {
    const commands = allCommands(BROKER_PROJECT);
    expect(commands[0]).toBe(nodeEval(BROKER_ACCOUNT_PIN_CHECK_SCRIPT));
  });

  it.each([
    ['the pinned account', `arn:aws:codebuild:ap-northeast-1:${DEV_DEPLOY_TARGET_ACCOUNT}:build/OpenReceptionTrustedDevDeployBroker:x`, DEV_DEPLOY_TARGET_ACCOUNT, true],
    ['another account', 'arn:aws:codebuild:ap-northeast-1:123456789012:build/OpenReceptionTrustedDevDeployBroker:x', DEV_DEPLOY_TARGET_ACCOUNT, false],
    ['no build ARN', undefined, DEV_DEPLOY_TARGET_ACCOUNT, false],
    ['a malformed build ARN', `arn:aws:codebuild:ap-northeast-1:${DEV_DEPLOY_TARGET_ACCOUNT}:project/x`, DEV_DEPLOY_TARGET_ACCOUNT, false],
    ['an ARN with the account elsewhere', `arn:aws:codebuild:ap-northeast-1:123456789012:build/${DEV_DEPLOY_TARGET_ACCOUNT}`, DEV_DEPLOY_TARGET_ACCOUNT, false],
    // An environment override cannot move the pin: the literal in the buildspec decides.
    ['an overridden env pin matching another account', 'arn:aws:codebuild:ap-northeast-1:123456789012:build/OpenReceptionTrustedDevDeployBroker:x', '123456789012', false],
    ['no env pin at all', `arn:aws:codebuild:ap-northeast-1:${DEV_DEPLOY_TARGET_ACCOUNT}:build/x`, undefined, true],
  ])('the account check with %s', (_label, buildArn, envPin, ok) => {
    const r = run(nodeEval(BROKER_ACCOUNT_PIN_CHECK_SCRIPT), workspace(), { CODEBUILD_BUILD_ARN: buildArn, OR_BROKER_TARGET_ACCOUNT: envPin });
    expect(r.ok).toBe(ok);
  });

  it('the pin and the policy account are literals in the buildspec, not environment values', () => {
    expect(BROKER_ACCOUNT_PIN_CHECK_SCRIPT).toContain(`const pinned="${DEV_DEPLOY_TARGET_ACCOUNT}";`);
    expect(BROKER_ACCOUNT_PIN_CHECK_SCRIPT).not.toContain('process.env.OR_BROKER_TARGET_ACCOUNT');
    const policyRun = allCommands(BROKER_PROJECT).find((c) => c.startsWith('node /tmp/open-reception-trusted-policy.mjs '))!;
    expect(policyRun).toContain(`--account ${DEV_DEPLOY_TARGET_ACCOUNT} `);
    expect(policyRun).not.toContain('$OR_BROKER_TARGET_ACCOUNT');
  });
});

describe('artifact bucket lifecycle and physical names (pre-arming blockers 5 and 6)', () => {
  const [bucketId, bucket] = artifactBucketEntry();

  it('there is exactly one bucket and it is the pipeline artifact store', () => {
    // The artifact store and the ledger audit bucket (CloudTrail).
    expect(byType('AWS::S3::Bucket')).toHaveLength(2);
    const [, pipeline] = byType('AWS::CodePipeline::Pipeline')[0]!;
    expect((pipeline.Properties.ArtifactStore as Json).Location).toEqual({ Ref: bucketId });
  });

  it('expires candidate artifacts and incomplete uploads', () => {
    const rules = ((bucket.Properties.LifecycleConfiguration as Json).Rules as Json[]).filter((r) => r.Status === 'Enabled');
    expect(rules).toEqual([
      expect.objectContaining({
        ExpirationInDays: PIPELINE_ARTIFACT_RETENTION_DAYS,
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      }),
      expect.objectContaining({ ExpiredObjectDeleteMarker: true }),
    ]);
    // A rule scoped by prefix or tag would leave the rest of the bucket unbounded.
    expect(rules[0]).not.toHaveProperty('Prefix');
    expect(rules[0]).not.toHaveProperty('TagFilters');
    expect(rules[0]).not.toHaveProperty('Filter');
    expect(PIPELINE_ARTIFACT_RETENTION_DAYS).toBeGreaterThanOrEqual(1);
    expect(PIPELINE_ARTIFACT_RETENTION_DAYS).toBeLessThanOrEqual(30);
  });

  it('keeps the default pipeline bucket protections (no public access, TLS only, encrypted)', () => {
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(JSON.stringify(bucket.Properties.BucketEncryption)).toContain('AES256');
    const [, policy] = byType('AWS::S3::BucketPolicy').find(([, r]) => JSON.stringify(r.Properties.Bucket).includes(bucketId))!;
    const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    expect(statements.filter((st) => st.Effect === 'Allow')).toEqual([]);
    expect(statements).toContainEqual(
      expect.objectContaining({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
    );
  });

  it('no retained resource has a fixed physical name (delete + recreate cannot collide)', () => {
    const retained = Object.entries(resources).filter(
      ([, r]) => (r as unknown as { DeletionPolicy?: string }).DeletionPolicy === 'Retain',
    );
    expect(retained.map(([, r]) => r.Type).sort()).toEqual([
      'AWS::DynamoDB::Table',
      'AWS::Logs::LogGroup',
      'AWS::Logs::LogGroup',
      'AWS::S3::Bucket',
      'AWS::S3::Bucket',
      // The audit bucket's policy stays with the retained audit logs.
      'AWS::S3::BucketPolicy',
    ]);
    for (const [id, r] of retained) {
      const named = Object.keys(r.Properties ?? {}).filter((k) => /Name$/.test(k));
      expect(named, id).toEqual([]);
    }
  });
});

describe('execution provenance (pre-arming blockers 2 and 4)', () => {
  const [bucketId, bucket] = artifactBucketEntry();

  it('the artifact bucket keeps every version, and old versions still expire', () => {
    expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    const rule = ((bucket.Properties.LifecycleConfiguration as Json).Rules as Json[])[0]!;
    expect(rule.NoncurrentVersionExpiration).toEqual({ NoncurrentDays: PIPELINE_ARTIFACT_RETENTION_DAYS });
  });

  it('neither build role can delete a version, change versioning / lifecycle / policy, or replicate', () => {
    for (const roleName of [VALIDATION_ROLE, BROKER_ROLE]) {
      const denies = statementsFor(roleLogicalId(roleName)).filter((s) => s.Effect === 'Deny');
      const covering = denies.filter((s) => JSON.stringify(s.Resource).includes(bucketId));
      expect(covering, roleName).toHaveLength(1);
      expect(actionsOf(covering[0]!).sort()).toEqual(ARTIFACT_HISTORY_WRITES.map((a) => a.toLowerCase()).sort());
      expect(JSON.stringify(covering[0]!.Resource)).toContain('/*');
      expect(covering[0]!.Condition).toBeUndefined();
    }
  });

  it('the broker holds exactly the three reviewed read-only provenance statements; validation holds none', () => {
    expect(statementsFor(roleLogicalId(BROKER_ROLE)).filter(isProvenanceStatement)).toHaveLength(3);
    const validation = statementsFor(roleLogicalId(VALIDATION_ROLE)).filter((s) => s.Effect === 'Allow').flatMap(actionsOf);
    for (const a of [...PROVENANCE_READ_ACTIONS.pipeline, ...PROVENANCE_READ_ACTIONS.validationBuild, 's3:listbucketversions']) {
      expect(validation, a).not.toContain(a.toLowerCase());
    }
  });

  it('BatchGetBuilds is granted on exactly the validation and broker project ARNs (its own record, no wildcard)', () => {
    const projectId = (name: string) => PROJECTS.find(([, r]) => r.Properties.Name === name)?.[0];
    // IAM glob semantics: `codebuild:BatchGet*`, `codebuild:*Builds`, `*` all grant BatchGetBuilds.
    const grantsAction = (pattern: string, action: string) =>
      new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(action);
    const grants = statementsFor(roleLogicalId(BROKER_ROLE)).filter((s) => s.Effect === 'Allow' && (s.NotAction !== undefined || actionsOf(s).some((a) => grantsAction(a, 'codebuild:batchgetbuilds'))));
    expect(grants).toHaveLength(1);
    expect(actionsOf(grants[0]!)).toEqual(['codebuild:batchgetbuilds']);
    expect(grants[0]!.Resource).toEqual([{ 'Fn::GetAtt': [projectId(VALIDATION_PROJECT), 'Arn'] }, { 'Fn::GetAtt': [projectId(BROKER_PROJECT), 'Arn'] }]);
    expect(JSON.stringify(grants[0]!.Resource)).not.toContain('*');
  });

  it('the module binds the same broker project name as the stack (the module is pinned, the env is not read)', async () => {
    const m = (await import(pathToFileURL(PROVENANCE_SOURCE_PATH).href)) as { BROKER_PROJECT_NAME: string };
    expect(m.BROKER_PROJECT_NAME).toBe(BROKER_PROJECT);
    expect(PROJECTS.filter(([, r]) => r.Properties.Name === BROKER_PROJECT)).toHaveLength(1);
  });

  it('runs the pinned module right after the account check, before any candidate file is read', () => {
    const commands = allCommands(BROKER_PROJECT);
    expect(commands.slice(0, 13)).toEqual([
      nodeEval(BROKER_ACCOUNT_PIN_CHECK_SCRIPT),
      `mkdir -m 700 ${BROKER_OUT_DIR}`,
      // Ledger files verified before the first gate, so every later denial can be audited.
      `mkdir -p ${LEDGER_LOCAL_DIR}`,
      `aws s3 cp "s3://$OR_LEDGER_MODULE_BUCKET/$OR_LEDGER_MODULE_KEY" ${LEDGER_MODULE_LOCAL_PATH} --only-show-errors`,
      nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, LEDGER_MODULE_LOCAL_PATH, 'OR_LEDGER_MODULE_SHA256'),
      `aws s3 cp "s3://$OR_LEDGER_RUNNER_BUCKET/$OR_LEDGER_RUNNER_KEY" ${LEDGER_RUNNER_LOCAL_PATH} --only-show-errors`,
      nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, LEDGER_RUNNER_LOCAL_PATH, 'OR_LEDGER_RUNNER_SHA256'),
      gateCommand('BROKER_MODULE_INTEGRITY'),
      `aws s3 cp "s3://$OR_PROVENANCE_MODULE_BUCKET/$OR_PROVENANCE_MODULE_KEY" ${PROVENANCE_LOCAL_PATH} --only-show-errors`,
      nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, PROVENANCE_LOCAL_PATH, 'OR_PROVENANCE_MODULE_SHA256'),
      gateCommand('TRUSTED_PROVENANCE_DENIED'),
      PROVENANCE_COMMAND,
      nodeEval(PROVENANCE_RESULT_CHECK_SCRIPT, PROVENANCE_DECISION_PATH),
    ]);
    expect(commands[13]).toBe(gateCommand('TRUSTED_REVISION_MISMATCH'));
    const firstCandidateRead = commands.findIndex((c) => c.includes('broker-evidence.json') || c.includes('cdk.out'));
    expect(firstCandidateRead).toBeGreaterThan(13);
    // The module is executed exactly once, from the verified local path.
    expect(commands.filter((c) => c.startsWith('node ') && !c.startsWith('node -e') && c.includes(PROVENANCE_LOCAL_PATH))).toEqual([PROVENANCE_COMMAND]);
  });

  it('pins the real content SHA-256 of the provenance module', () => {
    const vars = Object.fromEntries(
      ((project(BROKER_PROJECT).Environment as Json).EnvironmentVariables as Array<{ Name: string; Value: unknown }>).map((v) => [v.Name, v.Value]),
    );
    expect(vars.OR_PROVENANCE_MODULE_SHA256).toBe(createHash('sha256').update(readFileSync(PROVENANCE_SOURCE_PATH)).digest('hex'));
    expect(vars.OR_PIPELINE_ARTIFACT_BUCKET).toEqual({ Ref: bucketId });
  });

  it('the module hash check accepts the untouched module and refuses tampering, a missing pin or a foreign variable name', () => {
    const dir = workspace();
    const file = join(dir, 'm.mjs');
    writeFileSync(file, readFileSync(PROVENANCE_SOURCE_PATH));
    const pin = createHash('sha256').update(readFileSync(PROVENANCE_SOURCE_PATH)).digest('hex');
    const check = (f: string, name: string, env: Record<string, string | undefined>) =>
      run(nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, f, name), dir, env).ok;
    expect(check(file, 'OR_PROVENANCE_MODULE_SHA256', { OR_PROVENANCE_MODULE_SHA256: pin })).toBe(true);
    expect(check(file, 'OR_PROVENANCE_MODULE_SHA256', {})).toBe(false);
    expect(check(file, 'OR_PROVENANCE_MODULE_SHA256', { OR_PROVENANCE_MODULE_SHA256: 'f'.repeat(64) })).toBe(false);
    expect(check(file, 'PATH', { PATH: pin })).toBe(false);
    writeFileSync(file, `${readFileSync(PROVENANCE_SOURCE_PATH, 'utf8')}\n// tampered\n`);
    expect(check(file, 'OR_PROVENANCE_MODULE_SHA256', { OR_PROVENANCE_MODULE_SHA256: pin })).toBe(false);
  });

  it('the command binds the synthesized pipeline, validation project and stage / action names', () => {
    const [, pipeline] = byType('AWS::CodePipeline::Pipeline')[0]!;
    expect(pipeline.Properties.Name).toBe(PIPELINE_NAME);
    const stages = (pipeline.Properties.Stages as Array<{ Name: string; Actions: Array<{ Name: string }> }>).map((st) => `${st.Name}/${st.Actions.map((a) => a.Name).join('+')}`);
    expect(stages).toEqual(Object.values(PIPELINE_STAGES).map((x) => `${x.stage}/${x.action}`));
    expect(PROVENANCE_COMMAND).toContain(`--validation-project ${VALIDATION_PROJECT} `);
  });
});

describe('the broker never reads or writes the candidate tree CodeBuild extracted (review C1)', () => {
  it('every file path a broker command names is broker-owned or a verified module under /tmp', () => {
    for (const command of allCommands(BROKER_PROJECT)) {
      if (command.startsWith('echo ') && !command.includes(' > ')) continue; // log line only
      // Drop inline scripts and quoted strings; what remains are the paths and flags the shell sees.
      const shell = command.replace(/node -e '[^']*'/g, 'node').replace(/"[^"]*"/g, '');
      for (const token of shell.split(/\s+/).filter(Boolean)) {
        if (/^(node|test|-f|-e|mkdir|-m|-p|700|aws|s3|cp|deny|--gate-file|&&|\|\||if|then|fi|\[|=|0|\];|>&2;|--only-show-errors|echo|exit|42|>|>&2|822063948773|--assembly|--account|--pipeline|--validation-project|--artifact-bucket-env|--stages|--stacks)$/.test(token)) continue;
        if (/^"\$[A-Z_]+"$|^"s3:\/\/\$[A-Z_]+\/\$[A-Z_]+"$|^OR_[A-Z0-9_]+$|^[A-Z][A-Za-z]+$|^[A-Z_]+$|^Source\/PromotionBranch,Validate\/UnprivilegedValidation,BrokerBoundary\/TrustedBrokerUnarmed$|^OpenReception-Web-dev,OpenReception-WebMonitoring-dev,OpenReception-CfMon-dev@us-east-1$/.test(token)) continue;
        expect(token.startsWith('/tmp/open-reception-'), `${token} in: ${command}`).toBe(true);
      }
    }
  });

  it('the paths match the provenance module and the decision is checked right after it runs', async () => {
    const m = (await import(pathToFileURL(resolve(__dirname, '../broker/run-provenance.mjs')).href)) as Record<string, string>;
    expect(m.BROKER_WORK_DIR).toBe(BROKER_WORK_DIR);
    expect(m.BROKER_OUT_DIR).toBe(BROKER_OUT_DIR);
    expect(m.VALIDATED_DIR).toBe(BROKER_VALIDATED_DIR);
    expect(m.DECISION_PATH).toBe(PROVENANCE_DECISION_PATH);
    expect(BROKER_ASSEMBLY_DIR.startsWith(`${BROKER_VALIDATED_DIR}/`)).toBe(true);
    const commands = allCommands(BROKER_PROJECT);
    expect(commands[commands.indexOf(PROVENANCE_COMMAND) + 1]).toBe(nodeEval(PROVENANCE_RESULT_CHECK_SCRIPT, PROVENANCE_DECISION_PATH));
  });

  it('the decision check requires allowed, this execution, this revision and the broker-owned extraction', () => {
    const decision = (d: Json) => {
      const dir = workspace();
      writeFileSync(join(dir, 'provenance.json'), JSON.stringify(d));
      return run(nodeEval(PROVENANCE_RESULT_CHECK_SCRIPT, join(dir, 'provenance.json')), dir, {
        OR_PIPELINE_EXECUTION_ID: 'e-1',
        OR_TRUSTED_SOURCE_REVISION: REV_A,
      }).ok;
    };
    const good = { result: 'allowed', rule: null, facts: { executionId: 'e-1', revision: REV_A, validatedArtifact: { extractedTo: BROKER_VALIDATED_DIR } } };
    expect(decision(good)).toBe(true);
    expect(decision({ ...good, result: 'denied' })).toBe(false);
    expect(decision({ ...good, rule: 'X' })).toBe(false);
    expect(decision({ ...good, facts: { ...good.facts, executionId: 'e-2' } })).toBe(false);
    expect(decision({ ...good, facts: { ...good.facts, revision: REV_B } })).toBe(false);
    expect(decision({ ...good, facts: { ...good.facts, validatedArtifact: { extractedTo: '.' } } })).toBe(false);
    expect(decision({})).toBe(false);
  });

  it('a symlinked output name in the candidate tree can no longer truncate a verified module', () => {
    // No command may redirect (>, >>, 2>, tee) anywhere but the broker-owned output dir.
    for (const command of allCommands(BROKER_PROJECT)) {
      const shell = command.replace(/node -e '[^']*'/g, 'node').replace(/"[^"]*"/g, '');
      expect(shell, command).not.toMatch(/\btee\b/);
      for (const m of shell.matchAll(/\d?>>?\s*(\S+)/g)) {
        const target = m[1]!;
        if (target === '&2' || target === '&2;') continue;
        // The broker-owned output dir, or the ledger gate marker (both under /tmp, broker-created).
        expect(target.startsWith(`${BROKER_OUT_DIR}/`) || target === LEDGER_GATE_FILE, command).toBe(true);
      }
    }
  });

  it('inline broker scripts take every file path from argv, never as a literal', () => {
    for (const command of allCommands(BROKER_PROJECT).filter((c) => c.startsWith("node -e '"))) {
      expect(command, command).not.toMatch(/(readFileSync|writeFileSync|existsSync|openSync)\("/);
    }
  });

});

describe('freshness vs retention (review C5)', () => {
  it('an execution can only be accepted well before its artifacts or old versions can expire', async () => {
    const m = (await import(pathToFileURL(resolve(__dirname, '../broker/run-provenance.mjs')).href)) as { MAX_EXECUTION_AGE_MS: number };
    expect(m.MAX_EXECUTION_AGE_MS * 4).toBeLessThanOrEqual(PIPELINE_ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe('ledger wiring (#1153): delivery, pin and denial audit', () => {
  const env = () =>
    Object.fromEntries(
      ((project(BROKER_PROJECT).Environment as Json).EnvironmentVariables as Array<{ Name: string; Value: unknown }>).map((v) => [v.Name, v.Value]),
    );

  it('pins the real content SHA-256 of both ledger files', () => {
    expect(env().OR_LEDGER_MODULE_SHA256).toBe(createHash('sha256').update(readFileSync(LEDGER_MODULE_SOURCE_PATH)).digest('hex'));
    expect(env().OR_LEDGER_RUNNER_SHA256).toBe(createHash('sha256').update(readFileSync(LEDGER_RUNNER_SOURCE_PATH)).digest('hex'));
  });

  it('passes the ledger table and the human-chosen ledger id parameter, nothing candidate-controlled', () => {
    const [tableId] = byType('AWS::DynamoDB::Table')[0]!;
    expect(env().OR_SPARSE_LEDGER_TABLE).toEqual({ Ref: tableId });
    expect(env().OR_SPARSE_LEDGER_ID).toEqual({ Ref: 'SparseLedgerId' });
    const params = template.toJSON().Parameters as Record<string, { AllowedPattern?: string; Default?: unknown }>;
    expect(params.SparseLedgerId?.AllowedPattern).toBe(LEDGER_ID_PATTERN);
    expect(params.SparseLedgerId?.Default).toBeUndefined();
  });

  it('the stack ledger id pattern accepts exactly what the ledger module accepts', async () => {
    const ledger = (await import(pathToFileURL(LEDGER_MODULE_SOURCE_PATH).href)) as { isLedgerId: (v: unknown) => boolean };
    const re = new RegExp(LEDGER_ID_PATTERN);
    for (const id of ['ledger-2026-09-28', 'a1234567', 'x'.repeat(128), 'short', 'x'.repeat(129), '-leading', 'has space', 'ok.id_v1-x']) {
      expect(re.test(id), id).toBe(ledger.isLedgerId(id));
    }
  });

  it('names each gate before evaluating it, in order, ending at BROKER_NOT_ARMED', () => {
    const gates = allCommands(BROKER_PROJECT).filter((c) => c.startsWith('echo ') && c.endsWith(`> ${LEDGER_GATE_FILE}`));
    expect(gates).toEqual([
      gateCommand('BROKER_MODULE_INTEGRITY'),
      gateCommand('TRUSTED_PROVENANCE_DENIED'),
      gateCommand('TRUSTED_REVISION_MISMATCH'),
      gateCommand('BROKER_MODULE_INTEGRITY'),
      gateCommand('TRUSTED_POLICY_DENIED'),
      gateCommand('BROKER_MODULE_INTEGRITY'),
      gateCommand('TARGET_STACK_NOT_STABLE'),
      gateCommand('BROKER_MODULE_INTEGRITY'),
      gateCommand('ACCESS_RESTRICTION_DENIED'),
      gateCommand('BROKER_NOT_ARMED'),
    ]);
    // Every trusted-module download / hash check runs under the integrity marker.
    const commands2 = allCommands(BROKER_PROJECT);
    for (const i of commands2.map((c, i) => (c.startsWith('aws s3 cp ') && !c.includes('OR_LEDGER_') ? i : -1)).filter((i) => i >= 0)) {
      const lastGate = commands2.slice(0, i).reverse().find((c) => c.endsWith(`> ${LEDGER_GATE_FILE}`));
      expect(lastGate, commands2[i]).toBe(gateCommand('BROKER_MODULE_INTEGRITY'));
    }
    const commands = allCommands(BROKER_PROJECT);
    expect(commands.indexOf(gateCommand('TRUSTED_REVISION_MISMATCH'))).toBeLessThan(commands.indexOf(nodeEval(BROKER_REVISION_CHECK_SCRIPT, BROKER_EVIDENCE_PATH)));
    expect(commands.indexOf(gateCommand('TRUSTED_POLICY_DENIED'))).toBeLessThan(commands.findIndex((c) => c.startsWith(`node ${TRUSTED_POLICY_LOCAL_PATH}`)));
  });

  it('the finally line never runs an unverified runner (tampered file or missing pin)', () => {
    const dir = workspace();
    const fakeDir = join(dir, 'ledger');
    execFileSync('mkdir', ['-p', fakeDir]);
    // Rewrite the local paths into the scratch dir and plant a runner that would leave a marker.
    const line = LEDGER_DENY_COMMAND.split(LEDGER_LOCAL_DIR).join(fakeDir);
    writeFileSync(join(fakeDir, 'sparse-ledger.mjs'), readFileSync(LEDGER_MODULE_SOURCE_PATH));
    writeFileSync(join(fakeDir, 'ledger-runner.mjs'), 'require("fs").writeFileSync("ran", "x")');
    const pins = {
      OR_LEDGER_MODULE_SHA256: createHash('sha256').update(readFileSync(LEDGER_MODULE_SOURCE_PATH)).digest('hex'),
      OR_LEDGER_RUNNER_SHA256: createHash('sha256').update(readFileSync(LEDGER_RUNNER_SOURCE_PATH)).digest('hex'),
    };
    const r = run(line, dir, { ...pins, CODEBUILD_BUILD_SUCCEEDING: '0' });
    expect(r.ok).toBe(true); // finally never fails the phase
    expect(existsSync(join(dir, 'ran'))).toBe(false);
  });

  it('the finally line does nothing for a succeeding build (only a failing build is a denial)', () => {
    const dir = workspace();
    const ledgerDir = join(dir, 'ledger');
    execFileSync('mkdir', ['-p', ledgerDir]);
    writeFileSync(join(ledgerDir, 'sparse-ledger.mjs'), readFileSync(LEDGER_MODULE_SOURCE_PATH));
    writeFileSync(join(ledgerDir, 'ledger-runner.mjs'), 'require("fs").writeFileSync("ran", "x")');
    const line = LEDGER_DENY_COMMAND.split(LEDGER_LOCAL_DIR).join(ledgerDir);
    for (const succeeding of ['1', undefined]) {
      expect(run(line, dir, { CODEBUILD_BUILD_SUCCEEDING: succeeding }).ok).toBe(true);
    }
    expect(existsSync(join(dir, 'ran'))).toBe(false);
    expect(LEDGER_DENY_COMMAND.startsWith('if [ "$CODEBUILD_BUILD_SUCCEEDING" = 0 ]; then ')).toBe(true);
  });

  it('the finally line audits the gate that stopped the build through the verified runner', () => {
    const dir = workspace();
    const ledgerDir = join(dir, 'ledger');
    const binDir = join(dir, 'bin');
    execFileSync('mkdir', ['-p', ledgerDir, binDir]);
    writeFileSync(join(ledgerDir, 'sparse-ledger.mjs'), readFileSync(LEDGER_MODULE_SOURCE_PATH));
    writeFileSync(join(ledgerDir, 'ledger-runner.mjs'), readFileSync(LEDGER_RUNNER_SOURCE_PATH));
    writeFileSync(join(ledgerDir, 'gate'), 'TRUSTED_POLICY_DENIED\n');
    // A fake CLI that records the call (the real one is only present in CodeBuild).
    writeFileSync(join(binDir, 'aws'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${join(dir, 'aws-call.txt')}\ncat "\${4#file://}" > ${join(dir, 'aws-request.json')}\necho '{}'\n`);
    execFileSync('chmod', ['+x', join(binDir, 'aws')]);
    const line = LEDGER_DENY_COMMAND.split(LEDGER_LOCAL_DIR).join(ledgerDir);
    const r = run(line, dir, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      OR_LEDGER_MODULE_SHA256: createHash('sha256').update(readFileSync(LEDGER_MODULE_SOURCE_PATH)).digest('hex'),
      OR_LEDGER_RUNNER_SHA256: createHash('sha256').update(readFileSync(LEDGER_RUNNER_SOURCE_PATH)).digest('hex'),
      OR_SPARSE_LEDGER_TABLE: 'OpenReception-DevDeployBroker-SparseDeployLedgerX-1',
      OR_TRUSTED_SOURCE_REVISION: REV_A,
      CODEBUILD_BUILD_ID: 'OpenReceptionTrustedDevDeployBroker:0000-1111',
      CODEBUILD_BUILD_SUCCEEDING: '0',
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!)).toMatchObject({ event: 'ledger.denial_recorded', rule: 'TRUSTED_POLICY_DENIED' });
    const call = readFileSync(join(dir, 'aws-call.txt'), 'utf8').trim().split('\n');
    expect(call.slice(0, 3)).toEqual(['dynamodb', 'put-item', '--cli-input-json']);
    expect(call[3]).toMatch(/^file:\/\//);
    const request = JSON.parse(readFileSync(join(dir, 'aws-request.json'), 'utf8')) as { Item: Record<string, { S?: string }>; ConditionExpression: string };
    expect(request.Item.status?.S).toBe('denied_before_mutation');
    expect(request.Item.denialRule?.S).toBe('TRUSTED_POLICY_DENIED');
    expect(request.Item.SK?.S).toBe('ATTEMPT#OpenReceptionTrustedDevDeployBroker:0000-1111');
    expect(request.ConditionExpression).toBe('attribute_not_exists(#PK)');
  });
});

describe('ledger audit: CloudTrail data events on the ledger table (#1153)', () => {
  const [trailId, trail] = byType('AWS::CloudTrail::Trail')[0]!;
  const [ledgerId] = byType('AWS::DynamoDB::Table')[0]!;
  const auditBucketId = byType('AWS::S3::Bucket').map(([id]) => id).find((id) => id !== ARTIFACT_BUCKET[0])!;

  it('is one trail recording only write data events of exactly the ledger table', () => {
    expect(byType('AWS::CloudTrail::Trail')).toHaveLength(1);
    expect(trail.Properties.AdvancedEventSelectors).toEqual([
      {
        Name: 'SparseLedgerWrites',
        FieldSelectors: [
          { Field: 'eventCategory', Equals: ['Data'] },
          { Field: 'resources.type', Equals: ['AWS::DynamoDB::Table'] },
          { Field: 'resources.ARN', Equals: [{ 'Fn::GetAtt': [ledgerId, 'Arn'] }] },
          { Field: 'readOnly', Equals: ['false'] },
        ],
      },
    ]);
    // No classic selectors (which would add management events) and no extra regions.
    expect(trail.Properties.EventSelectors).toBeUndefined();
    expect(trail.Properties).toMatchObject({ IsLogging: true, EnableLogFileValidation: true, IsMultiRegionTrail: false, IncludeGlobalServiceEvents: false, TrailName: LEDGER_AUDIT_TRAIL_NAME });
    expect(trail.Properties.S3BucketName).toEqual({ Ref: auditBucketId });
    expect((trail as unknown as { DependsOn?: string[] }).DependsOn?.some((d) => byType('AWS::S3::BucketPolicy').some(([pid]) => pid === d))).toBe(true);
    void trailId;
  });

  it('the audit bucket is private, versioned, retained and kept for the reviewed period', () => {
    const [, bucket] = byType('AWS::S3::Bucket').find(([id]) => id === auditBucketId)!;
    expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect((bucket as unknown as { DeletionPolicy?: string }).DeletionPolicy).toBe('Retain');
    const rules = (bucket.Properties.LifecycleConfiguration as Json).Rules as Json[];
    expect(rules).toEqual([expect.objectContaining({ ExpirationInDays: LEDGER_AUDIT_RETENTION_DAYS, NoncurrentVersionExpiration: { NoncurrentDays: LEDGER_AUDIT_RETENTION_DAYS } })]);
  });

  it('the audit bucket policy is retained with the bucket (the deny must outlive a stack deletion)', () => {
    const policies = byType('AWS::S3::BucketPolicy').filter(([, r]) => JSON.stringify(r.Properties.PolicyDocument).includes('DenyAuditHistoryRewrite'));
    expect(policies).toHaveLength(1);
    expect(policies[0]![1]).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });

  it('only CloudTrail (for this trail) may write; nobody but the human deploy role may erase or unprotect', () => {
    const [, policy] = byType('AWS::S3::BucketPolicy').find(([, r]) => JSON.stringify(r.Properties.Bucket).includes(auditBucketId))!;
    const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    const allows = statements.filter((st) => st.Effect === 'Allow');
    expect(allows.map((st) => JSON.stringify(st.Principal))).toEqual([JSON.stringify({ Service: 'cloudtrail.amazonaws.com' }), JSON.stringify({ Service: 'cloudtrail.amazonaws.com' })]);
    expect(allows.flatMap(actionsOf).sort()).toEqual(['s3:getbucketacl', 's3:putobject']);
    for (const st of allows) expect(JSON.stringify(st.Condition)).toContain(`trail/${LEDGER_AUDIT_TRAIL_NAME}`);
    const protect = statements.find((st) => st.Effect === 'Deny' && actionsOf(st).includes('s3:deleteobjectversion'))!;
    expect(actionsOf(protect).sort()).toEqual(LEDGER_AUDIT_PROTECTED_ACTIONS.map((a) => a.toLowerCase()).sort());
    for (const a of ['s3:deleteobjectversion', 's3:putbucketpolicy', 's3:putbucketacl', 's3:putobjectacl', 's3:putbucketpublicaccessblock', 's3:putencryptionconfiguration', 's3:putbucketownershipcontrols']) {
      expect(actionsOf(protect), a).toContain(a);
    }
    expect(protect.Principal).toEqual({ AWS: '*' });
    expect(protect.Condition).toEqual({ ArnNotEquals: { 'aws:PrincipalArn': [{ Ref: 'SparseLedgerStackDeployRoleArn' }] } });
    expect(actionsOf(protect)).toContain('s3:deletebucket');
    // Writes: only a request on behalf of this trail (identity-based PutObject elsewhere is not enough).
    const writes = statements.find((st) => st.Effect === 'Deny' && JSON.stringify(actionsOf(st)) === JSON.stringify(['s3:putobject']))!;
    expect(writes.Principal).toEqual({ AWS: '*' });
    expect(Object.keys(writes.Condition as Json)).toEqual(['StringNotEqualsIfExists']);
    expect(JSON.stringify(writes.Condition)).toContain('aws:SourceArn');
    expect(JSON.stringify(writes.Condition)).toContain(`trail/${LEDGER_AUDIT_TRAIL_NAME}`);
  });

  it('no build role has any authority over the trail or its bucket', () => {
    for (const roleName of [VALIDATION_ROLE, BROKER_ROLE]) {
      for (const st of statementsFor(roleLogicalId(roleName)).filter((s) => s.Effect === 'Allow')) {
        expect(actionsOf(st).some((a) => a.startsWith('cloudtrail:'))).toBe(false);
        expect(JSON.stringify(st.Resource ?? null)).not.toContain(auditBucketId);
      }
    }
  });
});

describe('alerts for attempts that may stay in_progress (#1153)', () => {
  const [topicId] = byType('AWS::SNS::Topic')[0]!;

  it('one alert topic, without any subscription in the stack (the owner subscribes a human endpoint)', () => {
    expect(byType('AWS::SNS::Topic')).toHaveLength(1);
    expect(byType('AWS::SNS::Subscription')).toHaveLength(0);
  });

  it('every runner event that can leave an attempt in_progress or a denial unaudited raises the alarm', () => {
    const runner = readFileSync(LEDGER_RUNNER_SOURCE_PATH, 'utf8');
    const emitted = new Set([...runner.matchAll(/event: (?:[^']*\? )?'(ledger\.[a-z_]+)'/g)].map((m) => m[1]));
    for (const e of LEDGER_ATTENTION_EVENTS) expect(emitted, e).toContain(e);
    const [, filter] = byType('AWS::Logs::MetricFilter')[0]!;
    const pattern = filter.Properties.FilterPattern as string;
    for (const e of LEDGER_ATTENTION_EVENTS) expect(pattern).toContain(`($.event = "${e}")`);
    expect(pattern).toContain('($.audited IS FALSE)');
    expect(filter.Properties.LogGroupName).toEqual({ Ref: byType('AWS::Logs::LogGroup').find(([id]) => id.startsWith('BrokerLogs'))![0] });
    const [, alarm] = byType('AWS::CloudWatch::Alarm')[0]!;
    expect(alarm.Properties).toMatchObject({
      MetricName: (filter.Properties.MetricTransformations as Json[])[0]!.MetricName,
      Statistic: 'Sum',
      Period: 300,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: topicId }],
    });
  });

  it('a broker build that times out, is stopped or faults is reported (its bookkeeping never ran)', () => {
    // Literal values: a timeout / fault is a phase status, not a documented build-status value.
    expect([...BROKER_ABORT_STATES]).toEqual(['TIMED_OUT', 'STOPPED', 'FAULT']);
    const patterns = byType('AWS::Events::Rule').map(([, r]) => r.Properties.EventPattern);
    expect(patterns).toEqual([
      {
        source: ['aws.codebuild'],
        'detail-type': ['CodeBuild Build State Change'],
        detail: { 'project-name': [BROKER_PROJECT], 'build-status': ['TIMED_OUT', 'STOPPED', 'FAULT'] },
      },
      {
        source: ['aws.codebuild'],
        'detail-type': ['CodeBuild Build Phase Change'],
        detail: { 'project-name': [BROKER_PROJECT], 'completed-phase-status': ['TIMED_OUT', 'STOPPED', 'FAULT'] },
      },
    ]);
    for (const [, rule] of byType('AWS::Events::Rule')) {
      expect(rule.Properties.Targets).toEqual([expect.objectContaining({ Arn: { Ref: topicId } })]);
    }
  });

  it('CloudWatch may publish the alarm to the topic (the topic policy replaces the default one)', () => {
    const [, policy] = byType('AWS::SNS::TopicPolicy')[0]!;
    const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    const cw = statements.filter((s) => JSON.stringify(s.Principal) === JSON.stringify({ Service: 'cloudwatch.amazonaws.com' }));
    expect(cw).toHaveLength(1);
    expect(cw[0]).toMatchObject({ Effect: 'Allow', Action: 'sns:Publish', Resource: { Ref: topicId } });
    const [alarmId] = byType('AWS::CloudWatch::Alarm')[0]!;
    expect(cw[0]!.Condition).toEqual({ ArnEquals: { 'aws:SourceArn': { 'Fn::GetAtt': [alarmId, 'Arn'] } }, StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } });
  });

  /** Every statement of every policy attached to the alert topic (all `AWS::SNS::TopicPolicy`). */
  const topicStatements = (): Statement[] =>
    byType('AWS::SNS::TopicPolicy')
      .filter(([, p]) => (p.Properties.Topics as unknown[]).some((t) => JSON.stringify(t) === JSON.stringify({ Ref: topicId })))
      .flatMap(([, p]) => documentStatements(p.Properties.PolicyDocument));

  it('🔴 every Allow on the alert topic is bound to its source ARN and this account (no confused deputy, #1218)', () => {
    // CDK's EventBridge SNS target adds an unconditioned `events.amazonaws.com` Allow (Sid "2"):
    // any account's rule could then publish fake alerts, or drown a real one.
    const allows = topicStatements().filter((s) => s.Effect === 'Allow');
    expect(allows.length).toBeGreaterThan(0);
    for (const s of allows) {
      const c = s.Condition as Record<string, Record<string, unknown>> | undefined;
      // Exact operators only: `ArnLike` with a wildcard or an `…IfExists` variant would not bind.
      expect(c?.ArnEquals?.['aws:SourceArn'], JSON.stringify(s)).toBeDefined();
      expect(JSON.stringify(c!.ArnEquals!['aws:SourceArn'])).not.toContain('*');
      expect(c?.StringEquals?.['aws:SourceAccount'], JSON.stringify(s)).toEqual({ Ref: 'AWS::AccountId' });
      expect(s.Principal, JSON.stringify(s)).toEqual({ Service: expect.stringMatching(/^[a-z]+\.amazonaws\.com$/) });
      expect(s.NotPrincipal).toBeUndefined();
    }
  });

  it('EventBridge may publish to the topic only from the two abort rules (#1218)', () => {
    const ev = topicStatements().filter((s) => JSON.stringify(s.Principal) === JSON.stringify({ Service: 'events.amazonaws.com' }));
    // Exactly one, and it is still there: without it the abort alerts would be silently dropped.
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ Effect: 'Allow', Action: 'sns:Publish', Resource: { Ref: topicId } });
    const ruleIds = byType('AWS::Events::Rule').map(([id]) => id);
    expect(ruleIds).toHaveLength(2);
    expect(ev[0]!.Condition).toEqual({
      ArnEquals: { 'aws:SourceArn': ruleIds.map((id) => ({ 'Fn::GetAtt': [id, 'Arn'] })) },
      StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
    });
    // Resource-policy publish only: no rule role (no new IAM role or permission).
    for (const [, rule] of byType('AWS::Events::Rule')) {
      for (const t of rule.Properties.Targets as Json[]) expect(t.RoleArn).toBeUndefined();
    }
  });
});

describe('target-stack stability gate (S10a): a failed or busy target stack blocks automated attempts', () => {
  const commands = () => allCommands(BROKER_PROJECT);

  it('the broker holds exactly one reviewed DescribeStacks statement on the three target stacks; validation holds none', () => {
    const broker = statementsFor(roleLogicalId(BROKER_ROLE));
    expect(broker.filter(isTargetStackStatement)).toHaveLength(1);
    const cfn = broker.filter((s) => actionsOf(s).some((a) => a.startsWith('cloudformation:')));
    expect(cfn).toEqual(broker.filter(isTargetStackStatement));
    expect(allowedActions(VALIDATION_ROLE).some((a) => a.startsWith('cloudformation:'))).toBe(false);
  });

  it('the Validation synth writes only the three stacks, with the ADR 0009 qualifier and region (blocker 7)', () => {
    const synth = allCommands(VALIDATION_PROJECT).find((c) => c.includes('npx cdk synth '))!;
    expect(synth).toContain(' -c promotionStacksOnly=true ');
    expect(synth).toContain(' -c @aws-cdk/core:bootstrapQualifier=orcloud01');
    // The CDK CLI derives CDK_DEFAULT_REGION from AWS_REGION, so both are pinned.
    expect(synth).toContain('AWS_REGION="$OR_BROKER_TARGET_REGION" ');
    expect(synth).toContain('CDK_DEFAULT_REGION="$OR_BROKER_TARGET_REGION" ');
    // bin/open-reception.ts builds no other stack when the flag is set.
    const bin = readFileSync(resolve(__dirname, '../bin/open-reception.ts'), 'utf8');
    const plainGuard = bin.indexOf('if (!promotionStacksOnly) {');
    const realtimeGuard = bin.indexOf('if (config.realtime.enabled && !promotionStacksOnly) {');
    expect(plainGuard).toBeGreaterThanOrEqual(0);
    expect(realtimeGuard).toBeGreaterThan(plainGuard);
    const guarded = bin.slice(plainGuard, realtimeGuard);
    expect(guarded).toContain('new NotificationStack(');
    expect(guarded).toContain('new MonitoringStack(');
    expect(bin.slice(realtimeGuard)).toContain('new RealtimeRuntimeStack(');
    expect(bin.slice(0, plainGuard)).not.toMatch(/new (Notification|Monitoring|RealtimeRuntime)Stack\(/);
    expect(bin.match(/new [A-Za-z]+Stack\(/g)).toHaveLength(6);
    expect(bin).toContain("String(app.node.tryGetContext('promotionStacksOnly') ?? '') === 'true'");
  });

  it('checks exactly the stacks the Validation synth produces', () => {
    const synth = allCommands(VALIDATION_PROJECT).find((c) => c.includes('npx cdk synth '))!;
    const names = synth.split('npx cdk synth ')[1]!.split(' --output')[0]!.split(' ');
    expect(names).toEqual(TARGET_STACKS.map((t) => t.stackName));
  });

  it('downloads, verifies, runs and checks the pinned module after the policy passed and before BROKER_NOT_ARMED', () => {
    const c = commands();
    const policy = c.findIndex((x) => x.startsWith(`node ${TRUSTED_POLICY_LOCAL_PATH} `));
    const download = c.findIndex((x) => x.startsWith('aws s3 cp "s3://$OR_TARGET_STACKS_MODULE_BUCKET'));
    expect(download).toBeGreaterThan(policy);
    expect(c.slice(download - 1, download + 5)).toEqual([
      gateCommand('BROKER_MODULE_INTEGRITY'),
      `aws s3 cp "s3://$OR_TARGET_STACKS_MODULE_BUCKET/$OR_TARGET_STACKS_MODULE_KEY" ${TARGET_STACKS_LOCAL_PATH} --only-show-errors`,
      nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, TARGET_STACKS_LOCAL_PATH, 'OR_TARGET_STACKS_MODULE_SHA256'),
      gateCommand('TARGET_STACK_NOT_STABLE'),
      TARGET_STACKS_COMMAND,
      nodeEval(TARGET_STACKS_RESULT_CHECK_SCRIPT, TARGET_STACKS_DECISION_PATH),
    ]);
    // Followed only by the access-restriction gate (pinned in its own block below), then BROKER_NOT_ARMED.
    expect(c[download + 5]).toBe(gateCommand('BROKER_MODULE_INTEGRITY'));
    expect(c[download + 6]).toBe(`aws s3 cp "s3://$OR_ACCESS_RESTRICTION_MODULE_BUCKET/$OR_ACCESS_RESTRICTION_MODULE_KEY" ${ACCESS_RESTRICTION_LOCAL_PATH} --only-show-errors`);
    expect(c[download + 11]).toBe(gateCommand('BROKER_NOT_ARMED'));
    expect(c.filter((x) => x.includes(TARGET_STACKS_LOCAL_PATH))).toHaveLength(3);
  });

  it('pins the real content SHA-256 of the module and the broker region', () => {
    const vars = Object.fromEntries(
      ((project(BROKER_PROJECT).Environment as Json).EnvironmentVariables as Array<{ Name: string; Value: unknown }>).map((v) => [v.Name, v.Value]),
    );
    expect(vars.OR_TARGET_STACKS_MODULE_SHA256).toBe(createHash('sha256').update(readFileSync(TARGET_STACKS_SOURCE_PATH)).digest('hex'));
    expect(vars.OR_TARGET_STACKS_MODULE_KEY).toMatch(/^[0-9a-f]{64}\.mjs$/);
    expect(vars.OR_BROKER_TARGET_REGION).toEqual({ Ref: 'AWS::Region' });
  });

  it('the module paths match the stack and the runner records the gate', async () => {
    const m = (await import(pathToFileURL(TARGET_STACKS_SOURCE_PATH).href)) as Record<string, unknown>;
    expect(m.BROKER_OUT_DIR).toBe(BROKER_OUT_DIR);
    expect(m.DECISION_PATH).toBe(TARGET_STACKS_DECISION_PATH);
    const runner = (await import(pathToFileURL(LEDGER_RUNNER_SOURCE_PATH).href)) as { GATE_RULES: readonly string[] };
    expect(runner.GATE_RULES).toContain('TARGET_STACK_NOT_STABLE');
    // Every gate the buildspec names is one the runner records by name (never BROKER_GATE_UNKNOWN).
    for (const g of commands().filter((x) => x.endsWith(`> ${LEDGER_GATE_FILE}`))) {
      expect(runner.GATE_RULES, g).toContain(g.split(' ')[1]);
    }
  });

  it('the decision check requires allowed, this execution, this revision and exactly the reviewed stacks', () => {
    const decision = (d: unknown) => {
      const dir = workspace();
      writeFileSync(join(dir, 'target-stacks.json'), JSON.stringify(d));
      return run(nodeEval(TARGET_STACKS_RESULT_CHECK_SCRIPT, join(dir, 'target-stacks.json')), dir, {
        OR_PIPELINE_EXECUTION_ID: 'e-1',
        OR_TRUSTED_SOURCE_REVISION: REV_A,
      }).ok;
    };
    const stacks = TARGET_STACKS.map((t) => ({ stackName: t.stackName, region: t.region ?? 'ap-northeast-1', status: 'UPDATE_COMPLETE' }));
    const good = { result: 'allowed', rule: null, executionId: 'e-1', revision: REV_A, stacks };
    expect(decision(good)).toBe(true);
    expect(decision({ ...good, result: 'denied' })).toBe(false);
    expect(decision({ ...good, rule: 'TARGET_STACK_NOT_STABLE' })).toBe(false);
    expect(decision({ ...good, executionId: 'e-2' })).toBe(false);
    expect(decision({ ...good, executionId: null })).toBe(false);
    expect(decision({ ...good, revision: REV_B })).toBe(false);
    expect(decision({ ...good, stacks: stacks.slice(1) })).toBe(false);
    expect(decision({ ...good, stacks: [] })).toBe(false);
    expect(decision({})).toBe(false);
  });

  it('a denial that needs a human (unstable stack, repeated failure of one revision) raises the alarm', async () => {
    const [, filter] = byType('AWS::Logs::MetricFilter')[0]!;
    const pattern = filter.Properties.FilterPattern as string;
    for (const r of ESCALATION_RULES) expect(pattern).toContain(`($.rule = "${r}")`);
    const ledger = (await import(pathToFileURL(LEDGER_MODULE_SOURCE_PATH).href)) as { RULES: Record<string, string> };
    expect(ESCALATION_RULES).toContain(ledger.RULES.REVISION_REPEATED_FAILURE);
    expect(ESCALATION_RULES).toContain(ledger.RULES.LEDGER_CORRUPT);
    // Every rule the stability module can log (its own line carries the precise rule).
    const stacks = (await import(pathToFileURL(TARGET_STACKS_SOURCE_PATH).href)) as { RULES: Record<string, string> };
    for (const r of Object.values(stacks.RULES)) expect(ESCALATION_RULES, r).toContain(r);
  });

  it('the target stacks and regions are the ones the trusted policy approves', async () => {
    const policy = (await import(pathToFileURL(TRUSTED_POLICY_SOURCE_PATH).href)) as { APPROVED_STACKS: Record<string, string> };
    // The broker (and the region-less stacks) run in the dev region the policy pins for Web.
    expect(Object.fromEntries(TARGET_STACKS.map((t) => [t.stackName, t.region ?? 'ap-northeast-1']))).toEqual(policy.APPROVED_STACKS);
  });
});

describe('access-restriction gate (S6c, D-5): broker-derived, pinned, before BROKER_NOT_ARMED, no new authority', () => {
  const commands = () => allCommands(BROKER_PROJECT);

  it('downloads, verifies, runs and checks the pinned module after the target-stack check and right before BROKER_NOT_ARMED', () => {
    const c = commands();
    const targetCheck = c.indexOf(nodeEval(TARGET_STACKS_RESULT_CHECK_SCRIPT, TARGET_STACKS_DECISION_PATH));
    expect(targetCheck).toBeGreaterThan(0);
    expect(c.slice(targetCheck + 1, targetCheck + 10)).toEqual([
      gateCommand('BROKER_MODULE_INTEGRITY'),
      `aws s3 cp "s3://$OR_ACCESS_RESTRICTION_MODULE_BUCKET/$OR_ACCESS_RESTRICTION_MODULE_KEY" ${ACCESS_RESTRICTION_LOCAL_PATH} --only-show-errors`,
      nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, ACCESS_RESTRICTION_LOCAL_PATH, 'OR_ACCESS_RESTRICTION_MODULE_SHA256'),
      gateCommand('ACCESS_RESTRICTION_DENIED'),
      ACCESS_RESTRICTION_COMMAND,
      nodeEval(ACCESS_RESTRICTION_RESULT_CHECK_SCRIPT, ACCESS_RESTRICTION_DECISION_PATH),
      gateCommand('BROKER_NOT_ARMED'),
      nodeEval(BROKER_NOT_ARMED_RESULT_SCRIPT, POLICY_RESULT_PATH, BROKER_RESULT_PATH),
      'echo "Trusted broker is intentionally unarmed." >&2',
    ]);
    expect(c[targetCheck + 10]).toBe('exit 42');
    expect(buildSpec(BROKER_PROJECT).phases.build!.commands.at(-1)).toBe('exit 42');
    expect(c.filter((x) => x.includes(ACCESS_RESTRICTION_LOCAL_PATH))).toHaveLength(3);
    expect(ACCESS_RESTRICTION_COMMAND).toBe(`node ${ACCESS_RESTRICTION_LOCAL_PATH} --assembly ${BROKER_ASSEMBLY_DIR}`);
  });

  it('runs only after the trusted policy, whose denial (nested stacks / assemblies included) stops the build first', () => {
    const c = commands();
    const policyRun = c.findIndex((x) => x.startsWith(`node ${TRUSTED_POLICY_LOCAL_PATH} --assembly ${BROKER_ASSEMBLY_DIR} `));
    expect(policyRun).toBeGreaterThan(0);
    // A plain command: a non-zero exit (41 = denied) fails the phase; nothing swallows it.
    expect(c[policyRun]).not.toMatch(/\|\||;|&$/);
    expect(policyRun).toBeLessThan(c.indexOf(ACCESS_RESTRICTION_COMMAND));
    expect(c.slice(policyRun, c.indexOf(ACCESS_RESTRICTION_COMMAND)).some((x) => x.includes('|| true'))).toBe(false);
  });

  it('still never reserves or records an outcome while unarmed; BROKER_NOT_ARMED is the last gate', () => {
    const c = commands();
    expect(c.some((x) => / reserve\b| outcome\b/.test(x))).toBe(false);
    const gates = c.filter((x) => x.endsWith(`> ${LEDGER_GATE_FILE}`));
    expect(gates.at(-1)).toBe(gateCommand('BROKER_NOT_ARMED'));
    const build = buildSpec(BROKER_PROJECT).phases.build!.commands;
    expect(build.slice(build.indexOf(gateCommand('BROKER_NOT_ARMED')))).toEqual([
      gateCommand('BROKER_NOT_ARMED'),
      nodeEval(BROKER_NOT_ARMED_RESULT_SCRIPT, POLICY_RESULT_PATH, BROKER_RESULT_PATH),
      'echo "Trusted broker is intentionally unarmed." >&2',
      'exit 42',
    ]);
  });

  it('pins the real content SHA-256 of the module', () => {
    const vars = Object.fromEntries(
      ((project(BROKER_PROJECT).Environment as Json).EnvironmentVariables as Array<{ Name: string; Value: unknown }>).map((v) => [v.Name, v.Value]),
    );
    expect(vars.OR_ACCESS_RESTRICTION_MODULE_SHA256).toBe(createHash('sha256').update(readFileSync(ACCESS_RESTRICTION_SOURCE_PATH)).digest('hex'));
    expect(vars.OR_ACCESS_RESTRICTION_MODULE_SHA256).toBe(trustedPolicySha256(ACCESS_RESTRICTION_SOURCE_PATH));
    expect(vars.OR_ACCESS_RESTRICTION_MODULE_KEY).toMatch(/^[0-9a-f]{64}\.mjs$/);
  });

  it('the module, the stack and the runner agree on the decision path; the runner records the gate', async () => {
    const m = (await import(pathToFileURL(ACCESS_RESTRICTION_SOURCE_PATH).href)) as Record<string, unknown>;
    expect(m.BROKER_OUT_DIR).toBe(BROKER_OUT_DIR);
    expect(m.DECISION_PATH).toBe(ACCESS_RESTRICTION_DECISION_PATH);
    const runner = (await import(pathToFileURL(LEDGER_RUNNER_SOURCE_PATH).href)) as { GATE_RULES: readonly string[]; ACCESS_RESTRICTION_PATH: string };
    expect(runner.ACCESS_RESTRICTION_PATH).toBe(ACCESS_RESTRICTION_DECISION_PATH);
    expect(runner.GATE_RULES).toContain('ACCESS_RESTRICTION_DENIED');
  });

  it('open-reception declares no restriction check today (effective policy stays 1 / 2)', async () => {
    const m = (await import(pathToFileURL(ACCESS_RESTRICTION_SOURCE_PATH).href)) as { PRODUCT_RESTRICTION_CHECK: unknown };
    expect(m.PRODUCT_RESTRICTION_CHECK).toBeNull();
  });

  it('the decision check requires allowed, this execution, this revision and a known state', () => {
    const decision = (d: unknown) => {
      const dir = workspace();
      writeFileSync(join(dir, 'access-restriction.json'), JSON.stringify(d));
      return run(nodeEval(ACCESS_RESTRICTION_RESULT_CHECK_SCRIPT, join(dir, 'access-restriction.json')), dir, {
        OR_PIPELINE_EXECUTION_ID: 'e-1',
        OR_TRUSTED_SOURCE_REVISION: REV_A,
      }).ok;
    };
    const good = { result: 'allowed', rule: null, executionId: 'e-1', revision: REV_A, accessRestriction: { state: 'absent' } };
    expect(decision(good)).toBe(true);
    expect(decision({ ...good, accessRestriction: { state: 'verified' } })).toBe(true);
    expect(decision({ ...good, accessRestriction: { state: 'unverifiable' } })).toBe(false);
    expect(decision({ ...good, accessRestriction: {} })).toBe(false);
    expect(decision({ ...good, result: 'denied' })).toBe(false);
    expect(decision({ ...good, rule: 'ACCESS_RESTRICTION_WEAKENED' })).toBe(false);
    expect(decision({ ...good, executionId: 'e-2' })).toBe(false);
    expect(decision({ ...good, executionId: null })).toBe(false);
    expect(decision({ ...good, revision: REV_B })).toBe(false);
    expect(decision({})).toBe(false);
  });

  it('a weakened declared restriction, an unreadable assembly and an unsettled previous attempt raise the alarm', async () => {
    const [, filter] = byType('AWS::Logs::MetricFilter')[0]!;
    const pattern = filter.Properties.FilterPattern as string;
    const m = (await import(pathToFileURL(ACCESS_RESTRICTION_SOURCE_PATH).href)) as { RULES: Record<string, string> };
    const ledger = (await import(pathToFileURL(LEDGER_MODULE_SOURCE_PATH).href)) as { RULES: Record<string, string> };
    // A leaked credential needs human rotation, so every access-restriction rule escalates.
    expect(Object.values(m.RULES).sort()).toEqual(['ACCESS_RESTRICTION_CREDENTIAL_IN_TEMPLATE', 'ACCESS_RESTRICTION_INPUT_INVALID', 'ACCESS_RESTRICTION_WEAKENED']);
    for (const r of [...Object.values(m.RULES), ledger.RULES.PREVIOUS_ATTEMPT_UNSETTLED!]) {
      expect(ESCALATION_RULES as readonly string[], r).toContain(r);
      expect(pattern).toContain(`($.rule = "${r}")`);
    }
  });

  it('adds no IAM: the broker role reads the module through the existing asset grant only', () => {
    const broker = statementsFor(roleLogicalId(BROKER_ROLE));
    const text = JSON.stringify(broker);
    expect(text).not.toContain('sts:AssumeRole');
    // No statement names the module specifically: it shares the asset-bucket read the other trusted modules use.
    expect(text).not.toContain('access-restriction');
  });
});
