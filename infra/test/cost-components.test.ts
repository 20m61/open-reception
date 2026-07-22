import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CloudFrontMonitoringStack } from '../lib/stacks/cloudfront-monitoring-stack';
import { MonitoringStack } from '../lib/stacks/monitoring-stack';
import { WebMonitoringStack } from '../lib/stacks/web-monitoring-stack';
import { NotificationStack } from '../lib/stacks/notification-stack';
import { resolveEnv } from '../lib/config/environments';
import { COST_TAG_COMPONENTS } from '../lib/config/cost-components';
import { overrideComponentTag } from '../lib/constructs/cost-tags';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

const ENV = { account: '123456789012', region: 'ap-northeast-1' };
const US_EAST_1 = { account: '123456789012', region: 'us-east-1' };

const BIN_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'bin', 'open-reception.ts'),
  'utf-8',
);
const DOMAIN_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'domain', 'platform', 'aws-cost.ts'),
  'utf-8',
);

/**
 * `COST_COMPONENT_FILTERS`（`src/domain/platform/aws-cost.ts`）は配列リテラルとして定義される。
 * 単純な正規表現で値を抜き出し、`all`（実タグ値ではなく「絞り込みなし」を表すフィルタ専用の値）を
 * 除いたものが Component タグ値の allow-list になる。
 */
function extractDomainComponentFilters(source: string): string[] {
  const match = source.match(/COST_COMPONENT_FILTERS\s*=\s*\[([\s\S]*?)\]/);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error('COST_COMPONENT_FILTERS の定義が見つかりません（src/domain/platform/aws-cost.ts）');
  }
  return body
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''))
    .filter((entry) => entry.length > 0 && entry !== 'all');
}

describe('Component タグ allow-list の drift 防止 (#379)', () => {
  it('infra 側の COST_TAG_COMPONENTS と domain 側の COST_COMPONENT_FILTERS が一致する（"all" を除く）', () => {
    const infraValues = Object.values(COST_TAG_COMPONENTS).slice().sort();
    const domainValues = extractDomainComponentFilters(DOMAIN_SOURCE).slice().sort();
    expect(infraValues).toEqual(domainValues);
  });

  it('bin/open-reception.ts は 3 つの監視 Stack すべてを overrideComponentTag(..., COST_TAG_COMPONENTS.xxx) で上書きする', () => {
    // 生の cdk.Tags.of(...).add('Component', ...) 直書きへの後退（マジックストリング再導入）を検知する。
    expect(BIN_SOURCE).not.toMatch(/Tags\.of\([^)]*\)\.add\(\s*'Component'/);

    const expectedCalls = [
      `overrideComponentTag(webMonitoring, COST_TAG_COMPONENTS.webMonitoring)`,
      `overrideComponentTag(cloudFrontMonitoring, COST_TAG_COMPONENTS.cloudFrontMonitoring)`,
      `overrideComponentTag(monitoring, COST_TAG_COMPONENTS.monitoring)`,
    ];
    for (const call of expectedCalls) {
      expect(BIN_SOURCE).toContain(call);
    }
    expect(BIN_SOURCE.match(/overrideComponentTag\(/g)).toHaveLength(expectedCalls.length);
  });
});

/**
 * bin/open-reception.ts と同じ手順（Stack 構築 → overrideComponentTag）を再現し、
 * `applyCostTags` が Stack 自身に付けた既定 Component タグ（priority 既定値）を
 * `{priority: 200}` の上書きが実際に CloudFormation 出力レベルで勝つことを検証する。
 * (前者は「呼んでいるか」、こちらは「呼んだ結果タグが本当に上書きされるか」を担保する。)
 */
describe('overrideComponentTag による Component タグ上書き (#379, Template.fromStack)', () => {
  it('WebMonitoringStack: 既定 Component=web を web-monitoring へ上書きする', () => {
    const app = new cdk.App();
    const config = resolveEnv('dev');
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

    overrideComponentTag(stack, COST_TAG_COMPONENTS.webMonitoring);

    Template.fromStack(stack).hasResourceProperties('AWS::SNS::Topic', {
      Tags: Match.arrayWith([{ Key: 'Component', Value: 'web-monitoring' }]),
    });
  });

  it('CloudFrontMonitoringStack: 既定 Component=web を cloudfront-monitoring へ上書きする', () => {
    const app = new cdk.App();
    const stack = new CloudFrontMonitoringStack(app, 'TestCfMonitoring', {
      env: US_EAST_1,
      config: resolveEnv('dev'),
      distributionId: 'EDFDVBD6EXAMPLE',
    });

    overrideComponentTag(stack, COST_TAG_COMPONENTS.cloudFrontMonitoring);

    Template.fromStack(stack).hasResourceProperties('AWS::SNS::Topic', {
      Tags: Match.arrayWith([{ Key: 'Component', Value: 'cloudfront-monitoring' }]),
    });
  });

  it('MonitoringStack: 既定 Component=notification を monitoring へ上書きする', () => {
    const app = new cdk.App();
    const config = resolveEnv('dev');
    const notification = new NotificationStack(app, 'TestNotif', { env: ENV, config });
    const stack = new MonitoringStack(app, 'TestMon', {
      env: ENV,
      config,
      notificationFn: notification.notificationFn.fn,
      httpApi: notification.api.httpApi,
    });

    overrideComponentTag(stack, COST_TAG_COMPONENTS.monitoring);

    Template.fromStack(stack).hasResourceProperties('AWS::SNS::Topic', {
      Tags: Match.arrayWith([{ Key: 'Component', Value: 'monitoring' }]),
    });
    // 上書き対象外の NotificationStack は既定の Component=notification のまま。
    Template.fromStack(notification).hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Tags: Match.objectLike({ Component: 'notification' }),
    });
  });
});
