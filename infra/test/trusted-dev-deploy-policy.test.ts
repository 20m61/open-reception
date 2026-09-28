import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

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
      properties: {
        stackName,
        templateFile: file,
        assumeRoleArn: `arn:\${AWS::Partition}:iam::${ACCOUNT}:role/cdk-orcloud01-deploy-role-${ACCOUNT}-${region}`,
        cloudFormationExecutionRoleArn: `arn:\${AWS::Partition}:iam::${ACCOUNT}:role/cdk-orcloud01-cfn-exec-role-${ACCOUNT}-${region}`,
      },
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

/** The AWS CLI layer zip of the real assembly is `@aws-cdk/asset-awscli-v1`'s `lib/layer.zip` (21 MB, not committed). */
const AWSCLI_LAYER_ASSET = 'asset.a72522445441e9b66c2f16956c54d4786af8c61c156b80c48a6e7c32fcc49023.zip';
const AWSCLI_LAYER_ZIP = resolve(__dirname, '../node_modules/@aws-cdk/asset-awscli-v1/lib/layer.zip');

/** Copy the pinned provider code directories of the real fixture (byte-exact) and the layer zip into a copy. */
const copyAssetDirs = (from: string, to: string) => {
  for (const name of readdirSync(from).filter((n) => n.startsWith('asset.'))) cpSync(join(from, name), join(to, name), { recursive: true });
  cpSync(AWSCLI_LAYER_ZIP, join(to, AWSCLI_LAYER_ASSET));
};

/** A role with exactly the reviewed shape: Lambda trust, this account's boundary, basic execution. */
const reviewedLambdaRole = (): Resource => ({
  Type: 'AWS::IAM::Role',
  Properties: {
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
    },
    PermissionsBoundary: {
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::${ACCOUNT}:policy/OpenReceptionClaudeBoundary`]],
    },
    ManagedPolicyArns: [{ 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' }],
  },
});

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

  it('requires the exact permissions boundary on ordinary IAM roles; a carve-out id alone exempts nothing', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        UnsafeRole: {
          Type: 'AWS::IAM::Role',
          Properties: { AssumeRolePolicyDocument: { Statement: [] } },
        },
        // Reviewed carve-out id, but not the reviewed shape (no AWSLambdaBasicExecutionRole): boundary required.
        CustomCrossRegionExportWriterCustomResourceProviderRoleC951B1E1: {
          Type: 'AWS::IAM::Role',
          Properties: { AssumeRolePolicyDocument: { Statement: [] } },
        },
        // Former carve-out id: the real CDK role carries the boundary, so it has no exemption any more.
        CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092: {
          Type: 'AWS::IAM::Role',
          Properties: { AssumeRolePolicyDocument: { Statement: [] } },
        },
      },
    });
    const resultRules = rules(assembly);
    expect(resultRules.filter((rule) => rule === 'IAM_BOUNDARY_REQUIRED')).toHaveLength(3);
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
    ['IAM policy variable in the table name', 'arn:aws:dynamodb:*:*:table/${aws:PrincipalTag/t}'],
    ['glob on the real ledger hash', 'arn:aws:dynamodb:*:*:table/*Ledger9F8E7D6C*'],
    ['glob on a ledger name prefix', 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/OpenRecep*'],
    ['exact real ledger name', 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/OpenReception-DevDeployBroker-SparseDeployLedger9F8E7D6C-1XYZ'],
    ['resource-part glob on the real hash', 'arn:aws:dynamodb:*:*:*Ledger9F8E7D6C*'],
    ['bare real hash', 'arn:aws:dynamodb:*:*:*9F8E7D6C*'],
    ['mangled table literal', 'arn:aws:dynamodb:*:*:t?ble/*Ledger9F8E7D6C*'],
    ['any type prefix', 'arn:aws:dynamodb:*:*:*/*Ledger9F8E7D6C*'],
    ['table glob without slash', 'arn:aws:dynamodb:*:*:table*9F8E7D6C*'],
    ['partial table literal', 'arn:aws:dynamodb:*:*:*able/Open*9F8E7D6C*'],
    ['service glob and hash', 'arn:aws:dynamo*:*:*:*9F8E7D6C*'],
    ['stream under hash glob', 'arn:aws:dynamodb:*:*:*9F8E7D6C*/stream/*'],
    ['short ARN', 'arn:aws:dynamodb:*9F8E7D6C*'],
    ['upper-case partition', 'arn:AWS:dynamodb:*:*:table/*'],
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

  it('a DynamoDB-capable action on a non-DynamoDB ARN does not reach the ledger', () => {
    const assembly = makeAssembly({
      'OpenReception-Web-dev': {
        RuntimePolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyDocument: {
              Statement: [{ Effect: 'Allow', Action: '*', Resource: ['arn:aws:logs:*:*:*', 'arn:aws:s3:::open-reception-dev-assets/*'] }],
            },
          },
        },
      },
    });
    expect(rules(assembly)).not.toContain('IAM_REACHES_SPARSE_LEDGER');
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
    ['an app table glob anchored to a non-ledger prefix', 'arn:aws:dynamodb:*:*:table/open-reception-dev*'],
    ['an app table index glob', 'arn:aws:dynamodb:*:*:table/open-reception-dev/index/*'],
    ['a table name that only shares letters', 'arn:aws:dynamodb:*:*:table/OpenReception-Web-*'],
    ['an SSM parameter wildcard', 'arn:aws:ssm:ap-northeast-1:123456789012:parameter/open-reception/dev/sites/*'],
    ['an exact table whose name is a strict prefix of the ledger name', 'arn:aws:dynamodb:*:*:table/OpenReception-DevDeploy'],
    ['another partition', 'arn:aws-cn:dynamodb:*:*:table/*'],
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
        FnRole: reviewedLambdaRole(),
        ServerFn4F3A536E: {
          Type: 'AWS::Lambda::Function',
          Properties: { MemorySize: 1024, ReservedConcurrentExecutions: 5, Role: { 'Fn::GetAtt': ['FnRole', 'Arn'] } },
        },
        ImageFnCD541B83: {
          Type: 'AWS::Lambda::Function',
          Properties: { MemorySize: 1536, ReservedConcurrentExecutions: 2, Role: { 'Fn::GetAtt': ['FnRole', 'Arn'] } },
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

/*
 * Phase 2 pre-arming blocker 1 (docs/architecture/aws-dev-deploy-broker.md): shapes the policy
 * used to let through. Each case is a single resource change on top of an otherwise clean
 * assembly, and each reviewed counterpart (the shape the real dev assembly uses) stays clean.
 */
describe('trusted policy v2: pre-arming blocker 1 (#1146)', () => {
  const REAL = resolve(__dirname, 'fixtures/real-dev-assembly');
  const roleArn = (id: string) => ({ 'Fn::GetAtt': [id, 'Arn'] });
  const web = (resources: Record<string, Resource>) => makeAssembly({ 'OpenReception-Web-dev': resources });
  const allow = (statement: Record<string, unknown>) => ({ Effect: 'Allow', ...statement });
  const policyOn = (roleId: string, statements: unknown[]): Resource => ({
    Type: 'AWS::IAM::Policy',
    Properties: { PolicyDocument: { Statement: statements }, Roles: [{ Ref: roleId }] },
  });

  it('the real dev assembly (credential-free synth, main 78bdb01) is allowed once its layer zip is present', () => {
    const copy = mkdtempSync(join(tmpdir(), 'or-broker-real0-'));
    roots.push(copy);
    cpSync(REAL, copy, { recursive: true });
    // Without the layer zip (it is not committed), the pinned layer cannot be verified: denied.
    const without = evaluate(copy) as { result: string; policyVersion: number; violations: Array<{ rule: string; resource: string }> };
    expect(without.policyVersion).toBe(2);
    expect(without.violations.map((v) => `${v.rule}:${v.resource}`)).toEqual(['LAYER_NOT_REVIEWED:AssetDeploymentAwsCliLayerC0B4D779']);
    cpSync(AWSCLI_LAYER_ZIP, join(copy, AWSCLI_LAYER_ASSET));
    expect(evaluate(copy)).toMatchObject({ result: 'allowed', violations: [] });
  });

  it('the real dev assembly aimed at another account is denied on every account-bound field', () => {
    let stdout = '';
    try {
      execFileSync(process.execPath, [POLICY, '--assembly', REAL, '--account', '999999999999'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      stdout = String((error as { stdout?: string }).stdout ?? '');
    }
    const found = new Set((JSON.parse(stdout) as { violations: Array<{ rule: string }> }).violations.map((v) => v.rule));
    for (const rule of ['STACK_ENVIRONMENT_MISMATCH', 'MANIFEST_FOREIGN_ACCOUNT', 'IAM_BOUNDARY_REQUIRED']) {
      expect(found, rule).toContain(rule);
    }
  });

  describe('role trust policy', () => {
    const roleWithTrust = (statement: Record<string, unknown>) => {
      const role = reviewedLambdaRole();
      (role.Properties as Record<string, unknown>).AssumeRolePolicyDocument = { Statement: [statement] };
      return web({ R: role });
    };

    it('accepts the reviewed Lambda service trust', () => {
      expect(rules(web({ R: reviewedLambdaRole() }))).toEqual([]);
    });

    it.each([
      ['foreign account root', { Principal: { AWS: 'arn:aws:iam::999999999999:root' }, Action: 'sts:AssumeRole' }],
      ['same-account root (admin trust)', { Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: 'sts:AssumeRole' }],
      ['AWS *', { Principal: { AWS: '*' }, Action: 'sts:AssumeRole' }],
      ['bare *', { Principal: '*', Action: 'sts:AssumeRole' }],
      ['federated', { Principal: { Federated: 'cognito-identity.amazonaws.com' }, Action: 'sts:AssumeRoleWithWebIdentity' }],
      ['another service', { Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      ['service plus account', { Principal: { Service: 'lambda.amazonaws.com', AWS: 'arn:aws:iam::999999999999:root' }, Action: 'sts:AssumeRole' }],
      ['NotPrincipal', { NotPrincipal: { AWS: 'arn:aws:iam::999999999999:root' }, Action: 'sts:AssumeRole' }],
      ['wildcard action', { Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:*' }],
      ['NotAction', { Principal: { Service: 'lambda.amazonaws.com' }, NotAction: 'sts:TagSession' }],
      ['intrinsic principal', { Principal: { AWS: { Ref: 'TrustedAccount' } }, Action: 'sts:AssumeRole' }],
    ])('denies %s', (_label, statement) => {
      expect(rules(roleWithTrust(allow(statement)))).toContain('IAM_TRUST_NOT_REVIEWED');
    });

    it('denies an opaque trust document', () => {
      const role = reviewedLambdaRole();
      (role.Properties as Record<string, unknown>).AssumeRolePolicyDocument = { 'Fn::If': ['C', {}, {}] };
      expect(rules(web({ R: role }))).toContain('IAM_TRUST_NOT_REVIEWED');
    });
  });

  describe('permissions boundary is an exact ARN, not a substring', () => {
    const withBoundary = (boundary: unknown) => {
      const role = reviewedLambdaRole();
      (role.Properties as Record<string, unknown>).PermissionsBoundary = boundary;
      return rules(web({ R: role }));
    };

    it.each([
      ['literal', `arn:aws:iam::${ACCOUNT}:policy/OpenReceptionClaudeBoundary`],
      ['Sub with pseudo parameters', { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/OpenReceptionClaudeBoundary' }],
      ['Join with AccountId', { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, ':policy/OpenReceptionClaudeBoundary']] }],
    ])('accepts %s', (_label, boundary) => {
      expect(withBoundary(boundary)).not.toContain('IAM_BOUNDARY_REQUIRED');
    });

    it.each([
      ['bare name', 'OpenReceptionClaudeBoundary'],
      ['foreign account', 'arn:aws:iam::999999999999:policy/OpenReceptionClaudeBoundary'],
      ['longer name', `arn:aws:iam::${ACCOUNT}:policy/OpenReceptionClaudeBoundaryWeak`],
      ['different path', `arn:aws:iam::${ACCOUNT}:policy/x/OpenReceptionClaudeBoundary`],
      ['name in a parameter default', { Ref: 'BoundaryParam' }],
      ['Sub with another variable', { 'Fn::Sub': 'arn:aws:iam::${Acct}:policy/OpenReceptionClaudeBoundary' }],
      ['missing', undefined],
    ])('denies %s', (_label, boundary) => {
      expect(withBoundary(boundary)).toContain('IAM_BOUNDARY_REQUIRED');
    });
  });

  describe('identity / trust / stack actions', () => {
    it.each([
      ['iam:PassRole on a role pattern', { Action: 'iam:PassRole', Resource: 'arn:aws:iam::*:role/*' }],
      ['sts:AssumeRole on a named deploy role', { Action: 'sts:AssumeRole', Resource: `arn:aws:iam::${ACCOUNT}:role/OpenReceptionClaudeDeploy-dev` }],
      ['cloudformation:* on a stack pattern', { Action: 'cloudformation:*', Resource: 'arn:aws:cloudformation:*:*:stack/*' }],
      ['glob service', { Action: 'i*:*', Resource: 'arn:aws:s3:::x' }],
      ['wildcard service verb', { Action: '*:PassRole', Resource: 'arn:aws:s3:::x' }],
      ['iam:CreateRole even on a local role', { Action: 'iam:CreateRole', Resource: roleArn('R') }],
      ['iam:PassRole on a local role plus a pattern', { Action: 'iam:PassRole', Resource: [roleArn('R'), 'arn:aws:iam::*:role/*'] }],
      ['organizations', { Action: 'organizations:LeaveOrganization', Resource: 'arn:aws:organizations::x' }],
      ['non-string action', { Action: [{ Ref: 'A' }], Resource: 'arn:aws:s3:::x' }],
    ])('denies %s', (_label, statement) => {
      expect(rules(web({ R: reviewedLambdaRole(), P: policyOn('R', [allow(statement)]) }))).toContain('IAM_CONTROL_PLANE_ACTION');
    });

    it('accepts iam:PassRole of a role declared in the same template', () => {
      expect(rules(web({ R: reviewedLambdaRole(), P: policyOn('R', [allow({ Action: 'iam:PassRole', Resource: roleArn('R') })]) }))).toEqual([]);
    });

    it('denies NotAction in standalone and inline policies', () => {
      const statement = allow({ NotAction: 's3:*', Resource: 'arn:aws:s3:::x' });
      expect(rules(web({ R: reviewedLambdaRole(), P: policyOn('R', [statement]) }))).toContain('IAM_NOT_ACTION');
      const role = reviewedLambdaRole();
      (role.Properties as Record<string, unknown>).Policies = [{ PolicyName: 'i', PolicyDocument: { Statement: [statement] } }];
      expect(rules(web({ R: role }))).toContain('IAM_NOT_ACTION');
    });
  });

  it('reviews role inline policies like standalone policies', () => {
    const role = reviewedLambdaRole();
    (role.Properties as Record<string, unknown>).Policies = [
      { PolicyName: 'i', PolicyDocument: { Statement: [allow({ Action: ['s3:PutObject', 'lambda:InvokeFunction'], Resource: '*' })] } },
    ];
    const found = rules(web({ R: role }));
    expect(found).toContain('IAM_UNSCOPED_RESOURCE');
    expect(found).toContain('IAM_LOOP_CAPABLE_ACTION');
  });

  it('denies a standalone policy attached to a role, user or group outside the template', () => {
    for (const props of [
      { Roles: ['OpenReceptionClaudeDeploy-dev'] },
      { Roles: [{ Ref: 'RoleNameParam' }] },
      { Roles: [{ Ref: 'R' }], Users: ['someone'] },
      { Groups: ['admins'] },
    ]) {
      const policy: Resource = {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyDocument: { Statement: [allow({ Action: 's3:GetObject', Resource: 'arn:aws:s3:::x/*' })] }, ...props },
      };
      expect(rules(web({ R: reviewedLambdaRole(), P: policy })), JSON.stringify(props)).toContain('IAM_POLICY_ATTACHMENT_NOT_LOCAL');
    }
  });

  describe('CDK carve-out roles are exempt only in their reviewed shape', () => {
    const WRITER = 'CustomCrossRegionExportWriterCustomResourceProviderRoleC951B1E1';
    const writer = (overrides: Record<string, unknown> = {}): Resource => ({
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: { Statement: [allow({ Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } })] },
        ManagedPolicyArns: [{ 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' }],
        Policies: [
          {
            PolicyName: 'Inline',
            PolicyDocument: {
              Statement: [
                allow({
                  Action: ['ssm:DeleteParameters', 'ssm:ListTagsForResource', 'ssm:GetParameters', 'ssm:PutParameter'],
                  Resource: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:ssm:us-east-1:${ACCOUNT}:parameter/cdk/exports/*`]] }],
                }),
              ],
            },
          },
        ],
        ...overrides,
      },
    });
    const inline = (statement: Record<string, unknown>) => ({ Policies: [{ PolicyName: 'Inline', PolicyDocument: { Statement: [allow(statement)] } }] });

    it('accepts the real writer shape without a boundary', () => {
      expect(rules(web({ [WRITER]: writer() }))).toEqual([]);
    });

    it.each([
      ['an extra action', inline({ Action: ['ssm:PutParameter', 's3:GetObject'], Resource: `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/cdk/exports/x` })],
      ['another parameter path', inline({ Action: 'ssm:PutParameter', Resource: `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/other/*` })],
      ['another account', inline({ Action: 'ssm:PutParameter', Resource: 'arn:aws:ssm:us-east-1:999999999999:parameter/cdk/exports/*' })],
      ['a wildcard resource', inline({ Action: 'ssm:PutParameter', Resource: '*' })],
      ['a condition', inline({ Action: 'ssm:PutParameter', Resource: `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/cdk/exports/x`, Condition: { Bool: { x: 'true' } } })],
      ['an extra managed policy', { ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole', 'arn:aws:iam::aws:policy/AdministratorAccess'] }],
      ['no managed policy', { ManagedPolicyArns: [] }],
      ['foreign trust', { AssumeRolePolicyDocument: { Statement: [allow({ Action: 'sts:AssumeRole', Principal: { AWS: 'arn:aws:iam::999999999999:root' } })] } }],
    ])('requires the boundary once the writer carries %s', (_label, overrides) => {
      expect(rules(web({ [WRITER]: writer(overrides) }))).toContain('IAM_BOUNDARY_REQUIRED');
    });

    it('requires the boundary when a standalone policy is attached to the carve-out', () => {
      expect(rules(web({ [WRITER]: writer(), P: policyOn(WRITER, [allow({ Action: 's3:GetObject', Resource: 'arn:aws:s3:::x/*' })]) }))).toContain('IAM_BOUNDARY_REQUIRED');
    });
  });

  it('denies a template Transform or an Fn::Transform anywhere', () => {
    const top = makeAssembly();
    const file = join(top, 'OpenReception-Web-dev.template.json');
    writeFileSync(file, JSON.stringify({ Transform: 'AWS::Serverless-2016-10-31', Resources: {} }));
    expect(rules(top)).toContain('TEMPLATE_TRANSFORM');
    const nested = web({
      B: {
        Type: 'AWS::S3::Bucket',
        Properties: { 'Fn::Transform': { Name: 'AWS::Include', Parameters: { Location: 's3://x/y' } } },
      },
    });
    expect(rules(nested)).toContain('TEMPLATE_TRANSFORM');
  });

  describe('cloud-assembly manifest', () => {
    it.each([
      ['assumeRoleArn', { assumeRoleArn: 'arn:${AWS::Partition}:iam::999999999999:role/cdk-orcloud01-deploy-role-999999999999-ap-northeast-1' }],
      ['cloudFormationExecutionRoleArn', { cloudFormationExecutionRoleArn: 'arn:aws:iam::999999999999:role/admin' }],
      ['lookupRole', { lookupRole: { arn: 'arn:aws:iam::999999999999:role/lookup' } }],
      ['template asset URL', { stackTemplateAssetObjectUrl: 's3://cdk-orcloud01-assets-999999999999-ap-northeast-1/x.json' }],
    ])('denies a foreign account in the stack %s', (_label, extra) => {
      const assembly = makeAssembly({}, (manifest) => {
        const artifacts = manifest.artifacts as Record<string, { properties: Record<string, unknown> }>;
        Object.assign(artifacts['OpenReception-Web-dev']!.properties, extra);
      });
      expect(rules(assembly)).toContain('MANIFEST_FOREIGN_ACCOUNT');
    });

    it('accepts the target account and the ${AWS::AccountId} placeholder', () => {
      const assembly = makeAssembly({}, (manifest) => {
        const artifacts = manifest.artifacts as Record<string, { properties: Record<string, unknown> }>;
        Object.assign(artifacts['OpenReception-Web-dev']!.properties, {
          assumeRoleArn: `arn:\${AWS::Partition}:iam::${ACCOUNT}:role/cdk-orcloud01-deploy-role-${ACCOUNT}-ap-northeast-1`,
          cloudFormationExecutionRoleArn: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-orcloud01-cfn-exec-role-${AWS::AccountId}-ap-northeast-1',
        });
      });
      expect(rules(assembly)).toEqual([]);
    });

    const withAssetManifest = (content: string | null, file = 'OpenReception-Web-dev.assets.json') =>
      makeAssembly({}, (manifest) => {
        const artifacts = manifest.artifacts as Record<string, unknown>;
        artifacts['OpenReception-Web-dev.assets'] = { type: 'cdk:asset-manifest', properties: { file } };
        const root = roots[roots.length - 1]!;
        if (content !== null) writeFileSync(join(root, 'OpenReception-Web-dev.assets.json'), content);
      });

    it('denies an asset destination in another account and an unreadable or escaping asset manifest', () => {
      const foreign = {
        version: '54.0.0',
        files: {
          a: {
            source: { path: 'asset.a', packaging: 'zip' },
            destinations: {
              '999999999999-ap-northeast-1': {
                bucketName: 'cdk-orcloud01-assets-999999999999-ap-northeast-1',
                objectKey: 'a.zip',
                assumeRoleArn: 'arn:${AWS::Partition}:iam::999999999999:role/cdk-orcloud01-file-publishing-role',
              },
            },
          },
        },
      };
      expect(rules(withAssetManifest(JSON.stringify(foreign)))).toContain('MANIFEST_FOREIGN_ACCOUNT');
      expect(rules(withAssetManifest(null))).toContain('ASSET_MANIFEST_INVALID');
      expect(rules(withAssetManifest('not json'))).toContain('ASSET_MANIFEST_INVALID');
      expect(rules(withAssetManifest('{}', '../x.assets.json'))).toContain('ASSET_MANIFEST_INVALID');
    });

    it('does not read an account id out of a hex asset hash', () => {
      const hash = 'ab123456789012cd'.padEnd(64, 'e');
      const own = {
        version: '54.0.0',
        files: {
          [hash]: {
            source: { path: `asset.${hash}`, packaging: 'zip' },
            destinations: {
              [`${ACCOUNT}-ap-northeast-1`]: {
                bucketName: `cdk-orcloud01-assets-${ACCOUNT}-ap-northeast-1`,
                objectKey: `${hash}.zip`,
                region: 'ap-northeast-1',
                assumeRoleArn: `arn:\${AWS::Partition}:iam::${ACCOUNT}:role/cdk-orcloud01-file-publishing-role-${ACCOUNT}-ap-northeast-1`,
              },
            },
          },
        },
      };
      expect(rules(withAssetManifest(JSON.stringify(own)))).toEqual([]);
    });

    it.each([
      ['a nested cloud assembly', { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-X' } }, 'NESTED_ASSEMBLY'],
      ['an unknown artifact type', { type: 'cdk:made-up' }, 'ARTIFACT_TYPE_NOT_REVIEWED'],
      ['a non-object artifact', 'x', 'ARTIFACT_TYPE_NOT_REVIEWED'],
    ])('denies %s', (_label, artifact, rule) => {
      const assembly = makeAssembly({}, (manifest) => {
        (manifest.artifacts as Record<string, unknown>).Extra = artifact;
      });
      expect(rules(assembly)).toContain(rule);
    });
  });

  describe('Lambda execution role, layers and custom-resource providers are local', () => {
    const fn = (props: Record<string, unknown>): Resource => ({ Type: 'AWS::Lambda::Function', Properties: props });

    it.each([
      ['a literal existing role ARN', `arn:aws:iam::${ACCOUNT}:role/OpenReceptionClaudeDeploy-dev`],
      ['a parameter', { Ref: 'RoleArnParam' }],
      ['an import', { 'Fn::ImportValue': 'SomeRoleArn' }],
      ['GetAtt of a non-role', { 'Fn::GetAtt': ['B', 'Arn'] }],
      ['GetAtt of a role but not its Arn', { 'Fn::GetAtt': ['R', 'RoleId'] }],
    ])('denies an execution role given as %s', (_label, role) => {
      const b: Resource = { Type: 'AWS::S3::Bucket', Properties: {} };
      expect(rules(web({ R: reviewedLambdaRole(), B: b, F: fn({ Role: role }) }))).toContain('LAMBDA_ROLE_NOT_LOCAL');
    });

    it('denies a layer that is not declared in the template', () => {
      expect(rules(web({ R: reviewedLambdaRole(), F: fn({ Role: roleArn('R'), Layers: ['arn:aws:lambda:ap-northeast-1:999999999999:layer:x:1'] }) }))).toContain('LAMBDA_LAYER_NOT_LOCAL');
    });

    it.each([
      ['a literal foreign function', 'arn:aws:lambda:ap-northeast-1:999999999999:function:x'],
      ['an SNS topic', 'arn:aws:sns:ap-northeast-1:999999999999:t'],
      ['GetAtt of a role', roleArn('R')],
      ['Ref of the function (name, not ARN)', { Ref: 'F' }],
    ])('denies a custom resource whose ServiceToken is %s', (_label, token) => {
      const custom: Resource = { Type: 'Custom::S3AutoDeleteObjects', Properties: { ServiceToken: token } };
      expect(rules(web({ R: reviewedLambdaRole(), F: fn({ Role: roleArn('R') }), C: custom }))).toContain('CUSTOM_RESOURCE_PROVIDER_NOT_LOCAL');
    });

    it('accepts a custom resource whose ServiceToken is a local provider function', () => {
      const custom: Resource = { Type: 'Custom::CDKBucketDeployment', Properties: { ServiceToken: { 'Fn::GetAtt': ['F', 'Arn'] } } };
      expect(rules(web({ R: reviewedLambdaRole(), F: fn({ Role: roleArn('R') }), C: custom }))).toEqual([]);
    });

    it('a custom type with a pinned provider must use that provider', () => {
      const custom: Resource = { Type: 'Custom::S3AutoDeleteObjects', Properties: { ServiceToken: { 'Fn::GetAtt': ['F', 'Arn'] } } };
      expect(rules(web({ R: reviewedLambdaRole(), F: fn({ Role: roleArn('R') }), C: custom }))).toContain('CUSTOM_RESOURCE_NOT_REVIEWED');
    });
  });

  describe('resource policies', () => {
    const bucket: Resource = {
      Type: 'AWS::S3::Bucket',
      Properties: { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } },
    };
    const bucketPolicy = (statement: Record<string, unknown>, target: unknown = { Ref: 'B' }): Resource => ({
      Type: 'AWS::S3::BucketPolicy',
      Properties: { Bucket: target, PolicyDocument: { Statement: [statement] } },
    });
    const cloudfrontRead = {
      Effect: 'Allow',
      Action: 's3:GetObject',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Resource: 'arn:aws:s3:::b/*',
      Condition: { StringEquals: { 'AWS:SourceArn': 'arn:aws:cloudfront::123456789012:distribution/D' } },
    };

    it('accepts the real shapes: TLS-only Deny to *, a local role, CloudFront bound to its distribution', () => {
      const statements = [
        { Effect: 'Deny', Action: 's3:*', Principal: { AWS: '*' }, Resource: 'arn:aws:s3:::b', Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
        { Effect: 'Allow', Action: 's3:List*', Principal: { AWS: roleArn('R') }, Resource: 'arn:aws:s3:::b' },
        cloudfrontRead,
      ];
      const policy: Resource = { Type: 'AWS::S3::BucketPolicy', Properties: { Bucket: { Ref: 'B' }, PolicyDocument: { Statement: statements } } };
      expect(rules(web({ R: reviewedLambdaRole(), B: bucket, P: policy }))).toEqual([]);
    });

    it.each([
      ['Principal *', { Principal: '*' }],
      ['AWS *', { Principal: { AWS: '*' } }],
      ['a foreign account', { Principal: { AWS: 'arn:aws:iam::999999999999:root' } }],
      ['the own account root', { Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` } }],
      ['a bare account id', { Principal: { AWS: '999999999999' } }],
      ['a service without a source condition', { Principal: { Service: 'cloudfront.amazonaws.com' }, Condition: undefined }],
      ['a canonical user', { Principal: { CanonicalUser: 'abc' } }],
      ['NotPrincipal', { Principal: undefined, NotPrincipal: { AWS: roleArn('R') } }],
    ])('denies an Allow to %s', (_label, change) => {
      const statement = { ...cloudfrontRead, ...change };
      expect(rules(web({ R: reviewedLambdaRole(), B: bucket, P: bucketPolicy(statement) }))).toContain('RESOURCE_POLICY_PRINCIPAL_NOT_REVIEWED');
    });

    it('denies a bucket policy on a bucket the template does not declare', () => {
      expect(rules(web({ B: bucket, P: bucketPolicy(cloudfrontRead, 'cdk-orcloud01-assets-123456789012-ap-northeast-1') }))).toContain('RESOURCE_POLICY_TARGET_NOT_LOCAL');
    });

    it('applies the same review to SNS topic policies', () => {
      const topic: Resource = { Type: 'AWS::SNS::Topic', Properties: {} };
      const topicPolicy = (topics: unknown[], principal: unknown): Resource => ({
        Type: 'AWS::SNS::TopicPolicy',
        Properties: { Topics: topics, PolicyDocument: { Statement: [allow({ Action: 'sns:Publish', Principal: principal, Resource: '*' })] } },
      });
      expect(rules(web({ T: topic, P: topicPolicy([{ Ref: 'T' }], '*') }))).toContain('RESOURCE_POLICY_PRINCIPAL_NOT_REVIEWED');
      expect(rules(web({ T: topic, P: topicPolicy(['arn:aws:sns:ap-northeast-1:123456789012:other'], { AWS: roleArn('T') }) }))).toContain('RESOURCE_POLICY_TARGET_NOT_LOCAL');
    });
  });

  describe('Lambda invoke permissions', () => {
    const fnRes: Resource = { Type: 'AWS::Lambda::Function', Properties: { Role: roleArn('R') } };
    const permission = (props: Record<string, unknown>): Resource => ({
      Type: 'AWS::Lambda::Permission',
      Properties: { Action: 'lambda:InvokeFunction', FunctionName: { 'Fn::GetAtt': ['F', 'Arn'] }, ...props },
    });

    it('accepts a service principal bound to a source', () => {
      expect(rules(web({ R: reviewedLambdaRole(), F: fnRes, P: permission({ Principal: 'cloudfront.amazonaws.com', SourceArn: 'arn:aws:cloudfront::123456789012:distribution/D' }) }))).toEqual([]);
    });

    it.each([
      ['a foreign account id', { Principal: '999999999999' }],
      ['a foreign role ARN', { Principal: 'arn:aws:iam::999999999999:role/x' }],
      ['the own account id', { Principal: ACCOUNT }],
      ['a service without a source', { Principal: 'events.amazonaws.com' }],
      ['a service with a foreign SourceAccount', { Principal: 's3.amazonaws.com', SourceAccount: '999999999999' }],
    ])('denies %s', (_label, props) => {
      expect(rules(web({ R: reviewedLambdaRole(), F: fnRes, P: permission(props) }))).toContain('LAMBDA_PERMISSION_PRINCIPAL_NOT_REVIEWED');
    });

    it('denies a permission on a function the template does not declare', () => {
      const p = permission({ Principal: 'cloudfront.amazonaws.com', SourceArn: 'arn:aws:cloudfront::1:distribution/D', FunctionName: 'arn:aws:lambda:ap-northeast-1:123456789012:function:other' });
      expect(rules(web({ R: reviewedLambdaRole(), F: fnRes, P: p }))).toContain('LAMBDA_PERMISSION_TARGET_NOT_LOCAL');
    });
  });
});

/*
 * Adversarial review of policy v2 (before PR): bypasses found by mutating the REAL dev assembly.
 * Each case starts from the byte-exact real fixture (which only trips the known AwsCliLayer
 * violation) and changes one thing a candidate controls.
 */
describe('trusted policy v2: bypasses of the real dev assembly', () => {
  const REAL = resolve(__dirname, 'fixtures/real-dev-assembly');
  const WEB = 'OpenReception-Web-dev';
  type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  /**
   * Copy the real fixture, apply `mutate` to the parsed files, return the assembly dir. A changed
   * template is re-hashed into its stack URL and template asset key, as an honest synth would
   * (so each case isolates its own rule); `rehash: false` keeps the stale hash.
   */
  const realWith = (mutate: (files: Record<string, J>, root: string) => void, { rehash = true } = {}): string => {
    const root = mkdtempSync(join(tmpdir(), 'or-broker-real-'));
    roots.push(root);
    const stacks = ['Web', 'WebMonitoring', 'CfMon'].map((s) => `OpenReception-${s}-dev`);
    const names = ['manifest.json', ...stacks.flatMap((s) => [`${s}.template.json`, `${s}.assets.json`, `${s}.metadata.json`])];
    const files: Record<string, J> = {};
    for (const n of names) files[n] = JSON.parse(readFileSync(join(REAL, n), 'utf8')) as J;
    const before = Object.fromEntries(names.map((n) => [n, JSON.stringify(files[n])]));
    mutate(files, root);
    const write = (n: string) => {
      // Untouched files are copied byte-exact so the template hashes still match.
      if (JSON.stringify(files[n]) === before[n]) writeFileSync(join(root, n), readFileSync(join(REAL, n)));
      else writeFileSync(join(root, n), JSON.stringify(files[n], null, 1));
    };
    for (const stack of stacks) {
      const t = `${stack}.template.json`;
      write(t);
      if (!rehash || JSON.stringify(files[t]) === before[t]) continue;
      const oldKey = String(files['manifest.json']!.artifacts[stack].properties.stackTemplateAssetObjectUrl).split('/').pop();
      const newKey = `${createHash('sha256').update(readFileSync(join(root, t))).digest('hex')}.json`;
      const props = files['manifest.json']!.artifacts[stack].properties as J;
      props.stackTemplateAssetObjectUrl = String(props.stackTemplateAssetObjectUrl).replace(String(oldKey), newKey);
      for (const asset of Object.values(files[`${stack}.assets.json`]!.files as Record<string, J>)) {
        for (const d of Object.values(asset.destinations as Record<string, J>)) if (d.objectKey === oldKey) d.objectKey = newKey;
      }
    }
    for (const n of names.filter((x) => !x.endsWith('.template.json'))) write(n);
    copyAssetDirs(REAL, root);
    return root;
  };
  const realRules = (assembly: string) => rules(assembly).filter((r) => r !== 'RESOURCE_TYPE_NOT_APPROVED');
  const webStack = (f: Record<string, J>) => f['manifest.json']!.artifacts[WEB].properties as J;
  const webAssets = (f: Record<string, J>) => f[`${WEB}.assets.json`]!.files as Record<string, J>;
  const webResources = (f: Record<string, J>) => f[`${WEB}.template.json`]!.Resources as Record<string, J>;
  const templateAsset = (f: Record<string, J>) => Object.values(webAssets(f)).find((a) => a.source.path === `${WEB}.template.json`)!;

  it('the untouched copy (with the layer zip) is allowed', () => {
    expect(realRules(realWith(() => {}))).toEqual([]);
  });

  describe('the deployed template is exactly the reviewed templateFile', () => {
    it('denies a template asset published from another file', () => {
      const a = realWith((f, root) => {
        writeFileSync(join(root, 'evil.template.json'), '{"Resources":{}}');
        templateAsset(f).source.path = 'evil.template.json';
      });
      expect(realRules(a)).toContain('MANIFEST_TEMPLATE_NOT_REVIEWED');
    });

    it('denies a template URL in another bucket or with another key', () => {
      for (const url of ['s3://attacker-controlled-public-bucket/evil.json', 's3://cdk-orcloud01-assets-123456789012-ap-northeast-1/' + 'f'.repeat(64) + '.json']) {
        expect(realRules(realWith((f) => (webStack(f).stackTemplateAssetObjectUrl = url))), url).toContain('MANIFEST_TEMPLATE_NOT_REVIEWED');
      }
    });

    it('denies a template edited after synthesis (hash no longer matches the URL)', () => {
      const a = realWith((f) => {
        webResources(f).Extra = { Type: 'AWS::SNS::Topic', Properties: {} };
      }, { rehash: false });
      expect(realRules(a)).toContain('MANIFEST_TEMPLATE_NOT_REVIEWED');
      // The same change, honestly re-hashed, passes: the rule is about the binding, not the edit.
      expect(realRules(realWith((f) => {
        webResources(f).Extra = { Type: 'AWS::SNS::Topic', Properties: {} };
      }))).toEqual([]);
    });

    it('denies duplicate JSON keys (another reader may keep the other value)', () => {
      const a = realWith(() => {});
      const file = join(a, `${WEB}.template.json`);
      const text = readFileSync(file, 'utf8');
      writeFileSync(file, text.replace('"Resources": {', '"Resources": {"Dup": {"Type": "AWS::SNS::Topic"}, "Dup": {"Type": "AWS::SNS::Topic"},'));
      expect(rules(a)).toContain('TEMPLATE_INVALID');
      const m = join(a, 'manifest.json');
      writeFileSync(m, readFileSync(m, 'utf8').replace('"version":', '"version": "1", "version":'));
      expect(rules(a)).toContain('ASSEMBLY_MANIFEST_INVALID');
    });
  });

  describe('asset publishing', () => {
    it.each([
      ['a foreign-named bucket', (d: J) => (d.bucketName = 'attacker-controlled-bucket')],
      ['the default bootstrap bucket', (d: J) => (d.bucketName = 'cdk-hnb659fds-assets-123456789012-ap-northeast-1')],
      ['another publishing role', (d: J) => (d.assumeRoleArn = 'arn:${AWS::Partition}:iam::123456789012:role/OrganizationAccountAccessRole')],
      ['an external id', (d: J) => (d.assumeRoleExternalId = 'x')],
      ['an unapproved region', (d: J) => (d.region = 'eu-west-1')],
    ])('denies a destination with %s', (_label, change) => {
      const a = realWith((f) => {
        for (const asset of Object.values(webAssets(f))) for (const d of Object.values(asset.destinations as Record<string, J>)) change(d);
      });
      expect(realRules(a)).toContain('ASSET_NOT_REVIEWED');
    });

    it('denies an executable (build command) asset source and container images', () => {
      const exe = realWith((f) => {
        Object.values(webAssets(f))[0]!.source = { executable: ['node', 'build-asset.js'] };
      });
      expect(realRules(exe)).toContain('ASSET_NOT_REVIEWED');
      const docker = realWith((f) => {
        f[`${WEB}.assets.json`]!.dockerImages = { x: { source: { directory: 'x' }, destinations: {} } };
      });
      expect(realRules(docker)).toContain('ASSET_NOT_REVIEWED');
    });

    it('reads a foreign account out of a destination key', () => {
      const a = realWith((f) => {
        const asset = Object.values(webAssets(f))[0]!;
        const [k, v] = Object.entries(asset.destinations as Record<string, J>)[0]!;
        delete asset.destinations[k];
        asset.destinations['999999999999-ap-northeast-1'] = v;
      });
      expect(realRules(a)).toContain('MANIFEST_FOREIGN_ACCOUNT');
    });
  });

  describe('deploy roles and options', () => {
    it.each([
      ['a same-account admin deploy role', (p: J) => (p.assumeRoleArn = 'arn:${AWS::Partition}:iam::123456789012:role/OrganizationAccountAccessRole')],
      ['a same-account admin execution role', (p: J) => (p.cloudFormationExecutionRoleArn = 'arn:aws:iam::123456789012:role/Admin')],
      ['the default bootstrap qualifier', (p: J) => (p.assumeRoleArn = String(p.assumeRoleArn).replace('orcloud01', 'hnb659fds'))],
      ['another region', (p: J) => (p.cloudFormationExecutionRoleArn = String(p.cloudFormationExecutionRoleArn).replace('ap-northeast-1', 'us-east-1'))],
      ['a missing deploy role', (p: J) => delete p.assumeRoleArn],
      ['another lookup role', (p: J) => (p.lookupRole = { arn: 'arn:aws:iam::123456789012:role/Admin' })],
    ])('denies %s', (_label, change) => {
      expect(realRules(realWith((f) => change(webStack(f))))).toContain('MANIFEST_ROLE_NOT_REVIEWED');
    });

    it.each([
      ['parameters', { parameters: { BootstrapVersion: '/x' } }],
      ['notification ARNs', { notificationArns: ['arn:aws:sns:ap-northeast-1:123456789012:t'] }],
      ['an external id', { assumeRoleExternalId: 'x' }],
      ['assume-role options', { assumeRoleAdditionalOptions: { Tags: [] } }],
    ])('denies stack artifact %s', (_label, extra) => {
      expect(realRules(realWith((f) => Object.assign(webStack(f), extra)))).toContain('MANIFEST_PROPERTY_NOT_REVIEWED');
    });
  });

  describe('source-bound resource policies check the condition value, not only the key', () => {
    const addStatement = (condition: unknown, principal: unknown = { Service: 'cloudfront.amazonaws.com' }) =>
      realWith((f) => {
        const policy = webResources(f).AssetBucketPolicy6A11ED41!;
        policy.Properties.PolicyDocument.Statement.push({
          Effect: 'Allow',
          Action: 's3:GetObject',
          Principal: principal,
          Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['AssetBucket1D025086', 'Arn'] }, '/*']] },
          ...(condition === undefined ? {} : { Condition: condition }),
        });
      });

    it.each([
      ['Null', { Null: { 'aws:SourceArn': 'true' } }],
      ['StringNotEquals SourceAccount', { StringNotEquals: { 'aws:SourceAccount': '123456789012' } }],
      ['StringLike *', { StringLike: { 'aws:SourceArn': '*' } }],
      ['a foreign distribution', { StringEquals: { 'aws:SourceArn': 'arn:aws:cloudfront::999999999999:distribution/EABCDEF' } }],
      ['IfExists', { StringEqualsIfExists: { 'aws:SourceArn': 'arn:aws:cloudfront::123456789012:distribution/E' } }],
      ['a wildcard in an exact operator', { StringEquals: { 'aws:SourceArn': 'arn:aws:cloudfront::123456789012:distribution/*' } }],
      ['a foreign SourceAccount', { StringEquals: { 'aws:SourceAccount': '999999999999' } }],
      ['a parameter value', { StringEquals: { 'aws:SourceArn': { Ref: 'DistParam' } } }],
      ['an unrelated key', { StringEquals: { 'aws:PrincipalOrgID': 'o-1' } }],
    ])('denies an Allow to a service bound by %s', (_label, condition) => {
      expect(realRules(addStatement(condition))).toContain('RESOURCE_POLICY_PRINCIPAL_NOT_REVIEWED');
    });

    it('denies a non-AWS "service" principal even when the source is bound', () => {
      const bound = { StringEquals: { 'aws:SourceAccount': '123456789012' } };
      expect(realRules(addStatement(bound, { Service: 'evil.example.com' }))).toContain('RESOURCE_POLICY_PRINCIPAL_NOT_REVIEWED');
      expect(realRules(addStatement(bound))).toEqual([]);
    });
  });

  describe('Lambda invoke permissions', () => {
    const addPermission = (props: J, id = 'ExtraPermission') =>
      realWith((f) => {
        webResources(f)[id] = {
          Type: 'AWS::Lambda::Permission',
          Properties: { Action: 'lambda:InvokeFunction', FunctionName: { 'Fn::GetAtt': ['ImageFnCD541B83', 'Arn'] }, ...props },
        };
      });

    it.each([
      ['an S3 bucket ARN without SourceAccount', { Principal: 's3.amazonaws.com', SourceArn: 'arn:aws:s3:::attacker-owned-bucket' }],
      ['a foreign SNS topic', { Principal: 'sns.amazonaws.com', SourceArn: 'arn:aws:sns:ap-northeast-1:999999999999:t' }],
      ['a wildcard SourceArn', { Principal: 'events.amazonaws.com', SourceArn: '*' }],
      ['an account principal with a bound source', { Principal: '999999999999', SourceArn: 'arn:aws:cloudfront::123456789012:distribution/E' }],
      ['a foreign ARN with this SourceAccount', { Principal: 'sns.amazonaws.com', SourceArn: 'arn:aws:sns:ap-northeast-1:999999999999:t', SourceAccount: '123456789012' }],
    ])('denies %s', (_label, props) => {
      expect(realRules(addPermission(props))).toContain('LAMBDA_PERMISSION_PRINCIPAL_NOT_REVIEWED');
    });

    it('accepts an account-less S3 source together with this SourceAccount', () => {
      expect(realRules(addPermission({ Principal: 's3.amazonaws.com', SourceArn: 'arn:aws:s3:::b', SourceAccount: '123456789012' }))).toEqual([]);
    });

    it('denies an action other than invoke', () => {
      expect(realRules(addPermission({ Action: 'lambda:*', Principal: 'cloudfront.amazonaws.com', SourceArn: 'arn:aws:cloudfront::123456789012:distribution/E' }))).toContain('LAMBDA_PERMISSION_ACTION_NOT_REVIEWED');
    });

    it.each([
      ['direct public invoke (no Function URL binding)', 'ServerFninvokefunctionA3A7399A', (p: J) => delete p.InvokedViaFunctionUrl],
      ['lambda:* on the reviewed invoke permission', 'ServerFninvokefunctionA3A7399A', (p: J) => (p.Action = 'lambda:*')],
      ['GetFunction on the reviewed URL permission', 'ServerFninvokefunctionurl715820CF', (p: J) => (p.Action = 'lambda:GetFunction')],
      ['no URL auth type', 'ServerFninvokefunctionurl715820CF', (p: J) => delete p.FunctionUrlAuthType],
      ['an extra property', 'ServerFninvokefunctionurl715820CF', (p: J) => (p.SourceAccount = '123456789012')],
    ])('denies %s', (_label, id, change) => {
      expect(realRules(realWith((f) => change(webResources(f)[id]!.Properties)))).toContain('PUBLIC_LAMBDA_PERMISSION_NOT_REVIEWED');
    });
  });

  describe('cross-account data flow through properties of approved types', () => {
    it.each([
      ['a DynamoDB resource policy', 'DataTable447BC44E', { ResourcePolicy: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::999999999999:root' }, Action: 'dynamodb:*', Resource: '*' }] } } }],
      ['a DynamoDB stream with a resource policy', 'DataTable447BC44E', { StreamSpecification: { StreamViewType: 'NEW_IMAGE', ResourcePolicy: {} } }],
      ['S3 replication', 'AssetBucket1D025086', { ReplicationConfiguration: { Role: 'x', Rules: [] } }],
      ['S3 notifications', 'AssetBucket1D025086', { NotificationConfiguration: { LambdaConfigurations: [] } }],
      ['S3 access logging', 'AssetBucket1D025086', { LoggingConfiguration: { DestinationBucketName: 'attacker' } }],
      ['a Cognito trigger', 'AdminUserPoolD0AF18CF', { LambdaConfig: { UserMigration: 'arn:aws:lambda:ap-northeast-1:999999999999:function:x' } }],
      ['a Lambda dead-letter target', 'ServerFn4F3A536E', { DeadLetterConfig: { TargetArn: 'arn:aws:sns:ap-northeast-1:123456789012:t' } }],
      ['a Lambda KMS key', 'ServerFn4F3A536E', { KmsKeyArn: 'arn:aws:kms:ap-northeast-1:123456789012:key/x' }],
    ])('denies %s', (_label, id, extra) => {
      expect(realRules(realWith((f) => Object.assign(webResources(f)[id]!.Properties, extra)))).toContain('PROPERTY_NOT_REVIEWED');
    });

    it('denies any other account named in a template (e.g. an alarm action)', () => {
      const a = realWith((f) => {
        const monitoring = f['OpenReception-WebMonitoring-dev.template.json']!.Resources as Record<string, J>;
        const alarm = Object.values(monitoring).find((r) => r.Type === 'AWS::CloudWatch::Alarm')!;
        alarm.Properties.AlarmActions = ['arn:aws:sns:ap-northeast-1:999999999999:exfil'];
      });
      expect(realRules(a)).toContain('TEMPLATE_FOREIGN_ACCOUNT');
    });
  });

  it('does not treat an inherited property name as a reviewed Function URL', () => {
    const a = realWith((f) => {
      webResources(f)[String('constructor')] = { Type: 'AWS::Lambda::Url', Properties: { TargetFunctionArn: { 'Fn::GetAtt': ['ServerFn4F3A536E', 'Arn'] } } };
    });
    expect(realRules(a)).toContain('FUNCTION_URL_NOT_REVIEWED');
  });
});

/*
 * Second adversarial review of policy v2: re-shaped bypasses, and rules no test exercised.
 */
describe('trusted policy v2: second review', () => {
  const REAL = resolve(__dirname, 'fixtures/real-dev-assembly');
  const WEB = 'OpenReception-Web-dev';
  type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const STACKS = ['Web', 'WebMonitoring', 'CfMon'].map((s) => `OpenReception-${s}-dev`);
  const NAMES = ['manifest.json', ...STACKS.flatMap((s) => [`${s}.template.json`, `${s}.assets.json`, `${s}.metadata.json`])];

  /** Copy the real fixture, mutate, re-hash changed templates (as an honest synth would). */
  const realWith = (mutate: (f: Record<string, J>, root: string) => void, { rehash = true } = {}): string => {
    const root = mkdtempSync(join(tmpdir(), 'or-broker-real2-'));
    roots.push(root);
    const f: Record<string, J> = {};
    for (const n of NAMES) f[n] = JSON.parse(readFileSync(join(REAL, n), 'utf8')) as J;
    const before = Object.fromEntries(NAMES.map((n) => [n, JSON.stringify(f[n])]));
    mutate(f, root);
    const write = (n: string) =>
      JSON.stringify(f[n]) === before[n] ? writeFileSync(join(root, n), readFileSync(join(REAL, n))) : writeFileSync(join(root, n), JSON.stringify(f[n], null, 1));
    for (const stack of STACKS) {
      const t = `${stack}.template.json`;
      write(t);
      if (!rehash || JSON.stringify(f[t]) === before[t]) continue;
      const props = f['manifest.json']!.artifacts[stack].properties as J;
      const oldKey = String(props.stackTemplateAssetObjectUrl).split('/').pop();
      const newKey = `${createHash('sha256').update(readFileSync(join(root, t))).digest('hex')}.json`;
      props.stackTemplateAssetObjectUrl = String(props.stackTemplateAssetObjectUrl).replace(String(oldKey), newKey);
      for (const asset of Object.values(f[`${stack}.assets.json`]!.files as Record<string, J>)) {
        for (const d of Object.values(asset.destinations as Record<string, J>)) if (d.objectKey === oldKey) d.objectKey = newKey;
      }
    }
    for (const n of NAMES.filter((x) => !x.endsWith('.template.json'))) write(n);
    copyAssetDirs(REAL, root);
    return root;
  };
  const realRules = (assembly: string) => rules(assembly).filter((r) => r !== 'RESOURCE_TYPE_NOT_APPROVED');
  const web = (f: Record<string, J>) => f[`${WEB}.template.json`]!.Resources as Record<string, J>;
  const stack = (f: Record<string, J>) => f['manifest.json']!.artifacts[WEB] as J;
  const assets = (f: Record<string, J>) => f[`${WEB}.assets.json`]!.files as Record<string, J>;
  const anyAsset = (f: Record<string, J>) => Object.values(assets(f)).find((a) => a.source.packaging === 'zip')!;
  const firstDest = (a: J) => Object.values(a.destinations as Record<string, J>)[0]!;

  it('the untouched copy (with metadata files and the layer zip) is allowed', () => {
    expect(realRules(realWith(() => {}))).toEqual([]);
  });

  describe('template-object poisoning across runs', () => {
    it('denies another asset published under a .json key (a later template URL could name it)', () => {
      const a = realWith((f, root) => {
        writeFileSync(join(root, 'evil.json'), '{"Resources":{}}');
        const hash = createHash('sha256').update('{"Resources":{}}\n').digest('hex');
        assets(f).poison = { source: { path: 'evil.json', packaging: 'file' }, destinations: { d: { ...firstDest(anyAsset(f)), objectKey: `${hash}.json` } } };
      });
      expect(realRules(a)).toContain('ASSET_NOT_REVIEWED');
    });

    it('denies a template file published under a key that is not its own hash', () => {
      const a = realWith((f) => {
        const t = Object.values(assets(f)).find((x) => x.source.path === `${WEB}.template.json`)!;
        firstDest(t).objectKey = `${'e'.repeat(64)}.json`;
      });
      expect(realRules(a)).toContain('ASSET_NOT_REVIEWED');
    });

    it('denies a zip asset under a non-.zip key', () => {
      expect(realRules(realWith((f) => (firstDest(anyAsset(f)).objectKey = `${'a'.repeat(64)}`)))).toContain('ASSET_NOT_REVIEWED');
    });

    it('denies a stack that does not depend on the manifest publishing its template', () => {
      const a = realWith((f) => {
        stack(f).dependencies = [];
        stack(f).properties.additionalDependencies = [];
      });
      expect(realRules(a)).toContain('MANIFEST_TEMPLATE_NOT_REVIEWED');
    });
  });

  describe('legacy asset metadata and artifact keys', () => {
    it('denies an aws:cdk:asset entry in inline metadata or in the metadata file', () => {
      const asset = { type: 'aws:cdk:asset', data: { packaging: 'container-image', path: 'x', id: 'x', sourceHash: 'x' } };
      expect(realRules(realWith((f) => (stack(f).metadata = { '/x': [asset] })))).toContain('LEGACY_ASSET_METADATA');
      expect(realRules(realWith((f) => (f[`${WEB}.metadata.json`]!['/x'] = [asset])))).toContain('LEGACY_ASSET_METADATA');
    });

    it('denies a metadata file outside the assembly and an unknown artifact key', () => {
      expect(realRules(realWith((f) => (stack(f).additionalMetadataFile = '../../../../etc/evil.json')))).toContain('ARTIFACT_METADATA_INVALID');
      expect(realRules(realWith((f) => (stack(f).hooks = {})))).toContain('ARTIFACT_KEY_NOT_REVIEWED');
    });
  });

  describe('source binding: {local} with a suffix is another name', () => {
    it('denies an S3 source built as <local bucket ARN>-attacker, in a Lambda permission and a bucket policy', () => {
      const lookAlike = { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['AssetBucket1D025086', 'Arn'] }, '-attacker']] };
      const perm = realWith((f) => {
        web(f).ExtraPermission = { Type: 'AWS::Lambda::Permission', Properties: { Action: 'lambda:InvokeFunction', FunctionName: { 'Fn::GetAtt': ['ImageFnCD541B83', 'Arn'] }, Principal: 's3.amazonaws.com', SourceArn: lookAlike } };
      });
      expect(realRules(perm)).toContain('LAMBDA_PERMISSION_PRINCIPAL_NOT_REVIEWED');
      const policy = realWith((f) => {
        web(f).AssetBucketPolicy6A11ED41!.Properties.PolicyDocument.Statement.push({
          Effect: 'Allow', Action: 's3:GetObject', Principal: { Service: 'logging.s3.amazonaws.com' },
          Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['AssetBucket1D025086', 'Arn'] }, '/*']] },
          Condition: { ArnEquals: { 'aws:SourceArn': lookAlike } },
        });
      });
      expect(realRules(policy)).toContain('RESOURCE_POLICY_PRINCIPAL_NOT_REVIEWED');
    });
  });

  describe('account ids split across intrinsic parts', () => {
    it.each([
      ['Fn::Join', { 'Fn::Join': ['', ['arn:aws:sns:ap-northeast-1:999999', '999999:exfil']] }],
      ['Fn::Sub with a variable map', { 'Fn::Sub': ['arn:aws:sns:ap-northeast-1:${A}${B}:exfil', { A: '999999', B: '999999' }] }],
    ])('finds a foreign account assembled by %s', (_label, value) => {
      const a = realWith((f) => {
        const monitoring = f['OpenReception-WebMonitoring-dev.template.json']!.Resources as Record<string, J>;
        Object.values(monitoring).find((r) => r.Type === 'AWS::SNS::Topic')!.Properties.DisplayName = value;
      });
      expect(realRules(a)).toContain('TEMPLATE_FOREIGN_ACCOUNT');
    });
  });

  describe('properties of other approved types that send data elsewhere', () => {
    it('denies an SNS subscription to an email / https / foreign endpoint', () => {
      for (const props of [
        { Protocol: 'https', Endpoint: 'https://attacker.example/hook' },
        { Protocol: 'email', Endpoint: 'someone@example.com' },
        { Protocol: 'lambda', Endpoint: 'arn:aws:lambda:ap-northeast-1:123456789012:function:other' },
      ]) {
        const a = realWith((f) => {
          const m = f['OpenReception-WebMonitoring-dev.template.json']!.Resources as Record<string, J>;
          const topic = Object.entries(m).find(([, r]) => r.Type === 'AWS::SNS::Topic')![0];
          m.Sub = { Type: 'AWS::SNS::Subscription', Properties: { TopicArn: { Ref: topic }, ...props } };
        });
        expect(realRules(a), JSON.stringify(props)).toContain('SUBSCRIPTION_NOT_REVIEWED');
      }
    });

    it('denies a changed OAuth callback / logout URL', () => {
      expect(realRules(realWith((f) => (web(f).AdminUserPoolAdminAppClient43C1FAD5!.Properties.CallbackURLs = ['https://attacker.example/cb'])))).toContain('PROPERTY_NOT_REVIEWED');
      expect(realRules(realWith((f) => (web(f).AdminUserPoolAdminAppClient43C1FAD5!.Properties.LogoutURLs = ['https://attacker.example/out'])))).toContain('PROPERTY_NOT_REVIEWED');
    });

    it('denies CloudFront access logging to a bucket', () => {
      expect(realRules(realWith((f) => (web(f).Distribution830FAC52!.Properties.DistributionConfig.Logging = { Bucket: 'attacker-logs.s3.amazonaws.com' })))).toContain('PROPERTY_NOT_REVIEWED');
    });

    it('denies an alarm action that is not a local topic', () => {
      const a = realWith((f) => {
        const m = f['OpenReception-WebMonitoring-dev.template.json']!.Resources as Record<string, J>;
        Object.values(m).find((r) => r.Type === 'AWS::CloudWatch::Alarm')!.Properties.OKActions = ['arn:aws:sns:ap-northeast-1:123456789012:other-project'];
      });
      expect(realRules(a)).toContain('ALARM_ACTION_NOT_REVIEWED');
    });
  });

  describe('template sections, tags, dependencies', () => {
    it('denies an extra template parameter, another bootstrap parameter default, an extra rule or an unknown section', () => {
      expect(realRules(realWith((f) => (f[`${WEB}.template.json`]!.Parameters.Extra = { Type: 'String', Default: 'x' })))).toContain('TEMPLATE_PARAMETER_NOT_REVIEWED');
      expect(realRules(realWith((f) => (f[`${WEB}.template.json`]!.Parameters.BootstrapVersion.Default = '/cdk-bootstrap/hnb659fds/version')))).toContain('TEMPLATE_PARAMETER_NOT_REVIEWED');
      expect(realRules(realWith((f) => (f[`${WEB}.template.json`]!.Rules.Extra = { Assertions: [] })))).toContain('TEMPLATE_PARAMETER_NOT_REVIEWED');
      expect(realRules(realWith((f) => (f[`${WEB}.template.json`]!.Hooks = {})))).toContain('TEMPLATE_SECTION_NOT_REVIEWED');
    });

    it('pins the Project / Environment / ManagedBy stack tags and the tag keys', () => {
      expect(realRules(realWith((f) => (stack(f).properties.tags.Project = 'other-project')))).toContain('MANIFEST_PROPERTY_NOT_REVIEWED');
      expect(realRules(realWith((f) => (stack(f).properties.tags.CostCenter = 'x')))).toContain('MANIFEST_PROPERTY_NOT_REVIEWED');
      expect(realRules(realWith((f) => (stack(f).properties.tags.Component = 'renamed')))).toEqual([]);
    });

    it('additionalDependencies may only name asset manifests', () => {
      expect(realRules(realWith((f) => stack(f).properties.additionalDependencies.push('OpenReception-Notification-dev')))).toContain('MANIFEST_PROPERTY_NOT_REVIEWED');
    });
  });

  describe('rules the first test round did not exercise', () => {
    const destMut = (change: (d: J, a: J) => void) =>
      realWith((f) => {
        const a = anyAsset(f);
        change(firstDest(a), a);
      });

    it.each([
      ['a source path escaping the assembly', (_d: J, a: J) => (a.source.path = '../../etc/passwd')],
      ['an unreviewed packaging', (_d: J, a: J) => (a.source.packaging = 'container-image')],
      ['a malformed object key', (d: J) => (d.objectKey = 'not-a-hash.zip')],
      ['a destination role of another kind', (d: J) => (d.assumeRoleArn = String(d.assumeRoleArn).replace('file-publishing', 'deploy'))],
      ['a bucket for another region', (d: J) => (d.bucketName = String(d.bucketName).replace('ap-northeast-1', 'us-east-1'))],
    ])('denies an asset with %s', (_label, change) => {
      expect(realRules(destMut(change))).toContain('ASSET_NOT_REVIEWED');
    });

    it('denies unknown asset-manifest keys, artifact properties and bootstrap parameters', () => {
      expect(realRules(realWith((f) => (f[`${WEB}.assets.json`]!.extra = {})))).toContain('ASSET_NOT_REVIEWED');
      expect(realRules(realWith((f) => (f['manifest.json']!.artifacts[`${WEB}.assets`].properties.extra = 1)))).toContain('ASSET_NOT_REVIEWED');
      expect(realRules(realWith((f) => (f['manifest.json']!.artifacts[`${WEB}.assets`].properties.bootstrapStackVersionSsmParameter = '/cdk-bootstrap/hnb659fds/version')))).toContain('ASSET_NOT_REVIEWED');
      expect(realRules(realWith((f) => (stack(f).properties.bootstrapStackVersionSsmParameter = '/x')))).toContain('MANIFEST_PROPERTY_NOT_REVIEWED');
      expect(realRules(realWith((f) => (stack(f).properties.lookupRole.extra = 1)))).toContain('MANIFEST_ROLE_NOT_REVIEWED');
    });

    it('denies deploy roles swapped for one another', () => {
      const a = realWith((f) => {
        const p = stack(f).properties;
        [p.assumeRoleArn, p.cloudFormationExecutionRoleArn] = [p.cloudFormationExecutionRoleArn, p.assumeRoleArn];
      });
      expect(realRules(a)).toContain('MANIFEST_ROLE_NOT_REVIEWED');
    });

    it('denies a template URL in another region\'s bootstrap bucket, and a template published as a zip', () => {
      expect(realRules(realWith((f) => (stack(f).properties.stackTemplateAssetObjectUrl = String(stack(f).properties.stackTemplateAssetObjectUrl).replace('ap-northeast-1', 'us-east-1'))))).toContain('MANIFEST_TEMPLATE_NOT_REVIEWED');
      const zipped = realWith((f) => {
        Object.values(assets(f)).find((x) => x.source.path === `${WEB}.template.json`)!.source.packaging = 'zip';
      });
      expect(realRules(zipped).some((r) => r === 'MANIFEST_TEMPLATE_NOT_REVIEWED' || r === 'ASSET_NOT_REVIEWED')).toBe(true);
    });

    it('denies a template URL no asset publishes', () => {
      const a = realWith((f) => {
        const k = Object.keys(assets(f)).find((x) => assets(f)[x]!.source.path === `${WEB}.template.json`)!;
        delete assets(f)[k];
      });
      expect(realRules(a)).toContain('MANIFEST_TEMPLATE_NOT_REVIEWED');
    });

    it('denies a Lambda permission with a same-account source but a foreign SourceAccount, or a wildcard source', () => {
      const perm = (props: J) =>
        realWith((f) => {
          web(f).ExtraPermission = { Type: 'AWS::Lambda::Permission', Properties: { Action: 'lambda:InvokeFunction', FunctionName: { 'Fn::GetAtt': ['ImageFnCD541B83', 'Arn'] }, ...props } };
        });
      expect(realRules(perm({ Principal: 'sns.amazonaws.com', SourceArn: 'arn:aws:sns:ap-northeast-1:123456789012:t', SourceAccount: '999999999999' }))).toContain('LAMBDA_PERMISSION_PRINCIPAL_NOT_REVIEWED');
      expect(realRules(perm({ Principal: 'sns.amazonaws.com', SourceArn: 'arn:aws:sns:ap-northeast-1:123456789012:*' }))).toContain('LAMBDA_PERMISSION_PRINCIPAL_NOT_REVIEWED');
    });
  });

  describe('third review: runtime grants, bootstrap state, nested intrinsics, pinned provider code', () => {
    const serverPolicy = (f: Record<string, J>) =>
      Object.entries(web(f)).find(([id, r]) => r.Type === 'AWS::IAM::Policy' && id.startsWith('ServerFnServiceRoleDefaultPolicy'))![1].Properties.PolicyDocument.Statement as J[];
    const grant = (Action: unknown, Resource: unknown) => realWith((f) => serverPolicy(f).push({ Effect: 'Allow', Action, Resource }));
    const TABLE = { 'Fn::GetAtt': ['DataTable447BC44E', 'Arn'] };
    const BUCKET = { 'Fn::GetAtt': ['AssetBucket1D025086', 'Arn'] };
    const SERVER = { 'Fn::GetAtt': ['ServerFn4F3A536E', 'Arn'] };

    it.each([
      ['dynamodb:PutResourcePolicy', TABLE],
      ['dynamodb:ExportTableToPointInTime', TABLE],
      ['s3:PutBucketPolicy', BUCKET],
      ['s3:Put*', BUCKET],
      ['s3:*', BUCKET],
      ['s3:PutReplicationConfiguration', BUCKET],
      ['lambda:AddPermission', SERVER],
      ['lambda:CreateFunctionUrlConfig', SERVER],
      ['lambda:UpdateFunctionCode', SERVER],
      ['cognito-idp:UpdateUserPoolClient', { 'Fn::GetAtt': ['AdminUserPool', 'Arn'] }],
      ['logs:PutSubscriptionFilter', { 'Fn::GetAtt': ['ServerFnLogs851AA923', 'Arn'] }],
      ['sns:Subscribe', { Ref: 'X' }],
    ])('denies a runtime role %s (it could create the grants this policy refuses in templates)', (action, resource) => {
      expect(realRules(grant(action, resource))).toContain('IAM_RESOURCE_SHARING_ACTION');
    });

    it('the auto-delete bucket grant is accepted only in its exact CDK shape', () => {
      const policy = (f: Record<string, J>) => web(f).AssetBucketPolicy6A11ED41!.Properties.PolicyDocument.Statement as J[];
      expect(realRules(realWith((f) => policy(f)[1]!.Action.push('s3:PutBucketAcl')))).toContain('RESOURCE_POLICY_SHARING_ACTION');
      expect(realRules(realWith((f) => (policy(f)[1]!.Principal = { AWS: { 'Fn::GetAtt': ['ServerFnServiceRole282D3E61', 'Arn'] } })))).toContain('RESOURCE_POLICY_SHARING_ACTION');
      expect(realRules(realWith((f) => policy(f).push({ Effect: 'Allow', Action: 's3:PutBucketPolicy', Principal: { Service: 'cloudfront.amazonaws.com' }, Resource: BUCKET, Condition: policy(f)[2]!.Condition })))).toContain('RESOURCE_POLICY_SHARING_ACTION');
    });

    it.each([
      ['s3:PutObject', 'arn:aws:s3:::cdk-orcloud01-assets-123456789012-ap-northeast-1/*'],
      ['s3:DeleteObject', 'arn:aws:s3:::cdk-*'],
      ['s3:PutObject', 'arn:aws:s3:::*'],
      ['s3:PutObject', { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':s3:::cdk-orcloud01-assets-123456789012-ap-northeast-1/*']] }],
      ['ssm:PutParameter', 'arn:aws:ssm:ap-northeast-1:123456789012:parameter/cdk-bootstrap/orcloud01/version'],
      ['ssm:DeleteParameter', 'arn:aws:ssm:*:123456789012:parameter/*'],
    ])('denies %s on bootstrap state (%j)', (action, resource) => {
      expect(realRules(grant(action, resource))).toContain('IAM_REACHES_BOOTSTRAP');
    });

    it('reads of the bootstrap bucket stay allowed (CDK BucketDeployment)', () => {
      expect(realRules(grant(['s3:GetObject*', 's3:List*'], 'arn:aws:s3:::cdk-orcloud01-assets-123456789012-ap-northeast-1/*'))).toEqual([]);
    });

    it.each([
      ['a nested Fn::Join', { 'Fn::Join': [':', ['arn:aws:sns:ap-northeast-1', { 'Fn::Join': ['', ['999999', '999999']] }, 'x']] }],
      ['Fn::Select of a literal list', { 'Fn::Join': ['', ['arn:aws:sns:ap-northeast-1:999999', { 'Fn::Select': [1, ['0', '999999']] }, ':x']] }],
      ['a Sub variable that is an intrinsic', { 'Fn::Sub': ['arn:aws:sns:ap-northeast-1:999999${A}:x', { A: { 'Fn::Join': ['', ['999999']] } }] }],
    ])('finds a foreign account split by %s', (_label, value) => {
      const a = realWith((f) => {
        const m = f['OpenReception-WebMonitoring-dev.template.json']!.Resources as Record<string, J>;
        Object.values(m).find((r) => r.Type === 'AWS::SNS::Topic')!.Properties.DisplayName = value;
      });
      expect(realRules(a)).toContain('TEMPLATE_FOREIGN_ACCOUNT');
    });

    it.each([
      ['a DynamoDB customer-managed key', (f: Record<string, J>) => (web(f).DataTable447BC44E!.Properties.SSESpecification = { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: 'alias/x' })],
      ['S3 aws:kms encryption', (f: Record<string, J>) => (web(f).AssetBucket1D025086!.Properties.BucketEncryption = { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: 'alias/x' } }] })],
      ['a log group KMS key', (f: Record<string, J>) => (web(f).ServerFnLogs851AA923!.Properties.KmsKeyId = 'alias/x')],
      ['a log group data-protection policy', (f: Record<string, J>) => (web(f).ServerFnLogs851AA923!.Properties.DataProtectionPolicy = { Statement: [] })],
      ['an edge function', (f: Record<string, J>) => (web(f).Distribution830FAC52!.Properties.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations = [{ EventType: 'viewer-request', LambdaFunctionARN: 'arn:aws:lambda:us-east-1:123456789012:function:f:1' }])],
      ['a CloudFront function on a behavior', (f: Record<string, J>) => (web(f).Distribution830FAC52!.Properties.DistributionConfig.CacheBehaviors[0].FunctionAssociations = [{ EventType: 'viewer-request', FunctionARN: 'x' }])],
      ['a WAF web ACL', (f: Record<string, J>) => (web(f).Distribution830FAC52!.Properties.DistributionConfig.WebACLId = 'x')],
      ['an origin setting', (f: Record<string, J>) => (web(f).Distribution830FAC52!.Properties.DistributionConfig.Origins[0].OriginShield = { Enabled: true })],
    ])('denies %s', (_label, change) => {
      expect(realRules(realWith(change))).toContain('PROPERTY_NOT_REVIEWED');
    });

    it('denies an SNS subscription property beyond topic / protocol / endpoint', () => {
      const a = realWith((f) => {
        const m = f['OpenReception-WebMonitoring-dev.template.json']!.Resources as Record<string, J>;
        const topic = Object.entries(m).find(([, r]) => r.Type === 'AWS::SNS::Topic')![0];
        m.Q = { Type: 'AWS::SQS::Queue', Properties: {} };
        m.Sub = { Type: 'AWS::SNS::Subscription', Properties: { TopicArn: { Ref: topic }, Protocol: 'sqs', Endpoint: { 'Fn::GetAtt': ['Q', 'Arn'] }, RedrivePolicy: { deadLetterTargetArn: 'x' } } };
      });
      expect(realRules(a)).toContain('PROPERTY_NOT_REVIEWED');
    });

    describe('pinned CDK provider code', () => {
      const WRITER = 'CustomCrossRegionExportWriterCustomResourceProviderHandlerD8786E8A';
      const AUTO = 'CustomS3AutoDeleteObjectsCustomResourceProviderHandler9D90184F';
      const assetDir = (root: string, fnId: string) => {
        const key = String(JSON.parse(readFileSync(join(root, `${WEB}.template.json`), 'utf8')).Resources[fnId].Properties.Code.S3Key);
        return join(root, `asset.${key.replace('.zip', '')}`);
      };

      it('the untouched copy passes (digests match the aws-cdk-lib handlers)', () => {
        expect(realRules(realWith(() => {}))).toEqual([]);
      });

      it.each([
        ['modified handler code', (dir: string) => writeFileSync(join(dir, 'index.js'), `${readFileSync(join(dir, 'index.js'), 'utf8')}\n// tampered`)],
        ['an extra file', (dir: string) => writeFileSync(join(dir, 'extra.js'), 'x')],
        ['a symlink', (dir: string) => execFileSync('ln', ['-s', '/etc/passwd', join(dir, 'link')])],
        ['a missing directory', (dir: string) => rmSync(dir, { recursive: true, force: true })],
      ])('denies %s', (_label, change) => {
        for (const fnId of [AUTO, WRITER]) {
          const root = realWith(() => {});
          change(assetDir(root, fnId));
          expect(realRules(root), fnId).toContain('PROVIDER_CODE_NOT_REVIEWED');
        }
      });

      it.each([
        ['an environment (NODE_OPTIONS)', (p: J) => (p.Environment = { Variables: { NODE_OPTIONS: '--require /tmp/x.js' } })],
        ['another handler', (p: J) => (p.Handler = 'other.handler')],
        ['a layer', (p: J) => (p.Layers = [{ Ref: 'AssetDeploymentAwsCliLayerC0B4D779' }])],
        ['code from another asset', (p: J) => (p.Code.S3Key = '7d4121075d2726b8cc35a71c83c4395cb12fcee9dcbf37c890012827fe95c5dd.zip')],
        ['code from another bucket', (p: J) => (p.Code.S3Bucket = 'cdk-orcloud01-assets-123456789012-us-east-1')],
      ])('denies a pinned provider with %s', (_label, change) => {
        expect(realRules(realWith((f) => change(web(f)[WRITER]!.Properties)))).toContain('PROVIDER_CODE_NOT_REVIEWED');
      });

      it('denies a symlink even to identical code, and a second source of the same key that differs', () => {
        const root = realWith(() => {});
        const dir = assetDir(root, WRITER);
        const outside = join(root, 'outside-index.js');
        writeFileSync(outside, readFileSync(join(dir, 'index.js')));
        rmSync(join(dir, 'index.js'));
        execFileSync('ln', ['-s', outside, join(dir, 'index.js')]);
        expect(realRules(root)).toContain('PROVIDER_CODE_NOT_REVIEWED');

        const dup = realWith((f, r) => {
          const key = String(web(f)[WRITER]!.Properties.Code.S3Key);
          const [, original] = Object.entries(assets(f)).find(([, a]) => Object.values(a.destinations as Record<string, J>).some((d) => d.objectKey === key))!;
          assets(f).dup = { ...original, source: { path: 'asset.dup', packaging: 'zip' } };
          cpSync(join(REAL, String(original.source.path)), join(r, 'asset.dup'), { recursive: true });
          writeFileSync(join(r, 'asset.dup', 'index.js'), 'tampered');
        });
        expect(realRules(dup)).toContain('PROVIDER_CODE_NOT_REVIEWED');
      });

      it('a pinned provider must run as its own role', () => {
        expect(realRules(realWith((f) => (web(f)[WRITER]!.Properties.Role = { 'Fn::GetAtt': ['CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092', 'Arn'] })))).toContain('PROVIDER_CODE_NOT_REVIEWED');
        expect(realRules(realWith((f) => (web(f)[WRITER]!.Properties.Role = { 'Fn::GetAtt': ['ServerFnServiceRole282D3E61', 'Arn'] })))).toContain('PROVIDER_CODE_NOT_REVIEWED');
      });

      it('denies any other function running as a pinned provider role', () => {
        const a = realWith((f) => {
          web(f).Other = { Type: 'AWS::Lambda::Function', Properties: { ...web(f).ServerFn4F3A536E!.Properties, Role: { 'Fn::GetAtt': ['CustomCrossRegionExportWriterCustomResourceProviderRoleC951B1E1', 'Arn'] }, ReservedConcurrentExecutions: undefined } };
        });
        expect(realRules(a)).toContain('PROVIDER_CODE_NOT_REVIEWED');
      });

      it.each([
        ['an export into another project', (p: J) => (p.WriterProps.exports['/cdk/exports/OtherProject-prod/X'] = 'v')],
        ['an export for an approved stack in the wrong region', (p: J) => (p.WriterProps.exports['/cdk/exports/OpenReception-WebMonitoring-dev/X'] = 'v')],
        ['an extra property', (p: J) => (p.Extra = 1)],
      ])('denies a cross-region writer with %s', (_label, change) => {
        expect(realRules(realWith((f) => change(web(f).ExportsWriteruseast10F67B507DDE2E818!.Properties)))).toContain('CUSTOM_RESOURCE_NOT_REVIEWED');
      });

      it('denies a cross-region reader reading another prefix, and auto-delete of a bucket this template does not own', () => {
        const cf = (f: Record<string, J>) => (f['OpenReception-CfMon-dev.template.json']!.Resources as Record<string, J>).ExportsReader8B249524!.Properties;
        expect(realRules(realWith((f) => (cf(f).ReaderProps.prefix = 'OtherProject-prod')))).toContain('CUSTOM_RESOURCE_NOT_REVIEWED');
        expect(realRules(realWith((f) => (cf(f).ReaderProps.imports['/cdk/exports/OtherProject-prod/X'] = '{{resolve:ssm:/cdk/exports/OtherProject-prod/X}}')))).toContain('CUSTOM_RESOURCE_NOT_REVIEWED');
        expect(realRules(realWith((f) => (web(f).AssetBucketAutoDeleteObjectsCustomResource5FFEAE83!.Properties.BucketName = 'other-project-bucket')))).toContain('CUSTOM_RESOURCE_NOT_REVIEWED');
      });
    });

    describe('round 5: runtime use of pinned roles, code object binding, remaining gaps', () => {
      const WRITER_ROLE = 'CustomCrossRegionExportWriterCustomResourceProviderRoleC951B1E1';
      const AUTO_ROLE = 'CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092';

      it.each([WRITER_ROLE, AUTO_ROLE, 'CustomCrossRegionExportReaderCustomResourceProviderRole10531BBD'])('denies iam:PassRole of the pinned role %s (a runtime role could run it with its own code)', (role) => {
        const a = realWith((f) => {
          if (role.includes('Reader')) (f['OpenReception-CfMon-dev.template.json']!.Resources as Record<string, J>).X = { Type: 'AWS::IAM::Policy', Properties: { PolicyName: 'x', Roles: [{ Ref: Object.keys(f['OpenReception-CfMon-dev.template.json']!.Resources).find((k) => k.startsWith('CustomCrossRegionExportReaderCustomResourceProviderRole'))! }], PolicyDocument: { Statement: [{ Effect: 'Allow', Action: 'iam:PassRole', Resource: { 'Fn::GetAtt': [role, 'Arn'] } }] } } };
          else serverPolicy(f).push({ Effect: 'Allow', Action: 'iam:PassRole', Resource: { 'Fn::GetAtt': [role, 'Arn'] } });
        });
        expect(realRules(a)).toContain('IAM_CONTROL_PLANE_ACTION');
      });

      it('passing an ordinary local role stays allowed; creating functions and invoke globs are not', () => {
        expect(realRules(grant('iam:PassRole', { 'Fn::GetAtt': ['ServerFnServiceRole282D3E61', 'Arn'] }))).toEqual([]);
        expect(realRules(grant('lambda:CreateFunction', { 'Fn::Sub': 'arn:aws:lambda:ap-northeast-1:${AWS::AccountId}:function:pwn' }))).toContain('IAM_RESOURCE_SHARING_ACTION');
        expect(realRules(grant('lambda:Invoke*', SERVER))).toContain('IAM_LOOP_CAPABLE_ACTION');
        expect(realRules(grant('lambda:InvokeF*', SERVER))).toContain('IAM_LOOP_CAPABLE_ACTION');
      });

      it.each(['ssm:PutResourcePolicy', 's3:CreateAccessGrant', 'apigateway:PATCH', 'cognito-idp:AdminCreateUser', 'cloudfront:CreateDistribution', 'lambda:PutFunctionRecursionConfig', 'sns:CreateTopic'])('denies %s', (action) => {
        expect(realRules(grant(action, { 'Fn::Sub': 'arn:aws:ssm:ap-northeast-1:${AWS::AccountId}:parameter/x' }))).toContain('IAM_RESOURCE_SHARING_ACTION');
      });

      it('denies runtime writes to the cross-region export parameters (resolved at the consumer deploy)', () => {
        expect(realRules(grant('ssm:PutParameter', { 'Fn::Sub': 'arn:aws:ssm:us-east-1:${AWS::AccountId}:parameter/cdk/exports/*' }))).toContain('IAM_REACHES_BOOTSTRAP');
      });

      it('a pinned provider code key must be published to the function\'s own region', () => {
        const a = realWith((f) => {
          const key = String(web(f).CustomCrossRegionExportWriterCustomResourceProviderHandlerD8786E8A!.Properties.Code.S3Key);
          for (const asset of Object.values(assets(f))) {
            for (const d of Object.values(asset.destinations as Record<string, J>)) {
              if (d.objectKey === key) {
                d.region = 'us-east-1';
                d.bucketName = String(d.bucketName).replace('ap-northeast-1', 'us-east-1');
                d.assumeRoleArn = String(d.assumeRoleArn).replace('ap-northeast-1', 'us-east-1');
              }
            }
          }
        });
        expect(realRules(a)).toContain('PROVIDER_CODE_NOT_REVIEWED');
      });

      it('denies Mappings / Conditions sections and finds an account split through Fn::Split', () => {
        expect(realRules(realWith((f) => (f[`${WEB}.template.json`]!.Mappings = { M: { a: { b: 'c' } } })))).toContain('TEMPLATE_SECTION_NOT_REVIEWED');
        expect(realRules(realWith((f) => (f[`${WEB}.template.json`]!.Conditions = { C: { 'Fn::Equals': ['a', 'a'] } })))).toContain('TEMPLATE_SECTION_NOT_REVIEWED');
        for (const value of [
          { 'Fn::Join': ['', ['arn:aws:sns:ap-northeast-1:999999', { 'Fn::Select': [0, { 'Fn::Split': [',', '999999,x'] }] }, ':x']] },
          { 'Fn::Join': ['', { 'Fn::Split': [',', 'arn:aws:sns:ap-northeast-1:999999,999999:x'] }] },
        ]) {
          const a = realWith((f) => {
            const m = f['OpenReception-WebMonitoring-dev.template.json']!.Resources as Record<string, J>;
            Object.values(m).find((r) => r.Type === 'AWS::SNS::Topic')!.Properties.DisplayName = value;
          });
          expect(realRules(a), JSON.stringify(value)).toContain('TEMPLATE_FOREIGN_ACCOUNT');
        }
      });
    });

    describe('the pinned AWS CLI layer (owner decision 2026-09-28)', () => {
      const LAYER = 'AssetDeploymentAwsCliLayerC0B4D779';
      it.each([
        ['modified layer content', (_f: Record<string, J>, root: string) => writeFileSync(join(root, AWSCLI_LAYER_ASSET), 'not the reviewed zip')],
        ['a missing layer zip', (_f: Record<string, J>, root: string) => rmSync(join(root, AWSCLI_LAYER_ASSET))],
      ])('denies %s', (_label, change) => {
        const root = realWith(() => {});
        change({}, root);
        expect(rules(root)).toContain('LAYER_NOT_REVIEWED');
      });

      it.each([
        ['another description', (p: J) => (p.Description = 'x')],
        ['an extra property', (p: J) => (p.CompatibleRuntimes = ['nodejs20.x'])],
        ['content from another key', (p: J) => (p.Content.S3Key = '7d4121075d2726b8cc35a71c83c4395cb12fcee9dcbf37c890012827fe95c5dd.zip')],
        ['content from another bucket', (p: J) => (p.Content.S3Bucket = 'cdk-orcloud01-assets-123456789012-us-east-1')],
        ['an extra content key', (p: J) => (p.Content.S3ObjectVersion = 'v1')],
      ])('denies the pinned layer with %s', (_label, change) => {
        expect(rules(realWith((f) => change(web(f)[LAYER]!.Properties)))).toContain('LAYER_NOT_REVIEWED');
      });

      it('the layer key must be published to the layer\'s own region', () => {
        const a = realWith((f) => {
          const [, original] = Object.entries(assets(f)).find(([, x]) => x.source.path === AWSCLI_LAYER_ASSET)!;
          for (const d of Object.values(original.destinations as Record<string, J>)) {
            d.region = 'us-east-1';
            d.bucketName = String(d.bucketName).replace('ap-northeast-1', 'us-east-1');
            d.assumeRoleArn = String(d.assumeRoleArn).replace('ap-northeast-1', 'us-east-1');
          }
        });
        expect(rules(a)).toContain('LAYER_NOT_REVIEWED');
      });

      it('denies any other layer, even with the reviewed content', () => {
        const a = realWith((f) => {
          web(f).OtherLayer = JSON.parse(JSON.stringify(web(f)[LAYER]));
        });
        expect(rules(a)).toContain('LAYER_NOT_REVIEWED');
      });

      it('denies the reviewed key when a second source publishes different bytes to it', () => {
        const a = realWith((f, r) => {
          const [, original] = Object.entries(assets(f)).find(([, x]) => x.source.path === AWSCLI_LAYER_ASSET)!;
          assets(f).dup = { ...original, source: { path: 'asset.dup.zip', packaging: 'file' } };
          writeFileSync(join(r, 'asset.dup.zip'), 'other bytes');
        });
        expect(rules(a)).toContain('LAYER_NOT_REVIEWED');
      });
    });

    it('denies an asset source that has both a path and a build command', () => {
      expect(realRules(realWith((f) => (anyAsset(f).source.executable = ['node', 'build.js'])))).toContain('ASSET_NOT_REVIEWED');
    });
  });
});
