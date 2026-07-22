import * as path from 'node:path';
import * as fs from 'node:fs';
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { EnvConfig } from '../config/environments';
import { toRetentionDays, prodRemovalPolicy } from '../config/aws-helpers';
import { applyCostTags } from '../constructs/cost-tags';

/** リポジトリルート（infra/ の 1 つ上）。 */
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const OPEN_NEXT_DIR = path.join(REPO_ROOT, '.open-next');

/**
 * 既存サブドメインを CloudFront に紐付けるカスタムドメイン設定 (issue #189)。
 *
 * DNS 委譲・サブドメイン作成自体は別管理（完了済み）である前提で、open-reception 側は
 * 既存 FQDN を Distribution に関連付ける。CloudFront は **us-east-1 の ACM 証明書**しか
 * 受け付けないため、証明書はその場で発行せず既存 `certificateArn` を取り込む方式とする
 * （クロスリージョン発行は scope 外）。Route53 管理下なら alias レコードも作成できる。
 */
export interface CustomDomainConfig {
  /** Distribution に割り当てる FQDN（例: open-reception.parent.example.com）。 */
  readonly domainName: string;
  /** 追加の代替ドメイン名（任意）。 */
  readonly additionalDomainNames?: string[];
  /**
   * CloudFront 用 ACM 証明書 ARN（**us-east-1 必須**）。`domainName`（と追加ドメイン）を
   * カバーする証明書を事前に用意して指定する。
   */
  readonly certificateArn: string;
  /**
   * Route53 で管理している Hosted Zone のドメイン（例: parent.example.com）。
   * `createDnsRecord` を有効にする場合のみ必要。
   */
  readonly hostedZoneDomainName?: string;
  /**
   * Route53 に alias A/AAAA レコードを作成するか。Route53 管理外、または DNS を
   * 手動管理する場合は false（既定）にして、紐付けだけ行う。
   */
  readonly createDnsRecord?: boolean;
}

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
  /** 既存サブドメインを CloudFront に紐付ける場合の設定 (issue #189)。未指定なら CDK 生成ドメインのみ。 */
  readonly customDomain?: CustomDomainConfig;
  /**
   * アプリ機密（ADMIN_SESSION_SECRET 等）をまとめた Secrets Manager シークレットの名前 (issue #194)。
   * 指定すると server Lambda に読取権限を付与し、`APP_SECRETS_ARN` env を設定する。Lambda 起動時に
   * `src/instrumentation.ts` の register() が JSON を解決して process.env に流し込む。
   * 未指定なら従来の `appEnv` 平文注入方式のまま（後方互換）。
   */
  readonly appSecretsName?: string;
  /**
   * CloudFront 経由アクセスの検証用シークレット。指定すると Function URL を authType=NONE にし、
   * CloudFront が origin custom header `x-origin-verify` にこの値を付与する。server(middleware) が
   * 一致を検証し、Function URL 直叩き（CloudFront 迂回）を拒否する。
   * CloudFront OAC は POST/PUT のボディを署名せず Lambda(IAM) が拒否する制約を回避するための方式。
   * 未指定なら従来どおり OAC + IAM 署名（GET は通るが POST は 403 になる既知問題）。
   */
  readonly originVerifySecret?: string;
  /**
   * 管理ログインに Cognito（埋め込み SRP）を使う場合 true (issue #238)。指定すると Cognito
   * User Pool + App Client（USER_SRP_AUTH 有効・client secret 無し・Hosted UI 無し）を作成し、
   * server Lambda に `COGNITO_USER_POOL_ID/COGNITO_CLIENT_ID/COGNITO_REGION/COGNITO_ISSUER` を注入する。
   * `ADMIN_AUTH_PROVIDER=cognito` は bin が appEnv に畳み込む。
   */
  readonly cognitoAuth?: boolean;
  /**
   * テナント別 CCaaS プロバイダ secret のバックエンド (issue #405 Inc2)。
   * `secrets-manager` のとき server Lambda に `PROVIDER_SECRET_BACKEND`/`PROVIDER_SECRET_PREFIX` env と、
   * **テナント prefix 限定**（`<providerSecretPrefix>/tenants/*`）の最小 IAM 権限を付与する。
   * 未指定/`memory` なら in-memory mock のまま（dev/test の現行動作不変）。
   * シークレット実体は実行時（設定 API から）作成するため CDK では作らない。
   */
  readonly providerSecretBackend?: 'memory' | 'secrets-manager';
  /**
   * テナント別 secret 名の環境 prefix (issue #405 Inc2)。参照名 `tenants/<tenantId>/<provider>` は
   * `<providerSecretPrefix>/tenants/<tenantId>/<provider>`（例 `open-reception/prod/tenants/acme/vonage`）
   * へ写像される。`providerSecretBackend='secrets-manager'` のとき必須（越境防止のため fail-closed）。
   */
  readonly providerSecretPrefix?: string;
}

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
  /** server Lambda（SSR / Route Handlers）。WebMonitoringStack (#299) が参照する。 */
  readonly serverFn: lambda.Function;
  /** image optimization Lambda。WebMonitoringStack (#299) が参照する。 */
  readonly imageFn: lambda.Function;
  /** 業務データ DynamoDB テーブル。WebMonitoringStack (#299) が参照する。 */
  readonly dataTable: dynamodb.Table;
  /** CloudFront Distribution。WebMonitoringStack (#299) が参照する。 */
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    this.assertBuildArtifacts();

    const {
      config,
      appEnv = {},
      customDomain,
      appSecretsName,
      originVerifySecret,
      cognitoAuth,
      providerSecretBackend,
      providerSecretPrefix,
    } = props;
    const retention = toRetentionDays(config.web.logRetentionDays);
    const removalPolicy = prodRemovalPolicy(config.environment);

    applyCostTags(this, config, 'web');

    const makeLogGroup = (logicalId: string): logs.LogGroup =>
      new logs.LogGroup(this, logicalId, { retention, removalPolicy });

    // --- S3: 静的アセット ---
    const assetBucket = new s3.Bucket(this, 'AssetBucket', {
      bucketName: undefined, // 名前は CDK 生成（グローバル一意衝突を避ける）
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: config.environment !== 'prod',
      // コスト微最適化 (issue #300): 未完了マルチパートアップロード（不可視だが課金対象）を掃除する。
      // 旧ハッシュアセットの年齢ベース Expiration は採用しない: BucketDeployment(aws s3 sync) は
      // アセットが変化したデプロイ時にしか LastModified を更新しないため、無デプロイ期間が
      // 失効日数を超えると**現役**アセットまで削除され得る（可用性がデプロイ頻度に依存する）。
      // 蓄積コストは数 MB/デプロイ程度で無視できるため、リスクに見合わない。
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
    });

    new s3deploy.BucketDeployment(this, 'AssetDeployment', {
      sources: [s3deploy.Source.asset(path.join(OPEN_NEXT_DIR, 'assets'))],
      destinationBucket: assetBucket,
      destinationKeyPrefix: '_assets',
      // ハッシュ付き immutable アセットなので長期キャッシュ。prune:false のため旧世代は蓄積するが、
      // ローリングデプロイ直後にキャッシュ済み HTML が旧アセットを参照しても壊れないための意図的な選択
      // （失効させない根拠は上の lifecycleRules コメント参照）。
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString('public,max-age=31536000,immutable')],
    });

    // --- DynamoDB: 業務データの永続化（シングルテーブル）(docs/persistence-design.md §4) ---
    // PK/SK 複合キー。受付セッションの失効に TTL、受付履歴の receptionId 検索に GSI1 を用いる。
    const dataTable = new dynamodb.Table(this, 'DataTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: config.data.pointInTimeRecovery,
      },
      deletionProtection: config.data.removalProtection,
      removalPolicy,
    });
    dataTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });
    this.dataTable = dataTable;

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
        // 永続化バックエンドは DynamoDB を使用（appEnv による上書きより後に置き、確定させる）。
        DATA_BACKEND: 'dynamodb',
        TABLE_NAME: dataTable.tableName,
      },
    });

    this.serverFn = serverFn;

    // server Lambda（SSR / Route Handlers）は業務データの読み書きを行う。
    dataTable.grantReadWriteData(serverFn);

    // アプリ機密の Secrets Manager 化 (issue #194)。指定時は server Lambda に読取権限を付与し
    // APP_SECRETS_ARN を渡す。Lambda 起動時に instrumentation register() が解決して process.env へ。
    if (appSecretsName) {
      const appSecret = secretsmanager.Secret.fromSecretNameV2(this, 'AppSecrets', appSecretsName);
      appSecret.grantRead(serverFn);
      serverFn.addEnvironment('APP_SECRETS_ARN', appSecret.secretArn);
    }

    // テナント別 CCaaS プロバイダ secret を Secrets Manager で扱う (issue #405 Inc2)。
    // 参照名 `tenants/<tenantId>/<provider>` は runtime で `<prefix>/tenants/...` へ写像される。
    // 実行ロールにはテナント prefix 限定（`<prefix>/tenants/*`）で最小権限のみ付与し、アカウント全体
    // ワイルドカードは付けない（越境・過剰権限の防止。値の非ログ・CloudTrail 監査は runtime 側の責務）。
    // シークレット実体は設定 API から実行時に作成するため、CDK では作らない。
    if (providerSecretBackend === 'secrets-manager') {
      if (!providerSecretPrefix) {
        throw new Error(
          "providerSecretBackend='secrets-manager' には providerSecretPrefix が必須です" +
            '（テナント secret 名の環境 prefix。例 open-reception/prod）。',
        );
      }
      // ランタイム（normalizePrefix）と同じ規則で前後スラッシュを除去し、IAM ARN と
      // 実行時のシークレット名がずれないようにする（末尾 `/` 付き指定での AccessDenied 防止）。
      const normalizedPrefix = providerSecretPrefix.replace(/^\/+|\/+$/g, '');
      serverFn.addEnvironment('PROVIDER_SECRET_BACKEND', 'secrets-manager');
      serverFn.addEnvironment('PROVIDER_SECRET_PREFIX', normalizedPrefix);
      serverFn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'secretsmanager:GetSecretValue',
            'secretsmanager:DescribeSecret',
            'secretsmanager:CreateSecret',
            'secretsmanager:PutSecretValue',
            'secretsmanager:DeleteSecret',
          ],
          // resource prefix 限定。Secrets Manager の ARN は名前末尾に 6 桁のランダム接尾辞が付くため
          // `<prefix>/tenants/*` の末尾 `*` がテナント名前空間とその接尾辞の両方を覆う。
          resources: [
            `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${normalizedPrefix}/tenants/*`,
          ],
        }),
      );
    }

    // CloudFront 経由検証（直叩き拒否）。middleware(proxy.ts) が x-origin-verify を照合する。
    if (originVerifySecret) {
      serverFn.addEnvironment('ORIGIN_VERIFY_SECRET', originVerifySecret);
    }

    // --- 管理ログイン Cognito（埋め込み SRP・Hosted UI 無し） (issue #238) ---
    // App Client は USER_SRP_AUTH のみ・client secret 無し（SECRET_HASH/IAM 不要）。UserPoolDomain は
    // 作らない（= Hosted UI 無し）。ADMIN_AUTH_PROVIDER=cognito は bin が appEnv に畳み込む。
    if (cognitoAuth) {
      const userPool = new cognito.UserPool(this, 'AdminUserPool', {
        selfSignUpEnabled: false, // 管理者がユーザーを作成（セルフサインアップ無効）
        signInAliases: { username: true, email: true },
        passwordPolicy: {
          minLength: 12,
          requireLowercase: true,
          requireUppercase: true,
          requireDigits: true,
          requireSymbols: true,
        },
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        removalPolicy,
      });
      const userPoolClient = userPool.addClient('AdminAppClient', {
        authFlows: { userSrp: true }, // USER_SRP_AUTH のみ（PW を平文送信しない）
        generateSecret: false, // client secret 無し
        preventUserExistenceErrors: true,
        idTokenValidity: Duration.hours(8), // セッション長（refresh は inc2）
        accessTokenValidity: Duration.hours(8),
      });
      const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;
      serverFn.addEnvironment('COGNITO_USER_POOL_ID', userPool.userPoolId);
      serverFn.addEnvironment('COGNITO_CLIENT_ID', userPoolClient.userPoolClientId);
      serverFn.addEnvironment('COGNITO_REGION', this.region);
      serverFn.addEnvironment('COGNITO_ISSUER', issuer);

      new CfnOutput(this, 'AdminUserPoolId', {
        value: userPool.userPoolId,
        description: '管理ログイン Cognito User Pool ID（管理者ユーザー作成に使用）',
      });
      new CfnOutput(this, 'AdminUserPoolClientId', {
        value: userPoolClient.userPoolClientId,
        description: '管理ログイン Cognito App Client ID',
      });
    }

    // Function URL の認証方式。originVerifySecret 指定時は NONE（CloudFront 秘密ヘッダで保護）に切替え、
    // OAC が POST ボディを署名しない制約を回避する。未指定時は従来の AWS_IAM(+OAC)。
    const functionUrlAuthType = originVerifySecret
      ? lambda.FunctionUrlAuthType.NONE
      : lambda.FunctionUrlAuthType.AWS_IAM;

    const serverFnUrl = serverFn.addFunctionUrl({
      authType: functionUrlAuthType,
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
    this.imageFn = imageFn;

    // image 最適化は元画像を S3 から読む。
    assetBucket.grantRead(imageFn);

    const imageFnUrl = imageFn.addFunctionUrl({
      authType: functionUrlAuthType,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });

    // --- CloudFront ---
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(assetBucket, {
      originPath: '/_assets',
    });
    // originVerifySecret 指定時: OAC を使わず、CloudFront が origin custom header に秘密値を付与する。
    //   → server(middleware) が照合し直叩きを拒否。POST も含め全メソッドが通る。
    // 未指定時: 従来の OAC（withOriginAccessControl）。
    const originVerifyHeaders = originVerifySecret
      ? { 'x-origin-verify': originVerifySecret }
      : undefined;
    const serverOrigin = originVerifySecret
      ? new origins.FunctionUrlOrigin(serverFnUrl, { customHeaders: originVerifyHeaders })
      : origins.FunctionUrlOrigin.withOriginAccessControl(serverFnUrl);
    const imageOrigin = originVerifySecret
      ? new origins.FunctionUrlOrigin(imageFnUrl, { customHeaders: originVerifyHeaders })
      : origins.FunctionUrlOrigin.withOriginAccessControl(imageFnUrl);

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

    // S3/画像オリジンの静的アセットは Next.js Lambda を経由しないため next.config.ts の
    // セキュリティヘッダが付かない (issue #193)。CloudFront 側で付与し、SSR と静的で
    // ヘッダを揃える。特に COEP require-corp の文書が静的サブリソースを読めるよう CORP を付ける。
    const staticHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'StaticSecurityHeaders', {
      comment: `${config.prefix} static asset security headers`,
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          override: true,
        },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=()',
            override: true,
          },
          { header: 'Cross-Origin-Resource-Policy', value: 'same-origin', override: true },
          { header: 'Cross-Origin-Embedder-Policy', value: 'require-corp', override: true },
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
        ],
      },
    });

    // カスタムドメイン (issue #189): 既存サブドメインを alias として割り当て、
    // 既存の us-east-1 ACM 証明書を取り込む（証明書の新規発行は行わない）。
    const customDomainNames = customDomain
      ? [customDomain.domainName, ...(customDomain.additionalDomainNames ?? [])]
      : undefined;
    const customCertificate = customDomain
      ? acm.Certificate.fromCertificateArn(
          this,
          'CustomDomainCertificate',
          customDomain.certificateArn,
        )
      : undefined;

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${config.prefix} Next.js (OpenNext)`,
      defaultBehavior: serverBehavior,
      domainNames: customDomainNames,
      certificate: customCertificate,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // 国内 iPad 受付端末向け用途のため全世界エッジは不要。prod 含む全環境で
      // PriceClass_200（北米/欧州/アジア等）に抑えてコストを最適化する (issue #300)。
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      additionalBehaviors: {
        // OpenNext behaviors に対応:
        '/_next/image*': {
          origin: imageOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: imageCachePolicy,
          originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_CUSTOM_ORIGIN,
          responseHeadersPolicy: staticHeadersPolicy,
        },
        '/_next/data/*': serverBehavior,
        '/_next/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: staticHeadersPolicy,
        },
        '/BUILD_ID': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: staticHeadersPolicy,
        },
        // 受付アバターの VRM/モーション等の静的アセット（public/avatar/*）は S3 から配信・長期キャッシュ
        // する（server Lambda を経由しない）(issue #31)。
        '/avatar/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: staticHeadersPolicy,
        },
        // 背景画像など受付端末の静的アセット（public/assets/*）も S3 から配信・長期キャッシュする (issue #27)。
        '/assets/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: staticHeadersPolicy,
        },
      },
    });
    this.distribution = distribution;

    // CloudFront OAC → Lambda Function URL の invoke 権限 (issue #192)。OAC 方式のときのみ必要。
    // `FunctionUrlOrigin.withOriginAccessControl` は `lambda:InvokeFunctionUrl` のみを付与するが、
    // 2025-10 以降 AWS は OAC 経由の呼び出しに **`lambda:InvokeFunction` も必須**としており、
    // これが無いと CloudFront → Function URL が 403（AccessDeniedException）になる。
    // 参照: aws-samples/remote-swe-agents#361。両 Lambda（server/image）へ明示的に付与する。
    // originVerifySecret 方式（authType=NONE）では Function URL が公開のため invoke 権限は不要。
    if (!originVerifySecret) {
      const cloudfrontPrincipal = new iam.ServicePrincipal('cloudfront.amazonaws.com');
      const distributionArn = `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`;
      serverFn.addPermission('CloudFrontOacInvokeFunction', {
        principal: cloudfrontPrincipal,
        action: 'lambda:InvokeFunction',
        sourceArn: distributionArn,
      });
      imageFn.addPermission('CloudFrontOacInvokeFunction', {
        principal: cloudfrontPrincipal,
        action: 'lambda:InvokeFunction',
        sourceArn: distributionArn,
      });
    }

    // Route53 管理下なら alias A/AAAA を作成して FQDN を Distribution に向ける (issue #189)。
    // 管理外・手動管理の場合は createDnsRecord=false にして、CloudFront 側の紐付けだけ行う。
    if (customDomain?.createDnsRecord) {
      if (!customDomain.hostedZoneDomainName) {
        throw new Error(
          'customDomain.createDnsRecord=true には hostedZoneDomainName（Route53 管理ゾーン）が必要です。' +
            'Route53 管理外の場合は createDnsRecord=false にしてください。',
        );
      }
      const hostedZone = route53.HostedZone.fromLookup(this, 'CustomDomainHostedZone', {
        domainName: customDomain.hostedZoneDomainName,
      });
      const aliasTarget = route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      );
      new route53.ARecord(this, 'CustomDomainAliasA', {
        zone: hostedZone,
        recordName: customDomain.domainName,
        target: aliasTarget,
      });
      new route53.AaaaRecord(this, 'CustomDomainAliasAAAA', {
        zone: hostedZone,
        recordName: customDomain.domainName,
        target: aliasTarget,
      });
    }

    if (customDomain) {
      new CfnOutput(this, 'CustomDomainUrl', {
        value: `https://${customDomain.domainName}`,
        description: 'カスタムドメインの公開 URL (#189)',
      });
    }

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
    new CfnOutput(this, 'DataTableName', {
      value: dataTable.tableName,
      description: '業務データ DynamoDB テーブル名（seed/運用に使用）',
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
