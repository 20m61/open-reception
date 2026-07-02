import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { EnvConfig } from '../config/environments';
import { applyCostTags } from '../constructs/cost-tags';

export interface CloudFrontMonitoringStackProps extends StackProps {
  readonly config: EnvConfig;
  /**
   * 監視対象 CloudFront Distribution の ID。WebStack (ap-northeast-1) からの参照は
   * `crossRegionReferences: true`（SSM ベースの ExportWriter/Reader custom resource）で解決する。
   */
  readonly distributionId: string;
}

/**
 * 5xxErrorRate のしきい値 (%)。
 *
 * 平常時の 5xx は 0% が期待値であり、1% は「リクエストの 1/100 が失敗」という明確な異常。
 * 低トラフィック時は 1 リクエストの失敗でも 1 期間の rate が跳ね上がる（1 件 / 数件 = 数十%）
 * ため、evaluationPeriods=3（15 分継続）と組み合わせて単発ノイズでの発報を抑えつつ、
 * 持続的な障害（オリジン非到達・設定破壊など）は 15 分以内に検知する。
 */
const FIVE_XX_ERROR_RATE_THRESHOLD_PERCENT = 1;

/**
 * CloudFront の監視 Stack (issue #303) — **us-east-1 専用**。
 *
 * AWS/CloudFront メトリクス（DistributionId + Region='Global' 次元）は us-east-1 にのみ
 * 発行され、CloudWatch アラームはメトリクスと同一リージョンにしか置けない。そのため
 * WebMonitoringStack (ap-northeast-1) では 5xxErrorRate をダッシュボード widget（リージョン
 * 跨ぎ参照可）でしかカバーできず、アラームは本 Stack が us-east-1 で持つ。
 *
 * 設計判断:
 * - **DistributionId 連携は `crossRegionReferences: true`**（bin で WebStack と本 Stack の
 *   双方に指定）。CloudFormation Export（Fn::ImportValue のデプロイロック）ではなく
 *   SSM Parameter 経由の custom resource（ExportWriter/Reader）で連携されるため、既存
 *   WebStack には writer リソースが「追加」されるだけで、既存リソースの変更・置換や
 *   既存 Export への影響はない（テストで検証）。context 手渡し案（`-c distributionId=...`）
 *   はデプロイ手順に手動値コピーが増え、渡し忘れ/環境取り違えの事故点になるため不採用。
 * - **SNS Topic は us-east-1 に別途作成**: アラームアクションの SNS Topic はアラームと
 *   同一リージョンである必要があるため、ap-northeast-1 の Topic は使えない。alarmEmail は
 *   既存の流儀どおり `-c alarmEmail=...` context から購読する。
 * - **4xxErrorRate のアラームは持たない**: 4xx はボットのパス探索や誤リンクで恒常的に
 *   発生しうるノイズ源で、可用性シグナルとしては 5xx + Lambda Errors で足りる。
 */
export class CloudFrontMonitoringStack extends Stack {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: CloudFrontMonitoringStackProps) {
    super(scope, id, props);
    const { config, distributionId } = props;
    applyCostTags(this, config, 'web');

    this.topic = new sns.Topic(this, 'AlarmTopic', {
      displayName: `${config.prefix} cloudfront alarms`,
    });
    if (config.notification.alarmEmail) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(config.notification.alarmEmail));
    }
    const action = new cwactions.SnsAction(this.topic);

    const fiveXxErrorRate = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: '5xxErrorRate',
      dimensionsMap: { DistributionId: distributionId, Region: 'Global' },
      period: Duration.minutes(5),
      statistic: 'Average',
    });
    const fiveXxAlarm = fiveXxErrorRate.createAlarm(this, 'CloudFront5xxErrorRate', {
      threshold: FIVE_XX_ERROR_RATE_THRESHOLD_PERCENT,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'CloudFront 5xxErrorRate が 1% を 15 分継続（オリジン非到達・設定破壊などの持続的障害）',
    });
    fiveXxAlarm.addAlarmAction(action);
  }
}
