/**
 * The owner's runbook (`docs/runbook-sparse-ledger-activation.md`) steps 3.5–5 against what the code
 * and the CDK CLI actually accept. Each of these was wrong once and would only fail at the owner's
 * keyboard (or, for a name pattern, as an AccessDenied in the middle of the first deploy).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { cfnGeneratedNamePrefix } from '../../src/domain/governance/cfn-generated-name';
import { DevDeployBrokerStack } from '../lib/stacks/dev-deploy-broker-stack';

const RUNBOOK = readFileSync(resolve(__dirname, '../../docs/runbook-sparse-ledger-activation.md'), 'utf8');
const STACK_NAME = 'OpenReception-DevDeployBroker';

/** Shell commands in the runbook's bash blocks, with `\` continuations joined. */
const bashCommands = (): string[] =>
  [...RUNBOOK.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap((m) => m[1]!.replace(/\\\n\s*/g, ' ').split('\n'))
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

describe('runbook step 5: broker stack deploy commands', () => {
  it('🔴 the execute step passes no --parameters (the CLI rejects them with execute-change-set)', () => {
    const execute = bashCommands().filter((c) => c.includes('--method=execute-change-set'));
    expect(execute).toHaveLength(1);
    // `ARGS` carries the --parameters, so it must not be reused here either.
    expect(execute[0]).not.toContain('--parameters');
    expect(execute[0]).not.toContain('ARGS');
    expect(execute[0]).toContain('--change-set-name ledger-activation');
    expect(execute[0]).toContain('--no-rollback');
    expect(execute[0]).toContain('OpenReception-DevDeployBroker');
  });

  it('the prepare step and the execute step name the same change set', () => {
    const prepare = bashCommands().filter((c) => c.includes('--method=prepare-change-set'));
    expect(prepare).toHaveLength(1);
    expect(RUNBOOK).toMatch(/ARGS=\([\s\S]*?--change-set-name ledger-activation\)/);
  });

  it('the deploy shell is pinned to the broker region (the app refuses any other)', () => {
    expect(bashCommands().some((c) => /^export AWS_REGION=ap-northeast-1(\s|$)/.test(c))).toBe(true);
  });
});

describe('runbook step 4a: CloudFormation-generated name patterns cover the real names', () => {
  const resources = (() => {
    const app = new cdk.App();
    const stack = new DevDeployBrokerStack(app, STACK_NAME, {
      stackName: STACK_NAME,
      env: { account: '822063948773', region: 'ap-northeast-1' },
    });
    return Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;
  })();
  /** Roles and rules whose physical name CloudFormation generates (both capped at 64 characters). */
  const generated = Object.entries(resources)
    .filter(([, r]) => (r.Type === 'AWS::IAM::Role' && r.Properties.RoleName === undefined) || (r.Type === 'AWS::Events::Rule' && r.Properties.Name === undefined))
    .map(([id]) => id);
  const patterns = [...RUNBOOK.matchAll(/`(OpenReception-DevDeployB[A-Za-z]*\*)`/g)].map((m) => m[1]!);

  it('the runbook states a pattern, and the stack has generated roles and rules for it to cover', () => {
    expect(patterns.length).toBeGreaterThan(0);
    expect(generated.filter((id) => resources[id]!.Type === 'AWS::Events::Rule')).toHaveLength(2);
    expect(generated.filter((id) => resources[id]!.Type === 'AWS::IAM::Role').length).toBeGreaterThan(0);
  });

  it.each([12, 13])('🔴 every pattern covers every generated name with a %i-character suffix', (suffixLength) => {
    for (const pattern of patterns) {
      for (const id of generated) {
        const prefix = cfnGeneratedNamePrefix(STACK_NAME, id, { maxLength: 64, suffixLength });
        expect(prefix.startsWith(pattern.slice(0, -1)), `${pattern} vs ${prefix}`).toBe(true);
      }
    }
  });
});

describe('runbook step 3.5a: the GitHub connection', () => {
  it('creates one connection per repo, in the broker region, and records the existing one', () => {
    const create = bashCommands().filter((c) => c.includes('create-connection'));
    expect(create).toHaveLength(1);
    expect(create[0]).toContain('--region ap-northeast-1');
    expect(create[0]).toContain('--connection-name open-reception-github');
    expect(RUNBOOK).toContain('arn:aws:codestar-connections:ap-northeast-1:822063948773:connection/262f84e8-b307-46c8-bafd-e5d5121d01b7');
    expect(RUNBOOK).toContain('**repo ごとに 1 つの接続**');
    expect(RUNBOOK).not.toContain('1 つの接続を共有してよい');
  });
});
