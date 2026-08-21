import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { WebMonitoringStack } from '../lib/stacks/web-monitoring-stack';
import { WebStack } from '../lib/stacks/web-stack';
import { resolveEnv, EnvConfig } from '../lib/config/environments';
import { openNextArtifactState, describeArtifactState } from '../lib/build-artifacts';
import { ORIGIN_VERIFY_LOG_MARKERS } from '../../src/lib/security/origin-verify';
import { KIOSK_DIAL_LOG_MARKERS } from '../../src/lib/routing/dial-log-markers';

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

  it('creates 12 alarms: server(Errors/Throttles/Duration/Concurrent) + image(Errors/Duration) + ddb(read/write) + account concurrent + origin-verify(missing-secret/mismatch) + 取次不能', () => {
    // #630 で origin-verify の 2 本を追加（9 → 11）。#764 で取次不能を追加（11 → 12）。
    // 件数を固定しているのは、アラームが**黙って消える**のを検出するため
    // （増やす側は必ずここを更新する）。
    template.resourceCountIs('AWS::CloudWatch::Alarm', 12);
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

  it('alarms on region-wide (dimensionless) Lambda concurrent executions (#303)', () => {
    // per-function メトリクスではアカウント共有上限 (1000) の枯渇を過小検知するため、
    // 次元なし（リージョン全体）の ConcurrentExecutions アラームを別に持つ。
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const dimensionless = Object.values(alarms).filter((alarm) => {
      const props = alarm.Properties as {
        Namespace?: string;
        MetricName?: string;
        Dimensions?: unknown[];
      };
      return (
        props.Namespace === 'AWS/Lambda' &&
        props.MetricName === 'ConcurrentExecutions' &&
        props.Dimensions === undefined
      );
    });
    expect(dimensionless).toHaveLength(1);
    const props = dimensionless[0]?.Properties as
      | {
          Statistic?: string;
          Threshold?: number;
          Period?: number;
          TreatMissingData?: string;
        }
      | undefined;
    expect(props?.Statistic).toBe('Maximum');
    expect(props?.Threshold).toBe(800);
    expect(props?.Period).toBe(300);
    expect(props?.TreatMissingData).toBe('notBreaching');
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


describe('origin-verify の拒否をアラームへ載せる (#630)', () => {
  // middleware が返す 403/503 は Lambda としては**成功した呼び出し**なので、
  // Errors / Throttles / Duration のどれにも現れない。ログ由来のメトリクスで拾う。
  const template = synth(configWithAlarmEmail('ops@example.com'));

  it('missing-secret と mismatch を別々のメトリクスにする', () => {
    // 混ぜると「攻撃されている」と「自分が壊れている」を切り分けられない。
    // 3 本目は取次不能 (#764)。件数で縛るのは、フィルタを 1 つに束ねる変更を止めるため。
    template.resourceCountIs('AWS::Logs::MetricFilter', 3);
  });

  it('メトリクスフィルタは実際のログ文言（共有定数）で検索する', () => {
    // 🔴 ここがこの機能の急所。文言がずれるとアラームは**黙って鳴らなくなる**。
    for (const marker of [
      ORIGIN_VERIFY_LOG_MARKERS.missingSecret,
      ORIGIN_VERIFY_LOG_MARKERS.mismatch,
    ]) {
      template.hasResourceProperties('AWS::Logs::MetricFilter', {
        FilterPattern: Match.stringLikeRegexp(escapeForRegexp(marker)),
      });
    }
  });

  it('missing-secret は 1 件でもアラームにする（配備側の自損で全断）', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'OriginVerifyMissingSecret',
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      // 欠測を「異常」にすると、平常時（ログ 0 行）に鳴り続ける。
      TreatMissingData: 'notBreaching',
    });
  });

  it('mismatch は単発では鳴らさない（直叩きは正常動作で、攻撃者が任意に発火できる）', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'OriginVerifyMismatch',
      TreatMissingData: 'notBreaching',
    });
    const alarms = template.findResources('AWS::CloudWatch::Alarm', {
      Properties: { MetricName: 'OriginVerifyMismatch' },
    });
    const [alarm] = Object.values(alarms);
    if (!alarm) throw new Error('OriginVerifyMismatch alarm not found');
    expect(alarm.Properties.Threshold).toBeGreaterThan(1);
  });

  it('両アラームとも SNS トピックへ通知する（作っただけで届かないのを防ぐ）', () => {
    for (const metric of ['OriginVerifyMissingSecret', 'OriginVerifyMismatch']) {
      const alarms = template.findResources('AWS::CloudWatch::Alarm', {
        Properties: { MetricName: metric },
      });
      const [alarm] = Object.values(alarms);
      if (!alarm) throw new Error(`alarm not found: ${metric}`);
      expect(alarm.Properties.AlarmActions, metric).toBeDefined();
      expect(alarm.Properties.AlarmActions.length, metric).toBeGreaterThan(0);
    }
  });
});

describe('取り次げず来訪者を追い返したことをアラームへ載せる (#764 / #736)', () => {
  // この経路は `startCall` に到達しないので受付履歴にもメトリクスにも残らず、503 は
  // Lambda としては成功した呼び出しなので Errors にも出ない。ログ以外に手掛かりが無い。
  const template = synth(configWithAlarmEmail('ops@example.com'));

  it('🔴 メトリクスフィルタは実際のログ文言（共有定数）で検索する', () => {
    // 文言がずれるとアラームは**黙って鳴らなくなる**。定数を 1 箇所に置く理由そのもの。
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: Match.stringLikeRegexp(
        escapeForRegexp(KIOSK_DIAL_LOG_MARKERS.realDialingUnavailable),
      ),
    });
  });

  it('🔴 1 件でも鳴らす（出た時点で来訪者が追い返されている）', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'KioskRealDialingUnavailable',
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      // 欠測を「異常」にすると、平常時（ログ 0 行）に鳴り続ける。
      TreatMissingData: 'notBreaching',
    });
  });

  it('🔴 SNS トピックへ通知する（作っただけで届かないのを防ぐ）', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm', {
      Properties: { MetricName: 'KioskRealDialingUnavailable' },
    });
    const [alarm] = Object.values(alarms);
    if (!alarm) throw new Error('KioskRealDialingUnavailable alarm not found');
    expect(alarm.Properties.AlarmActions?.length ?? 0).toBeGreaterThan(0);
  });
});

/** 正規表現メタ文字を含むマーカー（`[origin-verify]`）をそのまま検索するため。 */
function escapeForRegexp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `web-stack.test.ts` と同じ判定を使う。存在だけを見ると stale で synth が throw する (#628)。
const ARTIFACTS = openNextArtifactState(path.join(__dirname, '..', '..'));
const OPEN_NEXT_READY = ARTIFACTS.state === 'fresh';
if (!OPEN_NEXT_READY) {
  console.warn(`[infra] WebStack wiring suite skipped: ${describeArtifactState(ARTIFACTS)}`);
}

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
    // #630 で origin-verify の 2 本を追加（9 → 11）。#764 で取次不能を追加（11 → 12）。
    // **実 WebStack の serverFn を渡す経路**なので、ここが通ることは
    // 「メトリクスフィルタが実 Lambda のロググループに着く」ことの確認でもある。
    template.resourceCountIs('AWS::CloudWatch::Alarm', 12);
    template.resourceCountIs('AWS::Logs::MetricFilter', 3);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  }, 60000);
});
