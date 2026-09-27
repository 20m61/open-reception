import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  DEV_IMAGE_RESERVED_CONCURRENCY,
  DEV_SERVER_RESERVED_CONCURRENCY,
  WebStack,
} from '../lib/stacks/web-stack';
import { openNextArtifactState } from '../lib/build-artifacts';
import { resolveEnv } from '../lib/config/environments';

const READY = openNextArtifactState(path.join(__dirname, '..', '..')).state === 'fresh';

const synth = (environment: 'dev' | 'staging' | 'prod'): Template => {
  const app = new cdk.App();
  return Template.fromStack(
    new WebStack(app, `Concurrency-${environment}`, {
      env: { account: '123456789012', region: 'ap-northeast-1' },
      config: resolveEnv(environment),
      appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
      originVerifySecretName:
        environment === 'dev' ? undefined : 'open-reception/test/app',
      publicOriginOverride:
        environment === 'dev' ? undefined : 'https://example.cloudfront.net',
      cognitoAuth: false,
    }),
  );
};

const productFunctions = (template: Template) => {
  const functions = template.findResources('AWS::Lambda::Function');
  const values = Object.values(functions) as Array<{
    Properties?: {
      ReservedConcurrentExecutions?: number;
      Environment?: { Variables?: Record<string, unknown> };
    };
  }>;
  const server = values.find(
    (fn) => fn.Properties?.Environment?.Variables?.DATA_BACKEND === 'dynamodb',
  );
  const image = values.find(
    (fn) => 'BUCKET_NAME' in (fn.Properties?.Environment?.Variables ?? {}),
  );
  expect(server).toBeDefined();
  expect(image).toBeDefined();
  return { server: server!, image: image! };
};

describe.runIf(READY)('dev Lambda reserved concurrency ceilings (#1150)', () => {
  it('bounds the two product Lambdas in dev', () => {
    const { server, image } = productFunctions(synth('dev'));
    expect(server.Properties?.ReservedConcurrentExecutions).toBe(
      DEV_SERVER_RESERVED_CONCURRENCY,
    );
    expect(image.Properties?.ReservedConcurrentExecutions).toBe(
      DEV_IMAGE_RESERVED_CONCURRENCY,
    );
    expect(DEV_SERVER_RESERVED_CONCURRENCY).toBe(5);
    expect(DEV_IMAGE_RESERVED_CONCURRENCY).toBe(2);
  });

  it.each(['staging', 'prod'] as const)(
    'does not change %s concurrency policy as a side effect of safe-dev deployment',
    (environment) => {
      const { server, image } = productFunctions(synth(environment));
      expect(server.Properties).not.toHaveProperty('ReservedConcurrentExecutions');
      expect(image.Properties).not.toHaveProperty('ReservedConcurrentExecutions');
    },
  );
});
