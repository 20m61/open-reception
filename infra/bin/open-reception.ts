#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WebStack, CustomDomainConfig } from '../lib/stacks/web-stack';
import { NotificationStack } from '../lib/stacks/notification-stack';
import { MonitoringStack } from '../lib/stacks/monitoring-stack';
import { resolveEnv } from '../lib/config/environments';

/**
 * open-reception CDK App エントリ (docs/infrastructure-design.md §1)。
 *
 * 環境は context で選択する: `cdk deploy -c env=prod`。既定は dev。
 *
 * Stack 構成:
 *   - WebStack          : Next.js (OpenNext) ホスティング
 *   - NotificationStack : 通知サブシステム (#32/#34) — API + Lambda + Polly/Vonage
 *   - MonitoringStack   : 通知サブシステムの監視（Alarms / Dashboard / SNS）
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

new WebStack(app, `OpenReception-Web-${config.environment}`, {
  env: { account, region },
  config,
  appEnv: appEnvContext,
  customDomain,
  description: `open-reception Next.js hosting (${config.environment})`,
});

// 任意: Secret 名・アラーム通知先を context で渡せる（平文コミットを避ける）。
const vonageSecretName = app.node.tryGetContext('vonageSecretName') as string | undefined;
const siteTokenSecretName = app.node.tryGetContext('siteTokenSecretName') as string | undefined;
const alarmEmail = app.node.tryGetContext('alarmEmail') as string | undefined;
if (alarmEmail) {
  config.notification.alarmEmail = alarmEmail;
}

const notification = new NotificationStack(app, `OpenReception-Notification-${config.environment}`, {
  env: { account, region },
  config,
  vonageSecretName,
  siteTokenSecretName,
  description: `open-reception notification subsystem (${config.environment})`,
});

new MonitoringStack(app, `OpenReception-Monitoring-${config.environment}`, {
  env: { account, region },
  config,
  notificationFn: notification.notificationFn.fn,
  httpApi: notification.api.httpApi,
  description: `open-reception notification monitoring (${config.environment})`,
});

app.synth();
