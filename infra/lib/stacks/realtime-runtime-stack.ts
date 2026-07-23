import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { EnvConfig } from '../config/environments';
import { RealtimeReconcilerFunction } from '../constructs/realtime-reconciler-function';

/**
 * 動的 Public IPv4 を書き込む Route 53 レコード設定 (ADR-004)。任意。
 * 未指定なら Route 53 リソースを一切作らない（`cdk synth` に実 hosted zone が不要）。
 */
export interface RealtimeRuntimeDnsConfig {
  /** 既存 hosted zone の ID（新規作成はしない。Route 53 の運用主体は別途決める）。 */
  readonly hostedZoneId: string;
  readonly zoneName: string;
  /** FQDN（末尾ドット任意）。例: `realtime.dev.example.com`。 */
  readonly recordName: string;
}

export interface RealtimeRuntimeStackProps extends StackProps {
  readonly config: EnvConfig;
  readonly dns?: RealtimeRuntimeDnsConfig;
  /**
   * `bedrock:InvokeModel` を許可する対象モデルの ARN パターン (#366 W3)。
   * 未指定時は `DEFAULT_BEDROCK_MODEL_ARN_PATTERN`（Claude 系 foundation-model 限定、region は
   * デプロイ先スタックの region）にフォールバックする。`'*'`（全モデル・全 provider 開放）よりも
   * 狭い形に絞ることが目的で、個別モデルまで固定するかはコスト/運用判断のため context に委ねる。
   */
  readonly bedrockModelArnPattern?: string;
}

/**
 * リアルタイム会話 EC2 基盤 (issue #366 Phase 0)。
 *
 * 設計判断の根拠は `docs/adr/0003-realtime-runtime-ec2-phase0.md`（ADR-001〜006 + 月額 Budget 見積）。
 * このコミット時点では **deploy しない**（`bin/open-reception.ts` は `config.realtime.enabled` が
 * true の環境でのみこの Stack を app へ追加する。既定はどの環境も false）。
 *
 * MVP 前提 (issue #366 本文):
 *   - 本 Stack と Site は 1 対 1。
 *   - 単一 EC2 / ASG max=1 の単一障害点を許容する（冗長化は後続）。
 *   - 障害時は音声受付を停止し、サイネージ・タッチ・QR 確認は WebStack 側で継続する
 *     （本 Stack は WebStack に一切依存せず、参照もしない — 疎結合を保つ）。
 *
 * 本 increment のスコープ外（follow-up、後続 increment）:
 *   - drain API・`/health/live` `/health/ready`（アプリ本体が無いと実装できない）。
 *   - 営業時間の DynamoDB 化（#367 ServiceOperatingPolicy 統合）。
 *   - CPU/memory/disk/process/session 数の詳細監視（CloudWatch Agent は実 AMI/実機検証が要る、#65）。
 *   - realtime gateway アプリ本体のビルド・S3/ECR への配布パイプライン。
 *   - Component タグ `realtime-runtime` の Cost Explorer allow-list 登録
 *     （`src/domain/platform/aws-cost.ts` の `COST_COMPONENT_FILTERS` 同期は src/ 占有トラックとの
 *     協調が要るため本 increment では未実施。タグ自体は付与済み・Budget の CostFilters は機能する）。
 */
export class RealtimeRuntimeStack extends Stack {
  readonly asg: autoscaling.AutoScalingGroup;
  readonly reconciler: RealtimeReconcilerFunction;
  readonly artifactBucket: s3.Bucket;
  readonly forceStopParam: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: RealtimeRuntimeStackProps) {
    super(scope, id, props);
    const { config, dns } = props;
    const { realtime } = config;
    // Claude 系 foundation-model のみに絞る既定パターン。'*'（全モデル・全 provider）より狭い。
    // region はこのスタックのデプロイ先 region を使う（cross-region 呼び出しは想定しない）。
    const bedrockModelArnPattern =
      props.bedrockModelArnPattern ?? `arn:aws:bedrock:${this.region}::foundation-model/anthropic.*`;

    // --- コスト管理タグ (docs/cost-management-tags.md) ---
    // 既存 `applyCostTags`/`COST_TAG_COMPONENTS`（infra/lib/config/cost-components.ts）は
    // 値の一致を src/domain/platform/aws-cost.ts と drift テストで固定しており、src/ を
    // 触らずに新しい Component 値を安全に追加できない（本トラックの占有領域外）。そのため
    // ここだけ直接 Tags.of を使う。follow-up で allow-list へ正式登録する。
    Tags.of(this).add('Project', config.tags.Project);
    Tags.of(this).add('Environment', config.tags.Environment);
    Tags.of(this).add('Component', 'realtime-runtime');
    Tags.of(this).add('Owner', config.tags.Owner);
    Tags.of(this).add('ManagedBy', config.tags.ManagedBy);

    const removalPolicy = config.environment === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const logRetention = daysToRetention(realtime.logRetentionDays);

    // --- ネットワーク（ADR-004: NAT Gateway なし。単一 AZ・public subnet のみ） ---
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const securityGroup = new ec2.SecurityGroup(this, 'RuntimeSg', {
      vpc,
      description: `${config.prefix} realtime runtime (WSS only, no SSH — Session Manager 経由)`,
      allowAllOutbound: true,
    });
    // SSH(22) は開放しない。運用は Session Manager (SSM) を使う（コスト方針・issue #366 本文）。
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'WSS (Caddy が TLS 終端して realtime gateway へプロキシ)',
    );

    // --- artifact 配布 (ADR-003: S3。DockerImageAsset/ECR はコンテナ化後の後続 increment) ---
    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
    });

    // --- IAM (最小権限。Transcribe/Polly/Bedrock は resource-level 制約に対応しないため '*') ---
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // SSH を開放しない代わりに Session Manager を使うための管理ポリシー。
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    this.artifactBucket.grantRead(instanceRole);
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        // WebSocket ストリーミング(StartStreamTranscriptionWebSocket)と HTTP/2(StartStreamTranscription)
        // の両方を許可しておく（ADR-001: WSS を MVP Transport に採用、Transcribe 呼び出しは
        // realtime gateway アプリ本体側 — 本 Stack は権限のみ用意する）。
        actions: ['transcribe:StartStreamTranscription', 'transcribe:StartStreamTranscriptionWebSocket'],
        resources: ['*'],
      }),
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['polly:SynthesizeSpeech'],
        resources: ['*'],
      }),
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        // 曖昧な入力時のみ呼ぶ想定（issue #366 アーキテクチャ節）。モデル ARN をパターンへ限定する
        // （#366 W3: '*' 全開放より狭い形。個別モデル固定は運用判断のため context 経由で上書き可）。
        actions: ['bedrock:InvokeModel'],
        resources: [bedrockModelArnPattern],
      }),
    );

    // --- 起動テンプレート (ADR-002: ASG min=0/max=1、ADR-006: instance type は負荷試験まで暫定) ---
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '# issue #366 Phase 0: インフラ skeleton のみ。realtime gateway アプリ本体の',
      '# 配布/起動（systemd unit 化・S3 artifact 取得）は後続 increment で実装する。',
      'timedatectl set-timezone Asia/Tokyo || true',
      `mkdir -p /opt/${config.prefix}-realtime`,
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      instanceType: new ec2.InstanceType(realtime.instanceType),
      securityGroup,
      role: instanceRole,
      userData,
      // ADR-004: EIP は使わず動的 Public IPv4 + Route 53 を採用（固定費削減）。
      associatePublicIpAddress: true,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(realtime.rootVolumeSizeGb, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    // --- ASG (ADR-002: min=0/max=1。DesiredCapacity は Reconciler が実行時に調整する) ---
    this.asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
      desiredCapacity: 0,
    });
    // CloudFormation の既定挙動は stack update の度に DesiredCapacity を template 値(0)へ
    // 巻き戻す。Reconciler が 1 分毎に外部から調整する設計と両立させるため、
    // MinSize/MaxSize/DesiredCapacity への update を無視させる（CDK の標準エスケープハッチ）。
    const cfnAsg = this.asg.node.defaultChild as autoscaling.CfnAutoScalingGroup;
    cfnAsg.cfnOptions.updatePolicy = {
      ...cfnAsg.cfnOptions.updatePolicy,
      autoScalingScheduledAction: { ignoreUnmodifiedGroupSizeProperties: true },
    };

    // --- 停止手段: 運用が deploy なしで即時停止できる kill-switch (issue #366 「停止手段」) ---
    this.forceStopParam = new ssm.StringParameter(this, 'ForceStopFlag', {
      parameterName: `/${config.prefix}/realtime/force-stop`,
      stringValue: 'false',
      // 誤値（"True"/"stop" 等）を書込時点で弾き、silent no-op を防ぐ。
      allowedPattern: '^(true|false)$',
      description:
        '"true" にすると Reconciler が営業時間に関わらず DesiredCapacity=0 にする（緊急停止・deploy 不要）。',
    });

    // --- Route 53 (ADR-004: 動的 Public IPv4。既存 hosted zone を利用し新規ゾーンは作らない) ---
    if (dns) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: dns.hostedZoneId,
        zoneName: dns.zoneName,
      });
      // プレースホルダ IP（TEST-NET-3, RFC 5737）。実 IP は Reconciler がスケールアウト後に UPSERT する。
      new route53.ARecord(this, 'RuntimeRecord', {
        zone,
        recordName: dns.recordName,
        target: route53.RecordTarget.fromIpAddresses('203.0.113.1'),
        ttl: Duration.seconds(60),
        comment: 'issue #366 realtime runtime endpoint（IP は Reconciler Lambda が実行時に更新）',
      });
    }

    // --- Reconciler Lambda + スケジュール (ADR-002, 1 分毎) ---
    this.reconciler = new RealtimeReconcilerFunction(this, 'Reconciler', {
      asg: this.asg,
      schedule: realtime.schedule,
      forceStopParam: this.forceStopParam,
      logRetention,
      removalPolicy,
      dns: dns ? { hostedZoneId: dns.hostedZoneId, recordName: dns.recordName } : undefined,
    });

    const schedule = new events.Rule(this, 'ReconcilerSchedule', {
      description: `${config.prefix} realtime runtime: 1 分毎に営業時間ポリシーへ ASG DesiredCapacity を追従させる`,
      schedule: events.Schedule.rate(Duration.minutes(1)),
    });
    schedule.addTarget(new targets.LambdaFunction(this.reconciler.fn));

    // --- 監視: Reconciler の失敗検知（CPU/memory/disk/process/session はアプリ本体待ち・follow-up） ---
    this.reconciler.fn
      .metricErrors({ period: Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'ReconcilerErrors', {
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Reconciler Lambda が連続して失敗している（営業時間の起動/停止が追従していない可能性）',
      });

    // --- Budget (docs/adr/0003-*.md 月額見積の監視閾値) ---
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${config.prefix}-realtime-runtime`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: realtime.monthlyBudgetUsd, unit: 'USD' },
        // Budgets の TagKeyValue は同一キー内で OR 結合。複数タグの AND 絞り込みは非対応のため
        // Component 単体で絞る（本 AWS アカウントは単一プロジェクト運用のため十分）。
        costFilters: {
          TagKeyValue: ['user:Component$realtime-runtime'],
        },
      },
      notificationsWithSubscribers: realtime.budgetAlarmEmail
        ? [
            {
              notification: {
                notificationType: 'ACTUAL',
                comparisonOperator: 'GREATER_THAN',
                threshold: 80,
                thresholdType: 'PERCENTAGE',
              },
              subscribers: [{ subscriptionType: 'EMAIL', address: realtime.budgetAlarmEmail }],
            },
            {
              notification: {
                notificationType: 'FORECASTED',
                comparisonOperator: 'GREATER_THAN',
                threshold: 100,
                thresholdType: 'PERCENTAGE',
              },
              subscribers: [{ subscriptionType: 'EMAIL', address: realtime.budgetAlarmEmail }],
            },
          ]
        : [],
    });

    new CfnOutput(this, 'AutoScalingGroupName', { value: this.asg.autoScalingGroupName });
    new CfnOutput(this, 'ArtifactBucketName', { value: this.artifactBucket.bucketName });
    new CfnOutput(this, 'ForceStopParameterName', { value: this.forceStopParam.parameterName });
    new CfnOutput(this, 'ReconcilerFunctionName', { value: this.reconciler.fn.functionName });
  }
}

function daysToRetention(days: number): logs.RetentionDays {
  switch (days) {
    case 7:
      return logs.RetentionDays.ONE_WEEK;
    case 14:
      return logs.RetentionDays.TWO_WEEKS;
    case 30:
      return logs.RetentionDays.ONE_MONTH;
    case 90:
      return logs.RetentionDays.THREE_MONTHS;
    default:
      return logs.RetentionDays.TWO_WEEKS;
  }
}
