import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { CloudFrontMonitoringStack } from '../lib/stacks/cloudfront-monitoring-stack';
import { resolveEnv, EnvConfig } from '../lib/config/environments';

const ACCOUNT = '123456789012';
const US_EAST_1 = { account: ACCOUNT, region: 'us-east-1' };

/** alarmEmail を上書きした config を返す（共有オブジェクトの変異を避ける）。 */
const configWithAlarmEmail = (alarmEmail: string): EnvConfig => {
  const base = resolveEnv('dev');
  return { ...base, notification: { ...base.notification, alarmEmail } };
};

const synth = (config: EnvConfig = resolveEnv('dev')) => {
  const app = new cdk.App();
  const stack = new CloudFrontMonitoringStack(app, 'TestCfMonitoring', {
    env: US_EAST_1,
    config,
    distributionId: 'EDFDVBD6EXAMPLE',
  });
  return Template.fromStack(stack);
};

describe('CloudFrontMonitoringStack (#303)', () => {
  const template = synth();

  it('creates a dedicated SNS topic without subscription when alarmEmail is empty', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  it('subscribes alarmEmail to the topic when provided', () => {
    const withEmail = synth(configWithAlarmEmail('ops@example.com'));
    withEmail.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });

  it('alarms on CloudFront 5xxErrorRate (Average > 1% for 3 x 5min periods)', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/CloudFront',
      MetricName: '5xxErrorRate',
      Statistic: 'Average',
      Period: 300,
      Threshold: 1,
      EvaluationPeriods: 3,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
      Dimensions: [
        { Name: 'DistributionId', Value: 'EDFDVBD6EXAMPLE' },
        { Name: 'Region', Value: 'Global' },
      ],
    });
  });

  it('the alarm notifies the SNS topic', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    for (const alarm of Object.values(alarms)) {
      const props = alarm.Properties as { AlarmActions?: unknown[] };
      expect(props.AlarmActions).toHaveLength(1);
    }
  });

  it('applies cost tags with Component=web', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      Tags: [
        { Key: 'Component', Value: 'web' },
        { Key: 'Environment', Value: 'dev' },
        { Key: 'ManagedBy', Value: 'cdk' },
        { Key: 'Owner', Value: 'open-reception-team' },
        { Key: 'Project', Value: 'open-reception' },
      ],
    });
  });
});

// crossRegionReferences (SSM ベースの custom resource) による DistributionId 連携を検証する。
// producer (ap-northeast-1) 側には ExportWriter が「追加」されるだけで、Distribution 等の
// 既存リソースには影響しないこと（#303 の絶対条件）を fixture で確認する。
describe('cross-region DistributionId wiring (#303)', () => {
  const app = new cdk.App();
  const producer = new cdk.Stack(app, 'ProducerWeb', {
    env: { account: ACCOUNT, region: 'ap-northeast-1' },
    crossRegionReferences: true,
  });
  const distribution = new cloudfront.Distribution(producer, 'Distribution', {
    defaultBehavior: {
      origin: new origins.HttpOrigin('example.com'),
    },
  });
  const consumer = new CloudFrontMonitoringStack(app, 'ConsumerCfMonitoring', {
    env: US_EAST_1,
    crossRegionReferences: true,
    config: resolveEnv('dev'),
    distributionId: distribution.distributionId,
  });
  const producerTemplate = Template.fromStack(producer);
  const consumerTemplate = Template.fromStack(consumer);

  it('adds only an ExportWriter custom resource to the producer (no CFN Export / no distribution change)', () => {
    producerTemplate.resourceCountIs('Custom::CrossRegionExportWriter', 1);
    producerTemplate.resourceCountIs('AWS::CloudFront::Distribution', 1);
    // CloudFormation Export（Fn::ImportValue のロック対象）は作られない — SSM 連携のため。
    const outputs = producerTemplate.toJSON().Outputs as
      | Record<string, { Export?: unknown }>
      | undefined;
    for (const output of Object.values(outputs ?? {})) {
      expect(output.Export).toBeUndefined();
    }
  });

  it('the consumer reads the DistributionId through an ExportReader and feeds the alarm dimension', () => {
    consumerTemplate.resourceCountIs('Custom::CrossRegionExportReader', 1);
    const body = JSON.stringify(consumerTemplate.findResources('AWS::CloudWatch::Alarm'));
    expect(body).toContain('ExportsReader');
  });
});
