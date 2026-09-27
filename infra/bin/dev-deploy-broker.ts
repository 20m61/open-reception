#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DevDeployBrokerStack } from '../lib/stacks/dev-deploy-broker-stack';

const app = new cdk.App();

new DevDeployBrokerStack(app, 'OpenReception-DevDeployBroker', {
  stackName: 'OpenReception-DevDeployBroker',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  },
  description:
    'Human-managed control plane for sparse autonomous dev deployment. Not an autonomous dev workload stack.',
});

app.synth();
