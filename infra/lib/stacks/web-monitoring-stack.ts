import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { EnvConfig } from '../config/environments';
import { applyCostTags } from '../constructs/cost-tags';

export interface WebMonitoringStackProps extends StackProps {
  readonly config: EnvConfig;
  /** WebStack の server Lambda（SSR / Route Handlers）。 */
  readonly serverFn: lambda.IFunction;
  /** WebStack の image optimization Lambda。 */
  readonly imageFn: lambda.IFunction;
  /** WebStack の業務データ DynamoDB テーブル。 */
  readonly table: dynamodb.ITable;
  /** WebStack の CloudFront Distribution ID（ダッシュボードの CloudFront widget に使用）。 */
  readonly distributionId: string;
}

/**
 * Lambda の既定アカウント同時実行上限 (1000) に対する警告しきい値（80%）。
 * 本システムの平常時同時実行は 1 桁のため、これに近づくのは異常（暴走/攻撃）シグナル。
 */
const CONCURRENT_EXECUTIONS_THRESHOLD = 800;

/** DynamoDB の読み取り系オペレーション（スロットル監視対象）。 */
const DDB_READ_OPERATIONS = [
  dynamodb.Operation.GET_ITEM,
  dynamodb.Operation.BATCH_GET_ITEM,
  dynamodb.Operation.QUERY,
  dynamodb.Operation.SCAN,
  dynamodb.Operation.TRANSACT_GET_ITEMS,
];

/** DynamoDB の書き込み系オペレーション（スロットル監視対象）。 */
const DDB_WRITE_OPERATIONS = [
  dynamodb.Operation.PUT_ITEM,
  dynamodb.Operation.BATCH_WRITE_ITEM,
  dynamodb.Operation.UPDATE_ITEM,
  dynamodb.Operation.DELETE_ITEM,
  dynamodb.Operation.TRANSACT_WRITE_ITEMS,
];

/**
 * WebStack（本番トラフィックの主経路）の監視 Stack (issue #299)。
 *
 * server/image Lambda・DynamoDB のアラームと、CloudFront を含む運用ダッシュボードを提供する。
 * しきい値・period は MonitoringStack（通知サブシステム）の流儀（5分 / notBreaching）に合わせる。
 *
 * 設計判断:
 * - **MonitoringStack と分離**: MonitoringStack は cost tag component='notification' で通知
 *   サブシステム専用。web 系を混ぜるとコスト按分が壊れ、また WebStack のデプロイが通知系に
 *   結合する。component='web' の別 Stack として独立デプロイ可能にする。
 * - **SNS Topic も分離**: MonitoringStack.topic を共用すると WebStack 系のデプロイ順序が
 *   Notification/Monitoring に依存してしまう。Topic 自体は無料に近く、alarmEmail は両方の
 *   Topic に同じ context (`-c alarmEmail=...`) から購読されるため運用は変わらない。
 * - **CloudFront 5xxErrorRate の「アラーム」は見送り**: AWS/CloudFront メトリクスは us-east-1
 *   にのみ発行され、CloudWatch アラームはメトリクスと同一リージョンにしか置けない。us-east-1 の
 *   別 Stack + crossRegionReferences（custom resource 追加）に見合う価値がないため、リージョン
 *   跨ぎ参照が可能な**ダッシュボード widget** でカバーし、アラーム化は follow-up とする。
 *   オリジン起因の 5xx は server/image Lambda Errors アラームで実質的に検知できる。
 */
export class WebMonitoringStack extends Stack {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: WebMonitoringStackProps) {
    super(scope, id, props);
    const { config, serverFn, imageFn, table, distributionId } = props;
    applyCostTags(this, config, 'web');

    this.topic = new sns.Topic(this, 'AlarmTopic', {
      displayName: `${config.prefix} web alarms`,
    });
    if (config.notification.alarmEmail) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(config.notification.alarmEmail));
    }
    const action = new cwactions.SnsAction(this.topic);

    const durationThresholdMs =
      Duration.seconds(config.web.serverTimeoutSec).toMilliseconds() * 0.8;

    // --- server Lambda ---
    const serverErrors = serverFn
      .metricErrors({ period: Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'ServerErrors', {
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'server Lambda のエラー発生',
      });
    serverErrors.addAlarmAction(action);

    const serverThrottles = serverFn
      .metricThrottles({ period: Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'ServerThrottles', {
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'server Lambda のスロットル発生',
      });
    serverThrottles.addAlarmAction(action);

    const serverLatency = serverFn
      .metricDuration({ period: Duration.minutes(5), statistic: 'p95' })
      .createAlarm(this, 'ServerDurationP95', {
        threshold: durationThresholdMs,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'server Lambda の p95 遅延がタイムアウト 80% を超過',
      });
    serverLatency.addAlarmAction(action);

    const serverConcurrent = serverFn
      .metric('ConcurrentExecutions', { period: Duration.minutes(5), statistic: 'Maximum' })
      .createAlarm(this, 'ServerConcurrentExecutions', {
        threshold: CONCURRENT_EXECUTIONS_THRESHOLD,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'server Lambda の同時実行数がアカウント既定上限 (1000) の 80% に到達（暴走/攻撃の兆候）',
      });
    serverConcurrent.addAlarmAction(action);

    // --- image Lambda ---
    const imageErrors = imageFn
      .metricErrors({ period: Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'ImageErrors', {
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'image Lambda のエラー発生',
      });
    imageErrors.addAlarmAction(action);

    const imageLatency = imageFn
      .metricDuration({ period: Duration.minutes(5), statistic: 'p95' })
      .createAlarm(this, 'ImageDurationP95', {
        threshold: durationThresholdMs,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'image Lambda の p95 遅延がタイムアウト 80% を超過',
      });
    imageLatency.addAlarmAction(action);

    // --- DynamoDB（オンデマンド）スロットル ---
    // PAY_PER_REQUEST でもテーブル/パーティション上限超過でスロットルは起こり得る。
    // Operation 次元付き ThrottledRequests を read/write で分けてアラーム化する。
    const readThrottles = table.metricThrottledRequestsForOperations({
      operations: DDB_READ_OPERATIONS,
      period: Duration.minutes(5),
    });
    const ddbReadThrottles = new cloudwatch.Alarm(this, 'DdbReadThrottles', {
      metric: readThrottles,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'DynamoDB 読み取りスロットル発生（オンデマンド上限/ホットパーティション）',
    });
    ddbReadThrottles.addAlarmAction(action);

    const writeThrottles = table.metricThrottledRequestsForOperations({
      operations: DDB_WRITE_OPERATIONS,
      period: Duration.minutes(5),
    });
    const ddbWriteThrottles = new cloudwatch.Alarm(this, 'DdbWriteThrottles', {
      metric: writeThrottles,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'DynamoDB 書き込みスロットル発生（オンデマンド上限/ホットパーティション）',
    });
    ddbWriteThrottles.addAlarmAction(action);

    // --- ダッシュボード ---
    // CloudFront メトリクス (AWS/CloudFront) は us-east-1 にのみ発行される。アラームは同一
    // リージョン制約があるが、ダッシュボード widget はリージョン跨ぎ参照が可能なので
    // region を明示して表示する。
    const cloudFrontMetric = (metricName: string, statistic: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName,
        dimensionsMap: { DistributionId: distributionId, Region: 'Global' },
        region: 'us-east-1',
        period: Duration.minutes(5),
        statistic,
      });

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${config.prefix}-web`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Server Lambda',
        left: [serverFn.metricInvocations(), serverFn.metricErrors(), serverFn.metricThrottles()],
        right: [serverFn.metricDuration({ statistic: 'p95' })],
      }),
      new cloudwatch.GraphWidget({
        title: 'Image Lambda',
        left: [imageFn.metricInvocations(), imageFn.metricErrors()],
        right: [imageFn.metricDuration({ statistic: 'p95' })],
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB',
        left: [
          table.metricConsumedReadCapacityUnits(),
          table.metricConsumedWriteCapacityUnits(),
        ],
        right: [readThrottles, writeThrottles],
      }),
      new cloudwatch.GraphWidget({
        title: 'CloudFront (us-east-1)',
        left: [cloudFrontMetric('Requests', 'Sum'), cloudFrontMetric('BytesDownloaded', 'Sum')],
        right: [cloudFrontMetric('5xxErrorRate', 'Average')],
      }),
    );
  }
}
