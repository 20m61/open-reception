import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';

export const DEV_DEPLOY_PROMOTION_BRANCH = 'dev-deploy';

const VALIDATION_PROJECT_NAME = 'OpenReceptionDevDeployValidation';
const BROKER_PROJECT_NAME = 'OpenReceptionTrustedDevDeployBroker';

/**
 * Dev deploy broker control plane (#1146).
 *
 * Security boundary:
 * - CodeConnections terminates in CodePipeline, not in candidate-code execution.
 * - Validation executes repository-controlled code but has no dev mutation/AssumeRole authority.
 * - Validation output (including cdk.out) remains untrusted input.
 * - Trusted Broker uses a buildspec and policy asset deployed with THIS stack; candidate source
 *   cannot replace either in the running broker.
 * - The broker independently evaluates the candidate cloud assembly.
 * - Mutation remains intentionally UNARMED: broker role has no sts:AssumeRole / CFN write authority.
 *
 * This stack is human/bootstrap-managed control-plane infrastructure and deliberately does not
 * match the autonomous OpenReception-*-dev workload stack allowlist.
 */
export class DevDeployBrokerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const githubConnectionArn = new cdk.CfnParameter(this, 'GitHubConnectionArn', {
      type: 'String',
      description:
        'Human-approved AWS CodeConnections connection ARN for 20m61/open-reception.',
      allowedPattern:
        '^arn:aws[^:]*:(codeconnections|codestar-connections):[^:]+:[0-9]{12}:connection/.+$',
      constraintDescription: 'must be an AWS CodeConnections connection ARN',
    });

    // Non-secret promotion context. Raw ORIGIN_VERIFY_SECRET is deliberately absent.
    const appSecretsName = new cdk.CfnParameter(this, 'DevAppSecretsName', {
      type: 'String',
      description:
        'Secrets Manager name used for appSecretsName and originVerifySecretName in dev synth.',
      allowedPattern: '^[A-Za-z0-9/_+=.@-]+$',
    });
    const publicOriginOverride = new cdk.CfnParameter(this, 'DevPublicOriginOverride', {
      type: 'String',
      description: 'Current HTTPS public origin used when synthesizing dev QR/public links.',
      allowedPattern: '^https://[^\\s/]+(?::[0-9]+)?(?:/.*)?$',
    });
    const providerSecretBackend = new cdk.CfnParameter(this, 'DevProviderSecretBackend', {
      type: 'String',
      default: 'secrets-manager',
      allowedValues: ['memory', 'secrets-manager'],
      description: 'Provider secret backend for the dev cloud assembly.',
    });

    const validationRole = new iam.Role(this, 'ValidationRole', {
      roleName: 'OpenReceptionDevDeployValidationRole',
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description:
        'Unprivileged candidate-code validation; no dev mutation or deploy-role AssumeRole authority.',
    });

    const brokerRole = new iam.Role(this, 'TrustedBrokerRole', {
      roleName: 'OpenReceptionTrustedDevDeployBrokerRole',
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description:
        'Trusted broker; static policy only. Mutation role chain is intentionally unarmed.',
    });

    // This asset is content-addressed and published when the human-managed broker stack is
    // deployed. Candidate pipeline artifacts never supply the trusted policy implementation.
    const trustedPolicyAsset = new s3assets.Asset(this, 'TrustedPolicyAsset', {
      path: path.join(__dirname, '../../broker/trusted-policy.mjs'),
    });
    trustedPolicyAsset.grantRead(brokerRole);

    const validationLogs = new logs.LogGroup(this, 'ValidationLogs', {
      logGroupName: '/aws/codebuild/open-reception-dev-deploy-validation',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const brokerLogs = new logs.LogGroup(this, 'BrokerLogs', {
      logGroupName: '/aws/codebuild/open-reception-trusted-dev-deploy-broker',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const validationProject = new codebuild.PipelineProject(this, 'ValidationProject', {
      projectName: VALIDATION_PROJECT_NAME,
      description:
        'Candidate-controlled validation with no AWS dev mutation authority; emits untrusted evidence/cloud assembly.',
      role: validationRole,
      concurrentBuildLimit: 1,
      timeout: cdk.Duration.minutes(30),
      queuedTimeout: cdk.Duration.minutes(5),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: false,
        environmentVariables: {
          OR_BROKER_TARGET_ACCOUNT: { value: cdk.Aws.ACCOUNT_ID },
          OR_BROKER_TARGET_REGION: { value: cdk.Aws.REGION },
          OR_APP_SECRETS_NAME: { value: appSecretsName.valueAsString },
          OR_PUBLIC_ORIGIN_OVERRIDE: { value: publicOriginOverride.valueAsString },
          OR_PROVIDER_SECRET_BACKEND: { value: providerSecretBackend.valueAsString },
        },
      },
      logging: {
        cloudWatch: { logGroup: validationLogs },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { nodejs: 22 },
            commands: [
              // Candidate-controlled lifecycle scripts run below. Scrub standard SDK credential
              // providers first. The role has no dev mutation authority regardless; this also
              // preserves the MiniStack/Moto hermeticity contract.
              'unset AWS_SESSION_TOKEN AWS_PROFILE AWS_CREDENTIAL_EXPIRATION AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_AUTHORIZATION_TOKEN AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
              'export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_EC2_METADATA_DISABLED=true',
              'npm ci',
              'npm --prefix infra ci',
            ],
          },
          build: {
            commands: [
              // CodePipeline source archives do not provide a trustworthy local git history.
              // Promotion is intentionally rare, so run the full suite instead of a diff-optimized
              // PR gate. The inexpensive inner loop remains local Claude + MiniStack/Moto.
              'npm run typecheck',
              'npm run lint',
              'npm test',
              'npm run build:open-next',
              'npm run aws:local:test',
              'npm --prefix infra run typecheck',
              'npm --prefix infra test',
              // Only the three stacks already admitted by ADR 0009 are synthesized.
              // Context is non-secret; originVerifySecretName reuses the app secret NAME.
              'cd infra && CDK_DEFAULT_ACCOUNT="$OR_BROKER_TARGET_ACCOUNT" CDK_DEFAULT_REGION="$OR_BROKER_TARGET_REGION" npx cdk synth OpenReception-Web-dev OpenReception-WebMonitoring-dev OpenReception-CfMon-dev --output cdk.out -c env=dev -c claudeBoundary=OpenReceptionClaudeBoundary -c appSecretsName="$OR_APP_SECRETS_NAME" -c originVerifySecretName="$OR_APP_SECRETS_NAME" -c publicOriginOverride="$OR_PUBLIC_ORIGIN_OVERRIDE" -c providerSecretBackend="$OR_PROVIDER_SECRET_BACKEND" && cd ..',
              'node -e "const fs=require(\\'fs\\'); const out={schemaVersion:1,sourceRevision:process.env.CODEBUILD_RESOLVED_SOURCE_VERSION||\\'unknown\\',validationBuildArn:process.env.CODEBUILD_BUILD_ARN||\\'unknown\\',observedAt:new Date().toISOString(),status:\\'validation-complete\\'}; fs.writeFileSync(\\'broker-evidence.json\\',JSON.stringify(out,null,2));"',
            ],
          },
        },
        artifacts: {
          files: ['broker-evidence.json', 'infra/cdk.out/**/*'],
        },
      }),
    });

    const brokerProject = new codebuild.PipelineProject(this, 'TrustedBrokerProject', {
      projectName: BROKER_PROJECT_NAME,
      description:
        'Trusted broker: independently evaluates candidate cloud assembly; mutation is intentionally unarmed.',
      role: brokerRole,
      concurrentBuildLimit: 1,
      timeout: cdk.Duration.minutes(10),
      queuedTimeout: cdk.Duration.minutes(5),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: false,
        environmentVariables: {
          OR_BROKER_TARGET_ACCOUNT: { value: cdk.Aws.ACCOUNT_ID },
          OR_TRUSTED_POLICY_BUCKET: { value: trustedPolicyAsset.s3BucketName },
          OR_TRUSTED_POLICY_KEY: { value: trustedPolicyAsset.s3ObjectKey },
        },
      },
      logging: {
        cloudWatch: { logGroup: brokerLogs },
      },
      // Critical: keep this immediate/stack-owned. Do NOT use fromSourceFilename().
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'test -f broker-evidence.json',
              'test -f infra/cdk.out/manifest.json',
              'node -e "const fs=require(\\'fs\\'); const e=JSON.parse(fs.readFileSync(\\'broker-evidence.json\\',\\'utf8\\')); if(e.schemaVersion!==1||typeof e.sourceRevision!==\\'string\\'||!e.sourceRevision){throw new Error(\\'invalid broker evidence\\')}"',
              // Download policy by the content-addressed S3 location injected by this stack.
              'aws s3 cp "s3://$OR_TRUSTED_POLICY_BUCKET/$OR_TRUSTED_POLICY_KEY" /tmp/open-reception-trusted-policy.mjs --only-show-errors',
              'node /tmp/open-reception-trusted-policy.mjs --assembly infra/cdk.out --account "$OR_BROKER_TARGET_ACCOUNT" > trusted-policy-result.json',
              // Even an allowed static assembly cannot mutate yet.
              'node -e "const fs=require(\\'fs\\'); const result={result:\\'denied\\',stage:\\'broker-bootstrap\\',rule:\\'BROKER_NOT_ARMED\\',resource:null,reason:\\'Static trusted policy passed, but sparse ledger/live ChangeSet/role chain are intentionally not armed\\',retryable:false,evidence_ref:process.env.CODEBUILD_BUILD_ARN||\\'unknown\\'}; fs.writeFileSync(\\'broker-result.json\\',JSON.stringify(result,null,2)); console.log(JSON.stringify(result));"',
              'echo "Trusted broker is intentionally unarmed." >&2',
              'exit 42',
            ],
          },
        },
      }),
    });

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'OpenReceptionSparseDevDeploy',
      pipelineType: codepipeline.PipelineType.V1,
      crossAccountKeys: false,
      restartExecutionOnUpdate: false,
    });

    const source = new codepipeline.Artifact('Source');
    const validated = new codepipeline.Artifact('Validated');

    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new actions.CodeStarConnectionsSourceAction({
          actionName: 'PromotionBranch',
          owner: '20m61',
          repo: 'open-reception',
          branch: DEV_DEPLOY_PROMOTION_BRANCH,
          connectionArn: githubConnectionArn.valueAsString,
          output: source,
          triggerOnPush: true,
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'Validate',
      actions: [
        new actions.CodeBuildAction({
          actionName: 'UnprivilegedValidation',
          project: validationProject,
          input: source,
          outputs: [validated],
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'BrokerBoundary',
      actions: [
        new actions.CodeBuildAction({
          actionName: 'TrustedBrokerUnarmed',
          project: brokerProject,
          input: validated,
        }),
      ],
    });

    cdk.Tags.of(this).add('Project', 'open-reception');
    cdk.Tags.of(this).add('Environment', 'dev');
    cdk.Tags.of(this).add('Component', 'dev-deploy-broker');
    cdk.Tags.of(this).add('ManagedBy', 'cdk');
  }
}
