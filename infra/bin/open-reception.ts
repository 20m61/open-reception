#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WebStack } from '../lib/stacks/web-stack';
import { resolveEnv } from '../lib/config/environments';

/**
 * open-reception CDK App エントリ (docs/infrastructure-design.md §1)。
 *
 * 環境は context で選択する: `cdk deploy -c env=prod`。既定は dev。
 *
 * Stack 構成:
 *   - WebStack          : Next.js (OpenNext) ホスティング ← 本デプロイの対象
 *   - NotificationStack : 通知サブシステム (#32/#34) ← 別 issue で追加予定
 *
 * デプロイ先アカウント/リージョンは CDK 既定の環境変数
 * (CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION) を使用する。
 */
const app = new cdk.App();

const envName = app.node.tryGetContext('env') as string | undefined;
const config = resolveEnv(envName);

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1';

// 非機密のアプリ環境変数を context (`-c appEnv.KEY=value`) から集約。
const appEnvContext = (app.node.tryGetContext('appEnv') ?? {}) as Record<string, string>;

new WebStack(app, `OpenReception-Web-${config.environment}`, {
  env: { account, region },
  config,
  appEnv: appEnvContext,
  description: `open-reception Next.js hosting (${config.environment})`,
});

app.synth();
