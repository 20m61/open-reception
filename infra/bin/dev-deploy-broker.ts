#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BROKER_BOOTSTRAP_QUALIFIER, brokerStackRegion } from '../lib/config/broker-bootstrap';
import { DevDeployBrokerStack } from '../lib/stacks/dev-deploy-broker-stack';

const app = new cdk.App();

new DevDeployBrokerStack(app, 'OpenReception-DevDeployBroker', {
  stackName: 'OpenReception-DevDeployBroker',
  // A bootstrap of its own (see broker-bootstrap.ts): its cfn-exec role is the human stack-deploy role.
  synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: BROKER_BOOTSTRAP_QUALIFIER }),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Pinned; a different configured region is refused, not overridden (see broker-bootstrap.ts).
    region: brokerStackRegion(process.env),
  },
  description:
    'Human-managed control plane for sparse autonomous dev deployment. Not an autonomous dev workload stack.',
});

app.synth();
