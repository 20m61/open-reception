import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  Stack,
  StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { EnvConfig } from '../config/environments';
import { applyCostTags } from '../constructs/cost-tags';

/** リポジトリルート（infra/ の 1 つ上）。 */
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const OPEN_NEXT_DIR = path.join(REPO_ROOT, '.open-next');

export interface WebStackProps extends StackProps {
  readonly env: StackProps['env'];
  readonly config: EnvConfig;
  /**
   * server Lambda に渡すアプリ環境変数（非機密のみをコードから渡す）。
   * 機密値（ADMIN_PASSWORD / ADMIN_SESSION_SECRET / Entra secret 等）は
   * デプロイ時に `-c appEnv.KEY=...` あるいは Secrets Manager 連携で注入する。
   * 詳細は docs/deploy-aws.md。
   */
  readonly appEnv?: Record<string, string>;
}

const CONFIG_RETENTION: Record<number, logs.RetentionDays> = {
  14: logs.RetentionDays.TWO_WEEKS,
  30: logs.RetentionDays.ONE_MONTH,
  90: logs.RetentionDays.THREE_MONTHS,
};

/**
 * Next.js (OpenNext) を AWS サーバーレスにホスティングする WebStack。
 *
 * 前提: 事前に `npm run build:open-next`（= `open-next build`）でリポジトリルートに
 * `.open-next/` が生成済みであること。本 Stack はその成果物を取り込む。
 *
 * 構成（OpenNext output contract に対応）:
 *   - S3            : 静的アセット（`_next/*`, `BUILD_ID`）の origin
 *   - server Lambda : SSR / Route Handlers / proxy(旧 middleware) を処理（Function URL + OAC）
 *   - image  Lambda : next/image 最適化（Function URL + OAC）
 *   - CloudFront    : 単一エントリ。behaviors を OpenNext 定義に合わせて振り分け
 */
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    this.assertBuildArtifacts();

    const { config, appEnv = {} } = props;
    const retention = CONFIG_RETENTION[config.web.logRetentionDays] ?? logs.RetentionDays.ONE_MONTH;

    applyCostTags(this, config, 'web');

    const makeLogGroup = (logicalId: string): logs.LogGroup =>
      new logs.LogGroup(this, logicalId, {
        retention,
        removalPolicy:
          config.environment === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      });

    // --- S3: 静的アセット ---
    const assetBucket = new s3.Bucket(this, 'AssetBucket', {
      bucketName: undefined, // 名前は CDK 生成（グローバル一意衝突を避ける）
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: config.environment === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: config.environment !== 'prod',
    });

    new s3deploy.BucketDeployment(this, 'AssetDeployment', {
      sources: [s3deploy.Source.asset(path.join(OPEN_NEXT_DIR, 'assets'))],
      destinationBucket: assetBucket,
      destinationKeyPrefix: '_assets',
      // ハッシュ付き immutable アセットなので長期キャッシュ。古い世代は次回デプロイで上書き。
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString('public,max-age=31536000,immutable')],
    });

    // --- server Lambda ---
    const serverFn = new lambda.Function(this, 'ServerFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(OPEN_NEXT_DIR, 'server-functions', 'default')),
      memorySize: config.web.serverMemoryMb,
      timeout: Duration.seconds(config.web.serverTimeoutSec),
      logGroup: makeLogGroup('ServerFnLogs'),
      environment: {
        // OpenNext server function 標準。dummy cache のため bucket 参照は不要だが、
        // NODE_ENV は明示する。
        NODE_ENV: 'production',
        ...appEnv,
      },
    });

    const serverFnUrl = serverFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });

    // --- image optimization Lambda ---
    const imageFn = new lambda.Function(this, 'ImageFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(OPEN_NEXT_DIR, 'image-optimization-function')),
      memorySize: config.web.imageMemoryMb,
      timeout: Duration.seconds(config.web.serverTimeoutSec),
      logGroup: makeLogGroup('ImageFnLogs'),
      environment: {
        BUCKET_NAME: assetBucket.bucketName,
        BUCKET_KEY_PREFIX: '_assets',
      },
    });
    // image 最適化は元画像を S3 から読む。
    assetBucket.grantRead(imageFn);

    const imageFnUrl = imageFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });

    // --- CloudFront ---
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(assetBucket, {
      originPath: '/_assets',
    });
    const serverOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(serverFnUrl);
    const imageOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(imageFnUrl);

    // SSR/Route Handler はクッキー（管理セッション）・クエリ・メソッドに依存するため
    // キャッシュは無効化し、Host 以外の viewer 情報を origin へ転送する。
    const serverBehavior: cloudfront.BehaviorOptions = {
      origin: serverOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
    };

    // 画像最適化はクエリ（url/w/q）と Accept ヘッダでキャッシュする。
    const imageCachePolicy = new cloudfront.CachePolicy(this, 'ImageCachePolicy', {
      defaultTtl: Duration.days(1),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Accept'),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${config.prefix} Next.js (OpenNext)`,
      defaultBehavior: serverBehavior,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass:
        config.environment === 'prod'
          ? cloudfront.PriceClass.PRICE_CLASS_ALL
          : cloudfront.PriceClass.PRICE_CLASS_200,
      additionalBehaviors: {
        // OpenNext behaviors に対応:
        '/_next/image*': {
          origin: imageOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: imageCachePolicy,
          originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_CUSTOM_ORIGIN,
        },
        '/_next/data/*': serverBehavior,
        '/_next/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        '/BUILD_ID': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
    });

    new CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront ドメイン（受付端末/管理画面の公開 URL）',
    });
    new CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront Distribution ID（キャッシュ無効化に使用）',
    });
    new CfnOutput(this, 'AssetBucketName', {
      value: assetBucket.bucketName,
      description: '静的アセット S3 バケット名',
    });
  }

  /** `.open-next/` 成果物が存在するか検証（未ビルドでの synth/deploy を早期に止める）。 */
  private assertBuildArtifacts(): void {
    const required = [
      path.join(OPEN_NEXT_DIR, 'open-next.output.json'),
      path.join(OPEN_NEXT_DIR, 'assets'),
      path.join(OPEN_NEXT_DIR, 'server-functions', 'default', 'index.mjs'),
      path.join(OPEN_NEXT_DIR, 'image-optimization-function', 'index.mjs'),
    ];
    const missing = required.filter((p) => !fs.existsSync(p));
    if (missing.length > 0) {
      throw new Error(
        `OpenNext build artifacts not found:\n  ${missing.join('\n  ')}\n` +
          `Run \`npm run build:open-next\` at the repo root before \`cdk synth\`/\`deploy\`.`,
      );
    }
  }
}
