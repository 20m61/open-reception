import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const POLICY = resolve(__dirname, '../broker/trusted-policy.mjs');
const ACCOUNT = '123456789012';
const roots: string[] = [];

type Resource = {
  Type: string;
  Properties?: Record<string, unknown>;
};

const stackRegions: Record<string, string> = {
  'OpenReception-Web-dev': 'ap-northeast-1',
  'OpenReception-WebMonitoring-dev': 'ap-northeast-1',
  'OpenReception-CfMon-dev': 'us-east-1',
};

const makeAssembly = (
  resourcesByStack: Partial<Record<keyof typeof stackRegions, Record<string, Resource>>> = {},
  mutateManifest?: (manifest: Record<string, unknown>) => void,
): string => {
  const root = mkdtempSync(join(tmpdir(), 'or-broker-policy-'));
  roots.push(root);

  const artifacts: Record<string, unknown> = {};
  for (const [stackName, region] of Object.entries(stackRegions)) {
    const file = `${stackName}.template.json`;
    writeFileSync(
      join(root, file),
      JSON.stringify({ Resources: resourcesByStack[stackName] ?? {} }, null, 2),
    );
    artifacts[stackName] = {
      type: 'aws:cloudformation:stack',
      environment: `aws://${ACCOUNT}/${region}`,
      properties: { stackName, templateFile: file },
    };
  }
  const manifest: Record<string, unknown> = { version: '39.0.0', artifacts };
  mutateManifest?.(manifest);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return root;
};

const evaluate = (assembly: string): { result: string; violations: Array<{ rule: string }> } => {
  try {
    const stdout = execFileSync(
      process.execPath,
      [POLICY, '--assembly', assembly, '--account', ACCOUNT],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(stdout) as { result: string; violations: Array<{ rule: string }> };
  } catch (error) {
    const failure = error as { stdout?: string | Buffer };
    const stdout = failure.stdout?.toString() ?? '';
    if (!stdout) throw error;
    return JSON.parse(stdout) as { result: string; violations: Array<{ rule: string }> };
  }
};

const rules = (assembly: string): string[] => evaluate(assembly).violations.map((v) => v.rule);

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('trusted dev-deploy cloud assembly policy (#1146)', () => {
  it('allows the reviewed three-stack envelope when no resource violates policy', () => {
    const result = evaluate(makeAssembly());
    expect(result.result).toBe('allowed');
    expect(result.violations).toEqual([]);
  });

  it('denies a foreign stack before any AWS mutation', () => {
    const assembly = makeAssembly({}, (manifest) => {
      const artifacts = manifest.artifacts as Record<string, unknown>;
      artifacts['OpenReception-RealtimeRuntime-dev'] = {
        type: 'aws:cloudformation:stack',
        environment: `aws://${ACCOUNT}/ap-northeast-1`,
        properties: {
          stackName: 'OpenReception-RealtimeRuntime-dev',
          templateFile: 'OpenReception-Web-dev.template.json',
        },
      };
    });
    expect(rules(assembly)).toContain('STACK_NOT_APPROVED');
  });

  it('denies an approved stack aimed at the wrong account or region', () => {
    const assembly = makeAssembly({}, (manifest) => {
      const artifacts = manifest.artifacts as Record<string, { environment: string }>;
      artifacts['OpenReception-CfMon-dev'].environment =
        'aws://999999999999/ap-northeast-1';
    });
    expect(rules(assembly)).toContain('STACK_ENVIRONMENT_MISMATCH');
  });

  it('routes fixed-cost NAT Gateway and persistent compute to a human gate', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        Nat: { Type: 'AWS::EC2::NatGateway' },
        Instance: { Type: 'AWS::EC2::Instance' },
      },
    });
    expect(rules(assembly).filter((rule) => rule === 'RESOURCE_TYPE_HUMAN_GATE')).toHaveLength(2);
  });

  it('denies unknown CloudFormation resource types by default', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        Surprise: { Type: 'AWS::MadeUp::ExpensiveThing' },
      },
    });
    expect(rules(assembly)).toContain('RESOURCE_TYPE_NOT_APPROVED');
  });

  it('requires the permissions boundary on ordinary IAM roles but preserves reviewed CDK carve-outs', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        UnsafeRole: {
          Type: 'AWS::IAM::Role',
          Properties: { AssumeRolePolicyDocument: { Statement: [] } },
        },
        CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092: {
          Type: 'AWS::IAM::Role',
          Properties: { AssumeRolePolicyDocument: { Statement: [] } },
        },
      },
    });
    const resultRules = rules(assembly);
    expect(resultRules.filter((rule) => rule === 'IAM_BOUNDARY_REQUIRED')).toHaveLength(1);
  });

  it('denies unscoped IAM writes and runtime self-trigger actions', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        RuntimePolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyDocument: {
              Statement: [
                {
                  Effect: 'Allow',
                  Action: ['lambda:InvokeFunction', 's3:PutObject'],
                  Resource: '*',
                },
              ],
            },
          },
        },
      },
    });
    const resultRules = rules(assembly);
    expect(resultRules).toContain('IAM_LOOP_CAPABLE_ACTION');
    expect(resultRules).toContain('IAM_UNSCOPED_RESOURCE');
  });

  it('requires bounded reserved concurrency for the two product Lambdas', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        ServerFn4F3A536E: {
          Type: 'AWS::Lambda::Function',
          Properties: { MemorySize: 1024 },
        },
        ImageFnCD541B83: {
          Type: 'AWS::Lambda::Function',
          Properties: { MemorySize: 1536, ReservedConcurrentExecutions: 3 },
        },
      },
    });
    const resultRules = rules(assembly);
    expect(resultRules).toContain('LAMBDA_CONCURRENCY_REQUIRED');
    expect(resultRules).toContain('LAMBDA_CONCURRENCY_TOO_HIGH');
  });

  it('requires DynamoDB on-demand billing and forbids provisioned throughput', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        Table: {
          Type: 'AWS::DynamoDB::Table',
          Properties: {
            BillingMode: 'PROVISIONED',
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          },
        },
      },
    });
    const resultRules = rules(assembly);
    expect(resultRules).toContain('DYNAMODB_ON_DEMAND_REQUIRED');
    expect(resultRules).toContain('DYNAMODB_PROVISIONED_FORBIDDEN');
  });

  it('requires all S3 public-access-block flags', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              BlockPublicPolicy: false,
              IgnorePublicAcls: true,
              RestrictPublicBuckets: true,
            },
          },
        },
      },
    });
    expect(rules(assembly)).toContain('S3_PUBLIC_BLOCK_REQUIRED');
  });

  it('denies an unreviewed Function URL and changes to the reviewed target/auth shape', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        UnknownUrl: {
          Type: 'AWS::Lambda::Url',
          Properties: { AuthType: 'NONE', TargetFunctionArn: { Ref: 'OtherFn' } },
        },
        ServerFnFunctionUrlFFF9E3E1: {
          Type: 'AWS::Lambda::Url',
          Properties: { AuthType: 'AWS_IAM', TargetFunctionArn: { Ref: 'OtherFn' } },
        },
      },
    });
    const resultRules = rules(assembly);
    expect(resultRules).toContain('FUNCTION_URL_NOT_REVIEWED');
    expect(resultRules).toContain('FUNCTION_URL_AUTH_CHANGED');
    expect(resultRules).toContain('FUNCTION_URL_TARGET_CHANGED');
  });

  it('denies template paths that escape the cloud assembly', () => {
    const assembly = makeAssembly({}, (manifest) => {
      const artifacts = manifest.artifacts as Record<
        string,
        { properties: { templateFile: string } }
      >;
      artifacts['OpenReception-Web-dev'].properties.templateFile = '../outside.json';
    });
    expect(rules(assembly)).toContain('TEMPLATE_PATH_INVALID');
  });

  it('denies excessive counts even when each resource type is otherwise approved', () => {
    const buckets: Record<string, Resource> = {};
    for (let i = 0; i < 5; i += 1) {
      buckets[`Bucket${i}`] = {
        Type: 'AWS::S3::Bucket',
        Properties: {
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
        },
      };
    }
    expect(rules(makeAssembly({ 'OpenReception-Web-dev': buckets }))).toContain(
      'RESOURCE_COUNT_EXCEEDED',
    );
  });
});
