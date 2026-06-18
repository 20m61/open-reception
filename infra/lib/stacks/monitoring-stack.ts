import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { EnvConfig } from '../config/environments';
import { applyCostTags } from '../constructs/cost-tags';

export interface MonitoringStackProps extends StackProps {
  readonly config: EnvConfig;
  readonly notificationFn: lambda.IFunction;
  readonly httpApi: apigwv2.HttpApi;
}

/**
 * 監視 Stack (DESIGN #34 §2, §8)。
 * 通知 Lambda のエラー/遅延/スロットルと API 5xx をアラーム化し、SNS で通知する。
 */
export class MonitoringStack extends Stack {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);
    const { config, notificationFn, httpApi } = props;
    applyCostTags(this, config, 'notification');

    this.topic = new sns.Topic(this, 'AlarmTopic', {
      displayName: `${config.prefix} notification alarms`,
    });
    if (config.notification.alarmEmail) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(config.notification.alarmEmail));
    }
    const action = new cwactions.SnsAction(this.topic);

    // Lambda エラー数
    const errors = notificationFn
      .metricErrors({ period: Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'NotificationErrors', {
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: '通知 Lambda のエラー発生',
      });
    errors.addAlarmAction(action);

    // Lambda 遅延 p95
    const latency = notificationFn
      .metricDuration({ period: Duration.minutes(5), statistic: 'p95' })
      .createAlarm(this, 'NotificationLatencyP95', {
        threshold: Duration.seconds(config.notification.timeoutSec).toMilliseconds() * 0.8,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: '通知 Lambda の p95 遅延がタイムアウト 80% を超過',
      });
    latency.addAlarmAction(action);

    // Lambda スロットル
    const throttles = notificationFn
      .metricThrottles({ period: Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'NotificationThrottles', {
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: '通知 Lambda のスロットル発生',
      });
    throttles.addAlarmAction(action);

    // API Gateway 5xx
    const api5xx = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '5xx',
      dimensionsMap: { ApiId: httpApi.apiId },
      period: Duration.minutes(5),
      statistic: 'Sum',
    }).createAlarm(this, 'Api5xx', {
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: '通知 API の 5xx 応答',
    });
    api5xx.addAlarmAction(action);

    // ダッシュボード
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${config.prefix}-notification`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Notification Lambda',
        left: [notificationFn.metricInvocations(), notificationFn.metricErrors()],
        right: [notificationFn.metricDuration({ statistic: 'p95' })],
      }),
      new cloudwatch.GraphWidget({
        title: 'API 4xx / 5xx',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '4xx',
            dimensionsMap: { ApiId: httpApi.apiId },
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5xx',
            dimensionsMap: { ApiId: httpApi.apiId },
          }),
        ],
      }),
    );
  }
}
