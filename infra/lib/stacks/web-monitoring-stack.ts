import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvConfig } from '../config/environments';
import { applyCostTags } from '../constructs/cost-tags';
import { ORIGIN_VERIFY_LOG_MARKERS } from '../../../src/lib/security/origin-verify';
import { KIOSK_DIAL_LOG_MARKERS } from '../../../src/lib/routing/dial-log-markers';

/**
 * mismatch アラームのしきい値（5 分あたりの遷移ログ件数）(#630)。
 *
 * ログは**状態遷移時のみ**出るので、平常時のスキャンでは 1 インスタンスあたり数行に留まる。
 * ローテーションずれで全インスタンスが落ちると桁が変わる。単発で鳴らさないのが要点。
 */
const ORIGIN_VERIFY_MISMATCH_THRESHOLD = 10;

export interface WebMonitoringStackProps extends StackProps {
  readonly config: EnvConfig;
  /**
   * WebStack の server Lambda（SSR / Route Handlers）。
   *
   * **`IFunction` ではなく具象 `Function`**。origin-verify のメトリクスフィルタ (#630) が
   * `logGroup` を要求するが、`IFunction` はこれを公開していない。WebStack は
   * `logGroup` を明示生成して渡しているので（`makeLogGroup('ServerFnLogs')`）、
   * 具象で受ければ「ログググループが確実に存在する」ことも型で担保できる。
   */
  readonly serverFn: lambda.Function;
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
 * - **CloudFront 5xxErrorRate の「アラーム」は本 Stack にはない**: AWS/CloudFront メトリクスは
 *   us-east-1 にのみ発行され、CloudWatch アラームはメトリクスと同一リージョンにしか置けない。
 *   本 Stack はリージョン跨ぎ参照が可能な**ダッシュボード widget** でのみカバーし、アラームは
 *   us-east-1 の CloudFrontMonitoringStack (#303) が持つ。
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

    // --- リージョン全体（アカウント）の Lambda 同時実行 (#303) ---
    // ConcurrentExecutions の上限 (1000) はアカウント × リージョンで共有される。per-function
    // メトリクスだけでは「各関数は上限未満だが合計で枯渇」を過小検知するため、次元なし
    // （リージョン全体）のメトリクスでも同じしきい値で監視する。
    const accountConcurrent = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'ConcurrentExecutions',
      period: Duration.minutes(5),
      statistic: 'Maximum',
    }).createAlarm(this, 'AccountConcurrentExecutions', {
      threshold: CONCURRENT_EXECUTIONS_THRESHOLD,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'リージョン全体の Lambda 同時実行数がアカウント既定上限 (1000) の 80% に到達（共有上限の枯渇兆候）',
    });
    accountConcurrent.addAlarmAction(action);

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
    // ---- origin-verify の拒否 (#630) --------------------------------------
    //
    // middleware が返す 403/503 は **Lambda としては成功した呼び出し**なので、
    // Errors / Throttles / Duration のどれにも現れない。origin-verify は fail-closed で、
    // 条件が揃うと全リクエストが落ちるのに、その全断が既存のアラームに一切かからなかった。
    //
    // **CloudFront の 4xx レートは使わない。** ボットのパス探索や誤リンクで恒常的に発生する
    // ノイズ源で（`CloudFrontMonitoringStack` が 4xx アラームを持たないのも同じ理由）、
    // 「直叩きされた」と「配備が壊れた」を分離できない。代わりに**アプリが出す拒否ログ**を
    // メトリクス化する。文言は `ORIGIN_VERIFY_LOG_MARKERS` をアプリと共有しているので、
    // 書き換えてもフィルタが黙って外れることはない。
    //
    // なお `missing-secret` は 503 を返すため CloudFront 5xxErrorRate アラームにも部分的に
    // かかるが、あちらは率（1%/15 分）なので**低トラフィックの受付端末では分母が小さく暴れる**。
    // ここでは件数で見て、種別も分ける。
    const originVerifyNamespace = `OpenReception/${config.environment}/OriginVerify`;
    const originVerifyMetric = (id: string, marker: string, metricName: string) =>
      new logs.MetricFilter(this, id, {
        logGroup: serverFn.logGroup,
        // CloudWatch Logs のフィルタパターンは、引用符で囲むと部分一致検索になる。
        filterPattern: logs.FilterPattern.literal(`"${marker}"`),
        metricNamespace: originVerifyNamespace,
        metricName,
        metricValue: '1',
      }).metric({ statistic: 'Sum', period: Duration.minutes(5) });

    // 配備側の自損。**1 行でも出たら全リクエストが 503** なので即座に上げる。
    const missingSecretAlarm = new cloudwatch.Alarm(this, 'OriginVerifyMissingSecret', {
      metric: originVerifyMetric(
        'OriginVerifyMissingSecretFilter',
        ORIGIN_VERIFY_LOG_MARKERS.missingSecret,
        'OriginVerifyMissingSecret',
      ),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'origin-verify のシークレットが未解決。全リクエストが 503（配備側の障害・即対応）',
    });
    missingSecretAlarm.addAlarmAction(action);

    // 直叩きは**正常動作**で、攻撃者が任意に発火できる。単発で鳴らすと無視する習慣がつく。
    // ログは状態遷移時のみ出るので、平常時のスキャンでは「一部インスタンスに数行」に留まる。
    // 全インスタンスがローテーションずれで落ちると桁が変わるため、件数で切り分ける。
    const mismatchAlarm = new cloudwatch.Alarm(this, 'OriginVerifyMismatch', {
      metric: originVerifyMetric(
        'OriginVerifyMismatchFilter',
        ORIGIN_VERIFY_LOG_MARKERS.mismatch,
        'OriginVerifyMismatch',
      ),
      threshold: ORIGIN_VERIFY_MISMATCH_THRESHOLD,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'origin-verify の mismatch が継続。ローテーションで CloudFront と Lambda がずれた疑い',
    });
    mismatchAlarm.addAlarmAction(action);

    // 取り次げずに来訪者を追い返したことを検出する (#764 / #736)。
    //
    // このルートは `startCall` に到達しないので、**受付履歴にもメトリクスにも 1 件も残らない**。
    // 503 は Lambda としては成功した呼び出しなので Errors にも現れず、CloudFront の
    // 5xxErrorRate アラームはそもそも存在しない。つまりログをメトリクス化しない限り、
    // 運用者が気づく手掛かりはゼロになる ── #736 が直そうとした「設定不備に気づけない」が
    // そのまま残る。
    //
    // **1 件でも鳴らす。** 出たということは、実発信を設定したテナントで来訪者が
    // 実際に追い返されたということ。origin-verify の `missing-secret` と同じ扱い。
    const dialUnavailableAlarm = new cloudwatch.Alarm(this, 'KioskRealDialingUnavailable', {
      metric: new logs.MetricFilter(this, 'KioskRealDialingUnavailableFilter', {
        logGroup: serverFn.logGroup,
        // 引用符で囲むと部分一致検索になる（JSON 1 行ログの中の値を拾う）。
        filterPattern: logs.FilterPattern.literal(
          `"${KIOSK_DIAL_LOG_MARKERS.realDialingUnavailable}"`,
        ),
        metricNamespace: `OpenReception/${config.environment}/Reception`,
        metricName: 'KioskRealDialingUnavailable',
        metricValue: '1',
      }).metric({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // 欠測を「異常」にすると、平常時（ログ 0 行）に鳴り続ける。
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        '実発信を設定したテナントで取り次げず、来訪者を追い返している（資格情報・ルート・設定ストアのいずれかの不備）',
    });
    dialUnavailableAlarm.addAlarmAction(action);

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
