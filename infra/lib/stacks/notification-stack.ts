import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { EnvConfig } from '../config/environments';
import { applyCostTags } from '../constructs/cost-tags';
import { NotificationFunction } from '../constructs/notification-function';
import { NotificationApi } from '../constructs/notification-api';

const RETENTION: Record<number, logs.RetentionDays> = {
  14: logs.RetentionDays.TWO_WEEKS,
  30: logs.RetentionDays.ONE_MONTH,
  90: logs.RetentionDays.THREE_MONTHS,
};

export interface NotificationStackProps extends StackProps {
  readonly config: EnvConfig;
  /**
   * 既存の Vonage 接続情報 Secret 名（任意）。指定時は通知 Lambda に読取権限を付与し、
   * VONAGE_SECRET_ARN を渡す。未指定なら Mock 通知（実発信なし）。
   */
  readonly vonageSecretName?: string;
  /**
   * 拠点トークン検証鍵を保持する Secret 名（任意）。指定時は authorizer に読取権限を付与し、
   * SITE_TOKEN_SECRET_ARN を渡す。未指定なら authorizer は fail-closed（全拒否）。
   */
  readonly siteTokenSecretName?: string;
}

/**
 * 通知サブシステム Stack (DESIGN #34 §2)。
 * HTTP API + 通知 Lambda + 拠点 authorizer + LogGroup + (任意)Secrets 参照。
 * VPC 外配置で NAT Gateway 固定費を避ける（SPEC #32）。
 */
export class NotificationStack extends Stack {
  readonly notificationFn: NotificationFunction;
  readonly api: NotificationApi;

  constructor(scope: Construct, id: string, props: NotificationStackProps) {
    super(scope, id, props);
    const { config } = props;
    const retention = RETENTION[config.notification.logRetentionDays] ?? logs.RetentionDays.ONE_MONTH;
    const removalPolicy =
      config.environment === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    applyCostTags(this, config, 'notification');

    const vonageSecret = props.vonageSecretName
      ? secretsmanager.Secret.fromSecretNameV2(this, 'VonageSecret', props.vonageSecretName)
      : undefined;
    const siteTokenSecret = props.siteTokenSecretName
      ? secretsmanager.Secret.fromSecretNameV2(this, 'SiteTokenSecret', props.siteTokenSecretName)
      : undefined;

    this.notificationFn = new NotificationFunction(this, 'Notification', {
      config: config.notification,
      logRetention: retention,
      removalPolicy,
      vonageSecret,
    });

    this.api = new NotificationApi(this, 'Api', {
      config: config.notification,
      handler: this.notificationFn.fn,
      logRetention: retention,
      removalPolicy,
      siteTokenSecret,
    });

    new CfnOutput(this, 'NotifyEndpoint', {
      value: this.api.endpoint,
      description: '通知 API エンドポイント（POST /notify）',
    });
    new CfnOutput(this, 'NotificationFunctionName', {
      value: this.notificationFn.fn.functionName,
      description: '通知 Lambda 関数名',
    });
  }
}
