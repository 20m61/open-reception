import { describe, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { configureCostExplorerAccess } from '../lib/constructs/cost-explorer-access';
import { resolveEnv } from '../lib/config/environments';

describe('configureCostExplorerAccess (#377)', () => {
  it('injects fixed tag filters and grants only the required Cost Explorer reads', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'CostExplorerAccessTest');
    const serverFn = new lambda.Function(stack, 'ServerFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 });'),
    });

    configureCostExplorerAccess(serverFn, resolveEnv('prod'));
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          AWS_COST_EXPLORER_ENABLED: 'true',
          AWS_COST_PROJECT_TAG_VALUE: 'open-reception',
          AWS_COST_ENVIRONMENT_TAG_VALUE: 'prod',
        }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['ce:GetCostAndUsage', 'ce:GetCostForecast']),
            Resource: '*',
          }),
        ]),
      }),
    });
  });
});
