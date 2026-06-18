import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WebStack } from '../lib/stacks/web-stack';
import { resolveEnv, ENVIRONMENTS } from '../lib/config/environments';

describe('environments config', () => {
  it('resolves known environments and defaults to dev', () => {
    expect(resolveEnv(undefined).environment).toBe('dev');
    expect(resolveEnv('prod').environment).toBe('prod');
  });

  it('throws on unknown environment', () => {
    expect(() => resolveEnv('qa')).toThrow(/Unknown environment/);
  });

  it('prod has stricter log retention than dev', () => {
    expect(ENVIRONMENTS.prod.web.logRetentionDays).toBeGreaterThan(
      ENVIRONMENTS.dev.web.logRetentionDays,
    );
  });
});

const OPEN_NEXT_READY = fs.existsSync(
  path.join(__dirname, '..', '..', '.open-next', 'open-next.output.json'),
);

// WebStack の synth は `.open-next/` 成果物を要求するため、未ビルド環境では skip する。
describe.runIf(OPEN_NEXT_READY)('WebStack synthesis', () => {
  const app = new cdk.App();
  const stack = new WebStack(app, 'TestWeb', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
    config: resolveEnv('dev'),
    appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
  });
  const template = Template.fromStack(stack);

  it('provisions a private asset bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('creates server and image Lambda functions on arm64 / node22', () => {
    template.resourceCountIs('AWS::Lambda::Url', 2);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
    });
  });

  it('Function URLs require IAM auth (no public invocation)', () => {
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  });

  it('grants CloudFront-scoped invoke via OAC', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 3);
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      Principal: 'cloudfront.amazonaws.com',
      SourceArn: Match.anyValue(),
    });
  });

  it('serves through a single CloudFront distribution', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('passes app env vars to the server function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ ADMIN_AUTH_PROVIDER: 'none', NODE_ENV: 'production' }),
      },
    });
  });
});
