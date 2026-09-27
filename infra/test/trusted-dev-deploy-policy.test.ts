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

  it('denies a production-named stack even when it reuses an approved template (dev-only reach)', () => {
    const assembly = makeAssembly({}, (manifest) => {
      const artifacts = manifest.artifacts as Record<string, unknown>;
      artifacts['OpenReception-Web-prod'] = {
        type: 'aws:cloudformation:stack',
        environment: `aws://${ACCOUNT}/ap-northeast-1`,
        properties: {
          stackName: 'OpenReception-Web-prod',
          templateFile: 'OpenReception-Web-dev.template.json',
        },
      };
    });
    const result = evaluate(assembly);
    expect(result.result).toBe('denied');
    expect(result.violations.map((v) => v.rule)).toContain('STACK_NOT_APPROVED');
  });

  it('fails closed with a non-zero exit and no allow when the account argument is missing or short', () => {
    for (const account of ['', '12345']) {
      expect(() =>
        execFileSync(process.execPath, [POLICY, '--assembly', makeAssembly(), '--account', account], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).toThrow();
    }
  });

  it('denies an approved stack aimed at the wrong account or region', () => {
    const assembly = makeAssembly({}, (manifest) => {
      const artifacts = manifest.artifacts as Record<string, { environment: string }>;
      artifacts['OpenReception-CfMon-dev']!.environment =
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

  it.each([
    ['exact ledger ARN', 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/OpenReception-DevDeployBroker-SparseDeployLedgerABC-XYZ'],
    ['stack prefix wildcard', 'arn:aws:dynamodb:*:123456789012:table/OpenReception-DevDeployBroker-*'],
    ['project wildcard', 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/OpenReception-*'],
    ['any table', 'arn:aws:dynamodb:*:*:table/*'],
    ['single-char wildcard', 'arn:aws:dynamodb:*:*:table/Open?eception-DevDeployBroker-*'],
    ['ledger index/stream', 'arn:aws:dynamodb:*:*:table/*/stream/*'],
    ['intrinsic naming the broker stack', { 'Fn::ImportValue': 'OpenReception-DevDeployBroker-LedgerArn' }],
    ['Fn::Join building a table wildcard', { 'Fn::Join': ['', ['arn:aws:dynamodb:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':table/*']] }],
    ['Fn::Sub building a table wildcard', { 'Fn::Sub': 'arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/*' }],
    ['Fn::Join with a bare wildcard part', { 'Fn::Join': [':', ['arn', 'aws', 'dynamodb', '*', '*', '*']] }],
    ['any dynamodb resource', 'arn:aws:dynamodb:*:*:*'],
    ['table prefix without slash', 'arn:aws:dynamodb:*:*:table*'],
    ['service wildcard', 'arn:aws:dynamo*:*:*:table/*'],
    ['everything', 'arn:*'],
    ['Resource "*"', '*'],
    ['Fn::FindInMap', { 'Fn::FindInMap': ['M', 'k', 'arn'] }],
    ['Ref to a parameter', { Ref: 'LedgerArnParam' }],
    ['Fn::Select / Fn::Split', { 'Fn::Select': [0, { 'Fn::Split': [',', 'arn:aws:dynamodb:*:*:table/*'] }] }],
    ['Fn::ImportValue', { 'Fn::ImportValue': 'SomeExport' }],
    ['dynamic reference', '{{resolve:ssm:/x}}'],
    ['Fn::Sub with a service variable', { 'Fn::Sub': 'arn:${AWS::Partition}:${Svc}:${AWS::Region}:${AWS::AccountId}:*' }],
    ['Fn::Join with a Ref service', { 'Fn::Join': ['', ['arn:aws:', { Ref: 'Svc' }, ':*:*:*']] }],
    ['Fn::Sub of a concrete table', { 'Fn::Sub': 'arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/open-reception-dev' }],
    ['GetAtt of a resource not in this template', { 'Fn::GetAtt': ['ElsewhereTable', 'Arn'] }],
    ['Join of GetAtt with a non-path suffix', { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['AppTable0A1B2C3D', 'Arn'] }, ':*']] }],
  ])('denies candidate IAM that could reach the broker-only sparse ledger: %s (#1153)', (_label, resource) => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        AppTable0A1B2C3D: { Type: 'AWS::DynamoDB::Table', Properties: { BillingMode: 'PAY_PER_REQUEST' } },
        RuntimePolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyDocument: {
              Statement: [{ Effect: 'Allow', Action: ['dynamodb:PutItem'], Resource: [resource] }],
            },
          },
        },
      },
    });
    expect(rules(assembly)).toContain('IAM_REACHES_SPARSE_LEDGER');
  });

  it('does not flag Resource "*" for non-DynamoDB actions (the real ServerFn Cost Explorer statement)', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        ServerFnServiceRoleDefaultPolicyBF3298B4: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyDocument: {
              Statement: [{ Effect: 'Allow', Action: ['ce:GetCostAndUsage', 'ce:GetCostForecast'], Resource: '*' }],
            },
          },
        },
      },
    });
    expect(rules(assembly)).not.toContain('IAM_REACHES_SPARSE_LEDGER');
  });

  it('does not accept Ref / GetAtt of a custom resource (its value is whatever the provider returns)', () => {
    for (const resource of [
      { 'Fn::GetAtt': ['XCr', 'Arn'] },
      { Ref: 'XCr' },
      { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['XCr', 'Arn'] }, '/*']] },
    ]) {
      const assembly = makeAssembly({
        'OpenReception-Web-dev': {
          XCr: { Type: 'Custom::S3AutoDeleteObjects', Properties: { ServiceToken: 'x' } },
          RuntimePolicy: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Action: 'dynamodb:*', Resource: [resource] }] } },
          },
        },
      });
      expect(rules(assembly), JSON.stringify(resource)).toContain('IAM_REACHES_SPARSE_LEDGER');
    }
  });

  it.each([
    ['Fn::If statement', { 'Fn::If': ['Always', { Effect: 'Allow', Action: 'dynamodb:*', Resource: '*' }, { Ref: 'AWS::NoValue' }] }],
    ['Fn::If effect', { Effect: { 'Fn::If': ['C', 'Allow', 'Deny'] }, Action: 'dynamodb:*', Resource: '*' }],
    ['missing effect', { Action: 'dynamodb:*', Resource: '*' }],
  ])('rejects an opaque statement (%s) in standalone and inline policies', (_label, statement) => {
    const standalone = makeAssembly({
      'OpenReception-Web-dev': {
        RuntimePolicy: { Type: 'AWS::IAM::Policy', Properties: { PolicyDocument: { Statement: [statement] } } },
      },
    });
    expect(rules(standalone)).toContain('IAM_POLICY_OPAQUE');
    const inline = makeAssembly({
      'OpenReception-Web-dev': {
        RuntimeRole: {
          Type: 'AWS::IAM::Role',
          Properties: { PermissionsBoundary: 'OpenReceptionClaudeBoundary', Policies: [{ PolicyDocument: { Statement: [statement] } }] },
        },
      },
    });
    expect(rules(inline)).toContain('IAM_POLICY_OPAQUE');
  });

  it.each([
    ['NotAction', { NotAction: 's3:*' }],
    ['action wildcard', { Action: '*' }],
    ['service wildcard', { Action: 'dynamo*' }],
    ['any service', { Action: '*:*' }],
    ['a read action', { Action: 'dynamodb:GetItem' }],
    ['wildcard service with a DynamoDB verb', { Action: ['*:UpdateItem', '*:DeleteItem'] }],
    ['single-char service wildcard', { Action: 'dynamod?:PutItem' }],
    ['non-string action', { Action: [{ Ref: 'A' }] }],
  ])('treats %s as DynamoDB-capable', (_label, action) => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        RuntimePolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', ...action, Resource: '*' }] } },
        },
      },
    });
    expect(rules(assembly)).toContain('IAM_REACHES_SPARSE_LEDGER');
  });

  it('allows only reviewed AWS-managed policies on roles, in every CDK ARN shape', () => {
    const role = (arn: unknown) => ({
      Type: 'AWS::IAM::Role',
      Properties: { PermissionsBoundary: 'OpenReceptionClaudeBoundary', ManagedPolicyArns: [arn] },
    });
    const ok = makeAssembly({
      'OpenReception-Web-dev': {
        A: role('arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'),
        B: role({ 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' }),
        C: role({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']] }),
      },
    });
    expect(rules(ok)).not.toContain('IAM_MANAGED_POLICY_NOT_REVIEWED');
    for (const arn of [
      'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess',
      'arn:aws:iam::123456789012:policy/Custom',
      { Ref: 'PolicyParam' },
    ]) {
      expect(rules(makeAssembly({ 'OpenReception-Web-dev': { R: role(arn) } }))).toContain('IAM_MANAGED_POLICY_NOT_REVIEWED');
    }
  });

  it('denies an Allow with NotResource (it grants everything else, including the ledger)', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        RuntimePolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyDocument: {
              Statement: [{ Effect: 'Allow', Action: ['dynamodb:PutItem'], NotResource: ['arn:aws:dynamodb:*:*:table/nodi-*'] }],
            },
          },
        },
      },
    });
    expect(rules(assembly)).toContain('IAM_NOT_RESOURCE');
  });

  it('checks role inline Policies for ledger reach and NotResource, including carve-out roles', () => {
    const inline = (statement: Record<string, unknown>) => ({
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {},
        PermissionsBoundary: 'arn:aws:iam::123456789012:policy/OpenReceptionClaudeBoundary',
        Policies: [{ PolicyName: 'p', PolicyDocument: { Statement: [statement] } }],
      },
    });
    const reach = makeAssembly({
      'OpenReception-Web-dev': {
        RuntimeRole: inline({ Effect: 'Allow', Action: 'dynamodb:PutItem', Resource: 'arn:aws:dynamodb:*:*:table/*' }),
        CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092: inline({ Effect: 'Allow', Action: 'dynamodb:PutItem', Resource: '*' }),
      },
    });
    const violations = evaluate(reach).violations as Array<{ rule: string; resource: string }>;
    const ledger = violations.filter((v) => v.rule === 'IAM_REACHES_SPARSE_LEDGER').map((v) => v.resource).sort();
    expect(ledger).toEqual(['CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092', 'RuntimeRole']);
    const notResource = makeAssembly({
      'OpenReception-Web-dev': { RuntimeRole: inline({ Effect: 'Allow', Action: 's3:GetObject', NotResource: 'x' }) },
    });
    expect(rules(notResource)).toContain('IAM_NOT_RESOURCE');
    const opaque = makeAssembly({
      'OpenReception-Web-dev': {
        RuntimeRole: { Type: 'AWS::IAM::Role', Properties: { PermissionsBoundary: 'OpenReceptionClaudeBoundary', Policies: [{ PolicyDocument: { 'Fn::If': [] } }] } },
      },
    });
    expect(rules(opaque)).toContain('IAM_POLICY_OPAQUE');
  });

  it.each([
    ['the app table by name', 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/open-reception-dev'],
    ['the app table index', 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/open-reception-dev/index/*'],
    ['a stack-local GetAtt (CDK grant shape)', { 'Fn::GetAtt': ['AppTable0A1B2C3D', 'Arn'] }],
    ['a stack-local Ref', { Ref: 'AppTable0A1B2C3D' }],
    ['an app-table index via Fn::Join (CDK grant shape)', { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['AppTable0A1B2C3D', 'Arn'] }, '/index/*']] }],
    ['an S3 object wildcard', 'arn:aws:s3:::open-reception-dev-assets/*'],
  ])('does not flag the product table: %s', (_label, resource) => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        AppTable0A1B2C3D: { Type: 'AWS::DynamoDB::Table', Properties: { BillingMode: 'PAY_PER_REQUEST' } },
        RuntimePolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyDocument: {
              Statement: [{ Effect: 'Allow', Action: ['dynamodb:PutItem'], Resource: [resource] }],
            },
          },
        },
      },
    });
    expect(rules(assembly)).not.toContain('IAM_REACHES_SPARSE_LEDGER');
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

  it('allows the reviewed dev Lambda concurrency ceilings', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        ServerFn4F3A536E: {
          Type: 'AWS::Lambda::Function',
          Properties: { MemorySize: 1024, ReservedConcurrentExecutions: 5 },
        },
        ImageFnCD541B83: {
          Type: 'AWS::Lambda::Function',
          Properties: { MemorySize: 1536, ReservedConcurrentExecutions: 2 },
        },
      },
    });
    const result = evaluate(assembly);
    expect(result.result).toBe('allowed');
    expect(result.violations).toEqual([]);
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
      artifacts['OpenReception-Web-dev']!.properties.templateFile = '../outside.json';
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
