import * as path from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { RealtimeScheduleConfig } from '../config/environments';

// この Lambda のソースは infra/ 内に閉じる（src/ は別トラック占有のため参照しない）。
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const RECONCILER_ENTRY = path.join(REPO_ROOT, 'infra', 'lambda', 'realtime-reconciler', 'handler.ts');

export interface RealtimeReconcilerFunctionProps {
  readonly asg: autoscaling.AutoScalingGroup;
  readonly schedule: RealtimeScheduleConfig;
  readonly forceStopParam: ssm.IStringParameter;
  readonly logRetention: logs.RetentionDays;
  readonly removalPolicy: RemovalPolicy;
  /** 動的 Public IPv4 を書き込む Route 53 レコード（未指定なら DNS 更新をスキップ）。 */
  readonly dns?: { hostedZoneId: string; recordName: string };
}

/**
 * 営業時間に応じて ASG の DesiredCapacity(0/1) を調整する Reconciler (issue #366 Phase 0)。
 * `infra/lambda/realtime-reconciler/handler.ts` を esbuild でバンドルする。
 * AWS SDK v3 は Lambda Node.js ランタイム同梱のため externalize する
 * (`infra/lib/constructs/notification-function.ts` と同じ方針)。
 */
export class RealtimeReconcilerFunction extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: RealtimeReconcilerFunctionProps) {
    super(scope, id);
    const { asg, schedule, forceStopParam, dns } = props;

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    });

    this.fn = new NodejsFunction(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: RECONCILER_ENTRY,
      handler: 'handler',
      projectRoot: path.join(REPO_ROOT, 'infra'),
      depsLockFilePath: path.join(REPO_ROOT, 'infra', 'package-lock.json'),
      memorySize: 128,
      timeout: Duration.seconds(30),
      logGroup,
      bundling: {
        format: OutputFormat.CJS,
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        ASG_NAME: asg.autoScalingGroupName,
        START_HOUR: String(schedule.startHour),
        STOP_HOUR: String(schedule.stopHour),
        FORCE_STOP_PARAM: forceStopParam.parameterName,
        ...(dns
          ? { HOSTED_ZONE_ID: dns.hostedZoneId, RECORD_NAME: dns.recordName }
          : {}),
      },
    });

    // --- 最小権限 IAM (issue #366 「Transcribe/Polly/Bedrockの最小IAMを付与する」は EC2 instance
    //     role 側の責務。ここは Reconciler が ASG/EC2/Route53/SSM を操作するための権限のみ) ---

    // ASG の Desired Capacity 調整。DescribeAutoScalingGroups は resource-level 制約非対応のため '*'、
    // SetDesiredCapacity は対象 ASG の ARN に限定する。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['autoscaling:DescribeAutoScalingGroups'],
        resources: ['*'],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['autoscaling:SetDesiredCapacity'],
        resources: [asg.autoScalingGroupArn],
      }),
    );

    // 起動中インスタンスの Public IP 参照。DescribeInstances は resource-level 制約非対応のため '*'。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      }),
    );

    // force-stop kill-switch の読み取り。
    forceStopParam.grantRead(this.fn);

    // 動的 Public IPv4 → Route 53 A レコード UPSERT（ADR-004）。dns 未指定時は権限も付与しない。
    if (dns) {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['route53:ChangeResourceRecordSets'],
          resources: [`arn:aws:route53:::hostedzone/${dns.hostedZoneId}`],
        }),
      );
    }
  }
}
