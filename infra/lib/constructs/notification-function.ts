import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NotificationConfig } from '../config/environments';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const NOTIFICATION_SRC = path.join(REPO_ROOT, 'src', 'server', 'notification');

export interface NotificationFunctionProps {
  readonly config: NotificationConfig;
  readonly logRetention: logs.RetentionDays;
  readonly removalPolicy: RemovalPolicy;
  /** Vonage 接続情報を保持する Secret（任意。実通知を行う場合に付与）。 */
  readonly vonageSecret?: secretsmanager.ISecret;
}

/**
 * 通知 Lambda（VPC 外配置・最小権限）(DESIGN #34 §3)。
 * src/server/notification/handler.ts を esbuild でバンドルする。
 * AWS SDK v3 は Lambda ランタイム同梱のため externalize する。
 */
export class NotificationFunction extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: NotificationFunctionProps) {
    super(scope, id);
    const { config } = props;
    const region = Stack.of(this).region;

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    });

    this.fn = new NodejsFunction(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(NOTIFICATION_SRC, 'handler.ts'),
      handler: 'handler',
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      memorySize: config.memoryMb,
      timeout: Duration.seconds(config.timeoutSec),
      logGroup,
      bundling: {
        format: OutputFormat.CJS,
        // SDK v3 は Node 22 ランタイムに含まれるためバンドルしない。
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        NODE_ENV: 'production',
        SSM_ENABLED: 'true',
        SITE_CONFIG_PREFIX: config.siteConfigPrefix,
        POLLY_ENABLED: String(config.pollyEnabled),
        ...(props.vonageSecret ? { VONAGE_SECRET_ARN: props.vonageSecret.secretArn } : {}),
      },
    });

    // --- 最小権限 IAM (DESIGN #34 §3) ---
    if (config.pollyEnabled) {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['polly:SynthesizeSpeech'],
          resources: ['*'], // Polly は resource-level 制約を持たない
        }),
      );
    }
    // 拠点設定（SSM）の読み取りを prefix に限定。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:aws:ssm:${region}:${Stack.of(this).account}:parameter${config.siteConfigPrefix}/*`,
        ],
      }),
    );
    // Vonage secret の読み取り（付与時のみ）。
    props.vonageSecret?.grantRead(this.fn);
  }
}
