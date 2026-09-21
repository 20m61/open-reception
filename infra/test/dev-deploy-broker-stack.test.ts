import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  DEV_DEPLOY_PROMOTION_BRANCH,
  DevDeployBrokerStack,
} from '../lib/stacks/dev-deploy-broker-stack';

const synth = () => {
  const app = new cdk.App();
  const stack = new DevDeployBrokerStack(app, 'TestDevDeployBroker', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  return Template.fromStack(stack);
};

const policyDocumentsForRole = (
  template: Template,
  roleName: string,
): unknown[] => {
  const roles = template.findResources('AWS::IAM::Role');
  const roleEntry = Object.entries(roles).find(
    ([, value]) => (value.Properties as { RoleName?: string }).RoleName === roleName,
  );
  expect(roleEntry, `role ${roleName} must exist`).toBeDefined();
  const logicalId = roleEntry?.[0];

  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values(policies)
    .filter((value) => {
      const roleRefs = ((value.Properties as { Roles?: unknown[] }).Roles ?? []) as Array<
        { Ref?: string } | string
      >;
      return roleRefs.some((ref) => typeof ref === 'object' && ref?.Ref === logicalId);
    })
    .map((value) => (value.Properties as { PolicyDocument?: unknown }).PolicyDocument);
};

describe('DevDeployBrokerStack (#1146 Phase 1)', () => {
  const template = synth();

  it('uses a V1 CodePipeline and a dedicated promotion branch', () => {
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineType: 'V1',
    });

    const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
    const serialized = JSON.stringify(pipelines);
    expect(serialized).toContain('CodeStarSourceConnection');
    expect(serialized).toContain(DEV_DEPLOY_PROMOTION_BRANCH);
  });

  it('creates separate validation and trusted-broker CodeBuild projects with concurrency 1', () => {
    template.resourceCountIs('AWS::CodeBuild::Project', 2);

    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'OpenReceptionDevDeployValidation',
      ConcurrentBuildLimit: 1,
    });
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'OpenReceptionTrustedDevDeployBroker',
      ConcurrentBuildLimit: 1,
    });
  });

  it('keeps candidate validation role away from deploy AssumeRole authority', () => {
    const docs = policyDocumentsForRole(template, 'OpenReceptionDevDeployValidationRole');
    expect(JSON.stringify(docs)).not.toContain('sts:AssumeRole');
    expect(JSON.stringify(docs)).not.toContain('codeconnections:GetConnectionToken');
    expect(JSON.stringify(docs)).not.toContain('cloudformation:');
  });

  it('scrubs ambient AWS credential providers before candidate lifecycle scripts run', () => {
    const projects = template.findResources('AWS::CodeBuild::Project');
    const validation = Object.values(projects).find(
      (value) =>
        (value.Properties as { Name?: string }).Name === 'OpenReceptionDevDeployValidation',
    );
    expect(validation).toBeDefined();

    const buildSpec = JSON.stringify(
      ((validation?.Properties as { Source?: { BuildSpec?: unknown } }).Source ?? {}).BuildSpec ?? '',
    );
    const unsetAt = buildSpec.indexOf('unset AWS_SESSION_TOKEN');
    const npmAt = buildSpec.indexOf('npm ci');
    expect(unsetAt).toBeGreaterThanOrEqual(0);
    expect(npmAt).toBeGreaterThan(unsetAt);
    expect(buildSpec).toContain('AWS_WEB_IDENTITY_TOKEN_FILE');
    expect(buildSpec).toContain('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI');
    expect(buildSpec).toContain('AWS_CONTAINER_CREDENTIALS_FULL_URI');
    expect(buildSpec).toContain('AWS_ACCESS_KEY_ID=test');
    expect(buildSpec).toContain('AWS_EC2_METADATA_DISABLED=true');
  });

  it('keeps the trusted broker unarmed in Phase 1', () => {
    const docs = policyDocumentsForRole(template, 'OpenReceptionTrustedDevDeployBrokerRole');
    expect(JSON.stringify(docs)).not.toContain('sts:AssumeRole');
    expect(JSON.stringify(docs)).not.toContain('cloudformation:');
  });

  it('keeps source-provider credentials in the pipeline plane, not CodeBuild roles', () => {
    template.resourceCountIs('AWS::CodeBuild::SourceCredential', 0);

    const buildPolicies = [
      ...policyDocumentsForRole(template, 'OpenReceptionDevDeployValidationRole'),
      ...policyDocumentsForRole(template, 'OpenReceptionTrustedDevDeployBrokerRole'),
    ];
    expect(JSON.stringify(buildPolicies)).not.toContain('codeconnections:');
    expect(JSON.stringify(buildPolicies)).not.toContain('codestar-connections:');
  });

  it('pins the trusted broker buildspec in the stack and never invokes repository scripts', () => {
    const projects = template.findResources('AWS::CodeBuild::Project');
    const broker = Object.values(projects).find(
      (value) =>
        (value.Properties as { Name?: string }).Name === 'OpenReceptionTrustedDevDeployBroker',
    );
    expect(broker).toBeDefined();

    const buildSpec = JSON.stringify(
      ((broker?.Properties as { Source?: { BuildSpec?: unknown } }).Source ?? {}).BuildSpec ?? '',
    );
    expect(buildSpec).toContain('BROKER_NOT_ARMED');
    expect(buildSpec).toContain('broker-evidence.json');
    expect(buildSpec).not.toContain('npm ');
    expect(buildSpec).not.toContain('scripts/');
    expect(buildSpec).not.toContain('cdk deploy');
  });
});
