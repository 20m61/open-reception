#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WebStack, CustomDomainConfig } from '../lib/stacks/web-stack';
import { WebMonitoringStack } from '../lib/stacks/web-monitoring-stack';
import { CloudFrontMonitoringStack } from '../lib/stacks/cloudfront-monitoring-stack';
import { NotificationStack } from '../lib/stacks/notification-stack';
import { MonitoringStack } from '../lib/stacks/monitoring-stack';
import { RealtimeRuntimeStack, RealtimeRuntimeDnsConfig } from '../lib/stacks/realtime-runtime-stack';
import { resolveEnv } from '../lib/config/environments';
import { configureCostExplorerAccess } from '../lib/constructs/cost-explorer-access';
import { overrideComponentTag } from '../lib/constructs/cost-tags';
import { COST_TAG_COMPONENTS } from '../lib/config/cost-components';

/**
 * open-reception CDK App エントリ (docs/infrastructure-design.md §1)。
 *
 * 環境は context で選択する: `cdk deploy -c env=prod`。既定は dev。
 *
 * Stack 構成:
 *   - WebStack                  : Next.js (OpenNext) ホスティング
 *   - WebMonitoringStack        : WebStack の監視 (#299) — Lambda/DynamoDB Alarms + Dashboard + SNS
 *   - CloudFrontMonitoringStack : CloudFront 5xx アラーム (#303) — **us-east-1**（メトリクス発行先）
 *   - NotificationStack         : 通知サブシステム (#32/#34) — API + Lambda + Polly/Vonage
 *   - MonitoringStack           : 通知サブシステムの監視（Alarms / Dashboard / SNS）
 *   - RealtimeRuntimeStack      : リアルタイム会話 EC2 基盤 (#366 Phase 0)。
 *     `config.realtime.enabled`（既定 false, 全環境）が true の場合のみ app へ追加する。
 *     ADR は `docs/adr/0003-realtime-runtime-ec2-phase0.md`。**deploy は本 increment のスコープ外**。
 *
 * デプロイ先アカウント/リージョンは CDK 既定の環境変数
 * (CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION) を使用する。
 */
const app = new cdk.App();

const envName = app.node.tryGetContext('env') as string | undefined;
const config = resolveEnv(envName);

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1';

// アプリ環境変数を context から集約する。
// CDK CLI の `-c appEnv='{"KEY":"VALUE",...}'` は文字列として渡るため JSON.parse する。
// cdk.json 等でオブジェクトを直接与えた場合はそのまま使う。未指定は空。
// （注意: `-c appEnv.KEY=VALUE` は flat キー "appEnv.KEY" になり tryGetContext('appEnv') では拾えない）
const rawAppEnv = app.node.tryGetContext('appEnv') as unknown;
const appEnvContext: Record<string, string> =
  typeof rawAppEnv === 'string'
    ? (JSON.parse(rawAppEnv) as Record<string, string>)
    : ((rawAppEnv as Record<string, string> | undefined) ?? {});

// 任意: 既存サブドメインを CloudFront に紐付ける (issue #189)。
// `-c customDomain='{"domainName":"...","certificateArn":"arn:aws:acm:us-east-1:...",...}'`。
// enabled:false または未指定なら CDK 生成ドメインのみ。
const rawCustomDomain = app.node.tryGetContext('customDomain') as unknown;
const customDomainContext: (CustomDomainConfig & { enabled?: boolean }) | undefined =
  typeof rawCustomDomain === 'string'
    ? (JSON.parse(rawCustomDomain) as CustomDomainConfig & { enabled?: boolean })
    : (rawCustomDomain as (CustomDomainConfig & { enabled?: boolean }) | undefined);
const customDomain =
  customDomainContext && customDomainContext.enabled !== false ? customDomainContext : undefined;

// 任意: アプリ機密を Secrets Manager から runtime 取得する (issue #194)。
// `-c appSecretsName=open-reception/prod/app`。未指定なら appEnv 平文注入のまま。
const appSecretsName = app.node.tryGetContext('appSecretsName') as string | undefined;

// 任意: CloudFront 経由検証用シークレット。指定すると Function URL を NONE + 秘密ヘッダ方式にし、
// OAC が POST ボディを署名しない制約（GET 可・POST 403）を回避する。`-c originVerifySecret=<高エントロピー値>`。
const originVerifySecret = app.node.tryGetContext('originVerifySecret') as string | undefined;

// 任意: テナント別 CCaaS プロバイダ secret を Secrets Manager で扱う (issue #405 Inc2)。
// `-c providerSecretBackend=secrets-manager -c providerSecretPrefix=open-reception/prod`。
// 未指定なら in-memory mock のまま（dev/test の現行動作不変）。prefix 未指定は WebStack が fail-closed。
const providerSecretBackend = app.node.tryGetContext('providerSecretBackend') as
  | 'memory'
  | 'secrets-manager'
  | undefined;
const providerSecretPrefix =
  (app.node.tryGetContext('providerSecretPrefix') as string | undefined) ??
  `open-reception/${config.environment}`;

// 管理ログイン認証プロバイダ (issue #238)。デプロイ環境の既定は config.auth.adminProvider（=cognito）。
// `-c appEnv='{"ADMIN_AUTH_PROVIDER":"none"}'` で明示上書きも可能。cognito のとき WebStack が
// Cognito User Pool/Client（USER_SRP_AUTH 有効）を作成し COGNITO_* を注入する。
const adminProvider = appEnvContext.ADMIN_AUTH_PROVIDER ?? config.auth.adminProvider;
const appEnv = { ...appEnvContext, ADMIN_AUTH_PROVIDER: adminProvider };

const web = new WebStack(app, `OpenReception-Web-${config.environment}`, {
  env: { account, region },
  // CloudFrontMonitoringStack (us-east-1) が distributionId を参照するため (#303)。
  // SSM ベースの ExportWriter custom resource が「追加」されるのみで既存リソースは不変。
  crossRegionReferences: true,
  config,
  appEnv,
  customDomain,
  appSecretsName,
  originVerifySecret,
  cognitoAuth: adminProvider === 'cognito',
  providerSecretBackend,
  providerSecretPrefix,
  description: `open-reception Next.js hosting (${config.environment})`,
});

// developer 運用画面から Cost Explorer を read-only 参照する (#377)。
// WebStack 本体の責務を膨らませず、追加 IAM / env は専用 construct に隔離する。
configureCostExplorerAccess(web.serverFn, config);

// 任意: Secret 名・アラーム通知先を context で渡せる（平文コミットを避ける）。
const vonageSecretName = app.node.tryGetContext('vonageSecretName') as string | undefined;
const siteTokenSecretName = app.node.tryGetContext('siteTokenSecretName') as string | undefined;
const alarmEmail = app.node.tryGetContext('alarmEmail') as string | undefined;
if (alarmEmail) {
  config.notification.alarmEmail = alarmEmail;
}

// WebStack の監視 (#299)。alarmEmail の注入（上）より後に構築し、購読へ反映させる。
const webMonitoring = new WebMonitoringStack(app, `OpenReception-WebMonitoring-${config.environment}`, {
  env: { account, region },
  config,
  serverFn: web.serverFn,
  imageFn: web.imageFn,
  table: web.dataTable,
  distributionId: web.distribution.distributionId,
  description: `open-reception web monitoring (${config.environment})`,
});
// 既存 Stack 内の Component=web を監視専用タグへ上書きし、Cost Explorer で分離集計する (#379)。
overrideComponentTag(webMonitoring, COST_TAG_COMPONENTS.webMonitoring);

// CloudFront 5xxErrorRate のアラーム (#303)。AWS/CloudFront メトリクスは us-east-1 にのみ
// 発行され、アラームは同一リージョン制約があるため us-east-1 の小 Stack に置く。
// crossRegionReferences には concrete な account が必要（cross-region 参照の SSM 連携先を
// 確定させるため）。認証情報なしの synth では account が未解決になるためスキップする
// （deploy 時は CDK CLI が必ず解決する）。
if (account) {
  const cloudFrontMonitoring = new CloudFrontMonitoringStack(
    app,
    `OpenReception-CfMonitoring-${config.environment}`,
    {
      env: { account, region: 'us-east-1' },
      crossRegionReferences: true,
      config,
      distributionId: web.distribution.distributionId,
      description: `open-reception cloudfront monitoring in us-east-1 (${config.environment})`,
    },
  );
  overrideComponentTag(cloudFrontMonitoring, COST_TAG_COMPONENTS.cloudFrontMonitoring);
} else {
  console.warn(
    '[open-reception] CDK_DEFAULT_ACCOUNT が未解決のため OpenReception-CfMonitoring-* を synth 対象から除外しました（cross-region 参照には concrete account が必要）。',
  );
}

const notification = new NotificationStack(app, `OpenReception-Notification-${config.environment}`, {
  env: { account, region },
  config,
  vonageSecretName,
  siteTokenSecretName,
  description: `open-reception notification subsystem (${config.environment})`,
});

const monitoring = new MonitoringStack(app, `OpenReception-Monitoring-${config.environment}`, {
  env: { account, region },
  config,
  notificationFn: notification.notificationFn.fn,
  httpApi: notification.api.httpApi,
  description: `open-reception notification monitoring (${config.environment})`,
});
overrideComponentTag(monitoring, COST_TAG_COMPONENTS.monitoring);

// リアルタイム会話 EC2 基盤 (#366 Phase 0)。config.realtime.enabled が true の環境のみ synth 対象に
// 含める（既定は全環境 false — 本プロジェクト初の実質的固定費のためユーザー承認後に true 化する）。
// `-c realtimeHostedZoneId=... -c realtimeZoneName=... -c realtimeRecordName=...` で Route 53 連携を
// 任意指定できる（未指定なら Route 53 リソースを作らない、customDomain と同じ任意 context の方針）。
if (config.realtime.enabled) {
  const realtimeHostedZoneId = app.node.tryGetContext('realtimeHostedZoneId') as string | undefined;
  const realtimeZoneName = app.node.tryGetContext('realtimeZoneName') as string | undefined;
  const realtimeRecordName = app.node.tryGetContext('realtimeRecordName') as string | undefined;
  const realtimeDns: RealtimeRuntimeDnsConfig | undefined =
    realtimeHostedZoneId && realtimeZoneName && realtimeRecordName
      ? { hostedZoneId: realtimeHostedZoneId, zoneName: realtimeZoneName, recordName: realtimeRecordName }
      : undefined;

  new RealtimeRuntimeStack(app, `OpenReception-RealtimeRuntime-${config.environment}`, {
    env: { account, region },
    config,
    dns: realtimeDns,
    description: `open-reception realtime runtime EC2 (${config.environment})`,
  });
}

app.synth();
