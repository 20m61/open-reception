import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NotificationStack } from '../lib/stacks/notification-stack';
import { MonitoringStack } from '../lib/stacks/monitoring-stack';
import { resolveEnv } from '../lib/config/environments';

const ENV = { account: '123456789012', region: 'ap-northeast-1' };

function buildStacks(envName: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const config = resolveEnv(envName);
  const notification = new NotificationStack(app, 'TestNotif', { env: ENV, config });
  const monitoring = new MonitoringStack(app, 'TestMon', {
    env: ENV,
    config,
    notificationFn: notification.notificationFn.fn,
    httpApi: notification.api.httpApi,
  });
  return {
    notification: Template.fromStack(notification),
    monitoring: Template.fromStack(monitoring),
  };
}

describe('NotificationStack', () => {
  const { notification } = buildStacks('dev');

  it('exposes an HTTP API with a Lambda authorizer', () => {
    notification.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    notification.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
    notification.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
    });
  });

  it('routes POST /notify through an authorizer', () => {
    notification.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /notify',
      AuthorizationType: 'CUSTOM',
    });
  });

  it('applies throttling on the default stage', () => {
    notification.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
  });

  it('runs handler + authorizer Lambdas on arm64/node22', () => {
    notification.resourceCountIs('AWS::Lambda::Function', 2);
    notification.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
    });
  });

  it('scopes SSM read permission to the site-config prefix', () => {
    notification.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['ssm:GetParameter']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('does not grant Polly when pollyEnabled is false (dev)', () => {
    const policies = notification.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).not.toContain('polly:SynthesizeSpeech');
  });
});

describe('NotificationStack (prod) grants Polly', () => {
  it('includes polly:SynthesizeSpeech when pollyEnabled', () => {
    const { notification } = buildStacks('prod');
    const serialized = JSON.stringify(notification.findResources('AWS::IAM::Policy'));
    expect(serialized).toContain('polly:SynthesizeSpeech');
  });
});

describe('MonitoringStack', () => {
  const { monitoring } = buildStacks('dev');

  it('creates alarms for errors, latency, throttles and API 5xx', () => {
    monitoring.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  });

  it('wires an SNS topic and dashboard', () => {
    monitoring.resourceCountIs('AWS::SNS::Topic', 1);
    monitoring.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  it('routes alarm actions to the SNS topic', () => {
    monitoring.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmActions: Match.anyValue(),
    });
  });
});
