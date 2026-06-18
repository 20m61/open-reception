import * as path from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NotificationConfig } from '../config/environments';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const NOTIFICATION_SRC = path.join(REPO_ROOT, 'src', 'server', 'notification');

export interface NotificationApiProps {
  readonly config: NotificationConfig;
  readonly handler: lambda.IFunction;
  readonly logRetention: logs.RetentionDays;
  readonly removalPolicy: RemovalPolicy;
}

/**
 * 通知 HTTP API (DESIGN #34 §3, §7)。
 * - POST /notify を通知 Lambda に統合
 * - 拠点トークン検証の Lambda authorizer で保護（管理 API と分離）
 * - スロットリング（rate/burst）を default stage に設定
 */
export class NotificationApi extends Construct {
  readonly httpApi: apigwv2.HttpApi;
  readonly authorizerFn: NodejsFunction;
  readonly endpoint: string;

  constructor(scope: Construct, id: string, props: NotificationApiProps) {
    super(scope, id);
    const { config } = props;

    // --- 拠点認可 authorizer Lambda ---
    this.authorizerFn = new NodejsFunction(this, 'AuthorizerFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(NOTIFICATION_SRC, 'authorizer.ts'),
      handler: 'handler',
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      timeout: Duration.seconds(5),
      logGroup: new logs.LogGroup(this, 'AuthorizerLogs', {
        retention: props.logRetention,
        removalPolicy: props.removalPolicy,
      }),
      bundling: { format: OutputFormat.CJS, minify: true, sourceMap: true, target: 'node22' },
      environment: {
        // SITE_TOKEN_SECRET はデプロイ時に Secrets Manager 連携等で注入する。
        // 未設定時 authorizer は fail-closed（全拒否）。
        NODE_ENV: 'production',
      },
    });

    const authorizer = new HttpLambdaAuthorizer('SiteAuthorizer', this.authorizerFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization'],
      // 拠点トークンは短命のため authorizer 結果を短時間だけキャッシュ。
      resultsCacheTtl: Duration.seconds(60),
    });

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      description: 'open-reception notification API',
      createDefaultStage: true,
    });

    this.httpApi.addRoutes({
      path: '/notify',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('NotifyIntegration', props.handler),
      authorizer,
    });

    // スロットリング（default stage）。
    const stage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (stage) {
      stage.defaultRouteSettings = {
        throttlingRateLimit: config.throttle.rateLimit,
        throttlingBurstLimit: config.throttle.burstLimit,
      };
    }

    this.endpoint = `${this.httpApi.apiEndpoint}/notify`;
  }
}
