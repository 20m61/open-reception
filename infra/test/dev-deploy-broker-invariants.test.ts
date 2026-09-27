import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { createHash } from 'node:crypto';
import {
  BROKER_NOT_ARMED_RESULT_SCRIPT,
  BROKER_POLICY_HASH_CHECK_SCRIPT,
  BROKER_REVISION_CHECK_SCRIPT,
  DevDeployBrokerStack,
  SPARSE_LEDGER_BROKER_ACTIONS,
  SPARSE_LEDGER_PROJECT_KEY,
  TRUSTED_POLICY_LOCAL_PATH,
  TRUSTED_POLICY_SOURCE_PATH,
  VALIDATION_EVIDENCE_SCRIPT,
  nodeEval,
  trustedPolicySha256,
} from '../lib/stacks/dev-deploy-broker-stack';

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

const ARTIFACT_BUCKET = byType('AWS::S3::Bucket').map(([id]) => id);

const LEDGER_TABLES = byType('AWS::DynamoDB::Table').map(([id]) => id);

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
        'OR_TRUSTED_POLICY_BUCKET',
        'OR_TRUSTED_POLICY_KEY',
        'OR_TRUSTED_POLICY_SHA256',
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
      /^node -e '[^']*' \/tmp\/open-reception-trusted-policy\.mjs$/,
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
        // Inline JS may only use the fs/crypto builtins: no child processes, dynamic imports or eval.
        const requires = [...command.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]);
        expect(
          requires.every((r) => r === '"fs"' || r === '"crypto"'),
          `requires: ${requires.join(',')}`,
        ).toBe(true);
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
    // The sparse ledger statement is the one reviewed exception to the dynamodb: ban; its exact
    // shape is pinned in the "sparse deploy ledger" block below.
    const broker = statementsFor(roleLogicalId(BROKER_ROLE))
      .filter((s) => s.Effect === 'Allow' && !isLedgerStatement(s))
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
    const download = commands.findIndex((c) => c.startsWith('aws s3 cp '));
    const verify = commands.indexOf(nodeEval(BROKER_POLICY_HASH_CHECK_SCRIPT, TRUSTED_POLICY_LOCAL_PATH));
    const execute = commands.findIndex((c) => c.startsWith(`node ${TRUSTED_POLICY_LOCAL_PATH} `));
    expect(download).toBeGreaterThanOrEqual(0);
    expect(verify).toBe(download + 1);
    expect(execute).toBe(verify + 1);
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
        'dynamodb:restoretablefrombackup',
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

  it.each(['SparseLedgerOverrideIssuerRoleArn', 'SparseLedgerStackDeployRoleArn'])(
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

  it('the Claude boundary and CFN exec policies deny dynamodb:* on this stack\'s tables', () => {
    for (const name of [
      'claude-boundary.json',
      'claude-cfn-exec.json',
      'claude-boundary-migration.json',
      'claude-cfn-exec-migration.json',
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

  it('the broker buildspec does not run the ledger yet; when wired it must be a sha256-pinned stack asset', () => {
    // Arming work: the ledger module must be delivered like the trusted policy (stack-published,
    // content-hash verified before execution), never read from the candidate artifact.
    expect(allCommands(BROKER_PROJECT).some((c) => c.includes('sparse-ledger'))).toBe(false);
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
    const sequence = commands.slice(start, start + 3);
    expect(sequence[2]).toBe(nodeEval(BROKER_NOT_ARMED_RESULT_SCRIPT));
    const file = copyOfPolicy((t) => `${t}\n// tampered\n`);
    const dir = dirname(file);
    const script = ['set -e', ...sequence.map((c) => c.split(TRUSTED_POLICY_LOCAL_PATH).join(file))].join('\n');
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
