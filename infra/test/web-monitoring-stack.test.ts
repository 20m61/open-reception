import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { WebMonitoringStack } from '../lib/stacks/web-monitoring-stack';
import { WebStack } from '../lib/stacks/web-stack';
import { resolveEnv, EnvConfig } from '../lib/config/environments';

const ENV = { account: '123456789012', region: 'ap-northeast-1' };

/** alarmEmail を上書きした config を返す（共有オブジェクトの変異を避ける）。 */
const configWithAlarmEmail = (alarmEmail: string): EnvConfig => {
  const base = resolveEnv('dev');
  return { ...base, notification: { ...base.notification, alarmEmail } };
};

/**
 * WebMonitoringStack は WebStack のリソース参照を受け取るため、テストでは
 * `.open-next` 成果物に依存しないダミー Lambda / Table を fixture stack に立てて渡す。
 */
const synth = (config: EnvConfig = resolveEnv('dev')) => {
  const app = new cdk.App();
  const fixture = new cdk.Stack(app, 'Fixture', { env: ENV });
  const makeFn = (id: string) =>
    new lambda.Function(fixture, id, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
      timeout: cdk.Duration.seconds(config.web.serverTimeoutSec),
    });
  const table = new dynamodb.Table(fixture, 'Table', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  });
  const stack = new WebMonitoringStack(app, 'TestWebMonitoring', {
    env: ENV,
    config,
    serverFn: makeFn('ServerFn'),
    imageFn: makeFn('ImageFn'),
    table,
    distributionId: 'EDFDVBD6EXAMPLE',
  });
  return Template.fromStack(stack);
};

describe('WebMonitoringStack (#299)', () => {
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

  it('creates 8 alarms: server(Errors/Throttles/Duration/Concurrent) + image(Errors/Duration) + ddb(read/write)', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 8);
  });

  it('alarms notify the SNS topic and treat missing data as notBreaching', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    for (const alarm of Object.values(alarms)) {
      const props = alarm.Properties as {
        AlarmActions?: unknown[];
        TreatMissingData?: string;
      };
      expect(props.AlarmActions).toHaveLength(1);
      expect(props.TreatMissingData).toBe('notBreaching');
    }
  });

  it('alarms on server Lambda errors and throttles (Sum >= 1 / 5min)', () => {
    for (const metricName of ['Errors', 'Throttles']) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/Lambda',
        MetricName: metricName,
        Statistic: 'Sum',
        Period: 300,
        Threshold: 1,
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    }
  });

  it('alarms on Lambda duration p95 above 80% of timeout (server + image)', () => {
    // serverTimeoutSec=30 の 80% = 24000ms。server / image の 2 本。
    template.resourcePropertiesCountIs(
      'AWS::CloudWatch::Alarm',
      {
        Namespace: 'AWS/Lambda',
        MetricName: 'Duration',
        ExtendedStatistic: 'p95',
        Threshold: 24000,
        EvaluationPeriods: 3,
        ComparisonOperator: 'GreaterThanThreshold',
      },
      2,
    );
  });

  it('alarms on server Lambda concurrent executions approaching the account limit', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'ConcurrentExecutions',
      Statistic: 'Maximum',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 800,
    });
  });

  it('alarms on DynamoDB throttled requests for read and write operations', () => {
    // read/write 別のアラーム。オンデマンドのため math expression（Metrics 配列）になる。
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const throttleAlarms = Object.values(alarms).filter((alarm) => {
      const props = alarm.Properties as { Metrics?: { MetricStat?: { Metric?: { MetricName?: string } } }[] };
      return (props.Metrics ?? []).some(
        (m) => m.MetricStat?.Metric?.MetricName === 'ThrottledRequests',
      );
    });
    expect(throttleAlarms).toHaveLength(2);
    const bodies = JSON.stringify(throttleAlarms);
    expect(bodies).toContain('GetItem');
    expect(bodies).toContain('PutItem');
  });

  it('creates one dashboard with Lambda / DynamoDB / CloudFront widgets', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'open-reception-dev-web',
    });
    const body = JSON.stringify(template.findResources('AWS::CloudWatch::Dashboard'));
    // CloudFront メトリクスは us-east-1 にのみ発行される。ダッシュボードはリージョン跨ぎ
    // 参照が可能なので us-east-1 を明示して widget 化する。
    expect(body).toContain('AWS/CloudFront');
    expect(body).toContain('us-east-1');
    expect(body).toContain('5xxErrorRate');
    expect(body).toContain('BytesDownloaded');
    expect(body).toContain('EDFDVBD6EXAMPLE');
    expect(body).toContain('ConsumedReadCapacityUnits');
    expect(body).toContain('ConsumedWriteCapacityUnits');
  });
});

const OPEN_NEXT_READY = fs.existsSync(
  path.join(__dirname, '..', '..', '.open-next', 'open-next.output.json'),
);

// 実 WebStack との配線（public メンバ公開）を end-to-end で検証する。
describe.runIf(OPEN_NEXT_READY)('WebStack -> WebMonitoringStack wiring (#299)', () => {
  it('WebStack exposes serverFn/imageFn/dataTable/distribution and WebMonitoringStack consumes them', () => {
    const app = new cdk.App();
    const web = new WebStack(app, 'TestWebForMonitoring', {
      env: ENV,
      config: resolveEnv('dev'),
      appEnv: { ADMIN_AUTH_PROVIDER: 'none' },
    });
    const monitoring = new WebMonitoringStack(app, 'TestWebMonitoringWired', {
      env: ENV,
      config: resolveEnv('dev'),
      serverFn: web.serverFn,
      imageFn: web.imageFn,
      table: web.dataTable,
      distributionId: web.distribution.distributionId,
    });
    const template = Template.fromStack(monitoring);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 8);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  }, 60000);
});
