#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const POLICY_VERSION = 1;

export const APPROVED_STACKS = Object.freeze({
  'OpenReception-Web-dev': 'ap-northeast-1',
  'OpenReception-WebMonitoring-dev': 'ap-northeast-1',
  'OpenReception-CfMon-dev': 'us-east-1',
});

export const REVIEWED_CARVE_OUT_ROLES = new Set([
  'CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092',
  'CustomCrossRegionExportWriterCustomResourceProviderRoleC951B1E1',
  'CustomCrossRegionExportReaderCustomResourceProviderRole10531BBD',
  'CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756CServiceRole89A01265',
]);

const APPROVED_FUNCTION_URLS = Object.freeze({
  ServerFnFunctionUrlFFF9E3E1: { authType: 'NONE', functionLogicalId: 'ServerFn4F3A536E' },
  ImageFnFunctionUrlBBD47D3E: { authType: 'AWS_IAM', functionLogicalId: 'ImageFnCD541B83' },
});

const APPROVED_PUBLIC_PERMISSIONS = Object.freeze({
  ServerFninvokefunctionurl715820CF: 'ServerFn4F3A536E',
  ServerFninvokefunctionA3A7399A: 'ServerFn4F3A536E',
});

const PRODUCT_LAMBDA_CONCURRENCY = Object.freeze({
  ServerFn4F3A536E: 5,
  ImageFnCD541B83: 2,
});

export const APPROVED_RESOURCE_TYPES = new Set([
  'AWS::CDK::Metadata',
  'AWS::CloudFront::Distribution',
  'AWS::CloudFront::OriginAccessControl',
  'AWS::CloudFront::CachePolicy',
  'AWS::CloudFront::ResponseHeadersPolicy',
  'AWS::Lambda::Function',
  'AWS::Lambda::Permission',
  'AWS::Lambda::Url',
  'AWS::IAM::Role',
  'AWS::IAM::Policy',
  'AWS::S3::Bucket',
  'AWS::S3::BucketPolicy',
  'AWS::DynamoDB::Table',
  'AWS::Cognito::UserPool',
  'AWS::Cognito::UserPoolClient',
  'AWS::Logs::LogGroup',
  'AWS::Logs::MetricFilter',
  'AWS::CloudWatch::Alarm',
  'AWS::CloudWatch::Dashboard',
  'AWS::SNS::Topic',
  'AWS::SNS::TopicPolicy',
  'AWS::SNS::Subscription',
  'Custom::S3AutoDeleteObjects',
  'Custom::CDKBucketDeployment',
  'Custom::CrossRegionExportWriter',
  'Custom::CrossRegionExportReader',
]);

const HUMAN_GATE_RESOURCE_TYPES = new Map([
  ['AWS::EC2::NatGateway', 'fixed-cost NAT Gateway'],
  ['AWS::EC2::Instance', 'persistent EC2 compute'],
  ['AWS::EC2::LaunchTemplate', 'persistent/elastic EC2 compute'],
  ['AWS::AutoScaling::AutoScalingGroup', 'elastic EC2 compute'],
  ['AWS::RDS::DBInstance', 'persistent database'],
  ['AWS::RDS::DBCluster', 'persistent database'],
  ['AWS::OpenSearchService::Domain', 'persistent search cluster'],
  ['AWS::Elasticsearch::Domain', 'persistent search cluster'],
  ['AWS::MSK::Cluster', 'persistent streaming cluster'],
  ['AWS::MSK::ServerlessCluster', 'streaming service'],
  ['AWS::EKS::Cluster', 'Kubernetes control plane'],
  ['AWS::ECS::Service', 'long-running container service'],
  ['AWS::Redshift::Cluster', 'persistent warehouse'],
  ['AWS::ElastiCache::CacheCluster', 'persistent cache'],
  ['AWS::ElastiCache::ReplicationGroup', 'persistent cache'],
  ['AWS::MemoryDB::Cluster', 'persistent cache'],
  ['AWS::SageMaker::Endpoint', 'persistent ML endpoint'],
  ['AWS::SageMaker::EndpointConfig', 'persistent ML endpoint'],
  ['AWS::AppRunner::Service', 'long-running service'],
  ['AWS::Events::Rule', 'scheduled/event-driven loop surface'],
  ['AWS::Scheduler::Schedule', 'scheduled loop surface'],
  ['AWS::StepFunctions::StateMachine', 'workflow/retry loop surface'],
  ['AWS::Lambda::EventSourceMapping', 'event-driven concurrency surface'],
  ['AWS::SQS::Queue', 'async retry/backlog surface'],
]);

const RESOURCE_COUNT_CAPS = Object.freeze({
  'AWS::Lambda::Function': 16,
  'AWS::IAM::Role': 18,
  'AWS::IAM::Policy': 20,
  'AWS::S3::Bucket': 4,
  'AWS::DynamoDB::Table': 3,
  'AWS::CloudFront::Distribution': 2,
  'AWS::CloudFront::CachePolicy': 4,
  'AWS::CloudFront::ResponseHeadersPolicy': 4,
  'AWS::Cognito::UserPool': 1,
  'AWS::Cognito::UserPoolClient': 2,
  'AWS::CloudWatch::Alarm': 30,
  'AWS::CloudWatch::Dashboard': 4,
  'AWS::SNS::Topic': 4,
  'AWS::Logs::LogGroup': 20,
  'AWS::Logs::MetricFilter': 12,
  'Custom::CDKBucketDeployment': 2,
});
const MAX_TOTAL_RESOURCES = 220;
const MAX_RESOURCES_PER_STACK = 140;

const GLOBAL_RESOURCE_SAFE_ACTIONS = new Set([
  'ce:getcostandusage',
  'ce:getcostforecast',
  'cloudwatch:getmetricdata',
  'cloudwatch:getmetricstatistics',
  'cloudwatch:listmetrics',
]);

const LOOP_CAPABLE_IAM_ACTIONS = new Set([
  'lambda:invokefunction',
  'events:putevents',
  'states:startexecution',
  'sqs:sendmessage',
  'sns:publish',
  'scheduler:createschedule',
  'scheduler:updateschedule',
  'ecs:runtask',
  'ec2:runinstances',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function violation(rule, stack, resource, reason) {
  return { rule, stack, resource, reason };
}

function resolvesToLogicalId(value, logicalId) {
  if (!isRecord(value)) return false;
  if (value.Ref === logicalId) return true;
  const getAtt = value['Fn::GetAtt'];
  return Array.isArray(getAtt) && getAtt[0] === logicalId;
}

function boundaryLooksCorrect(value) {
  return JSON.stringify(value).includes('OpenReceptionClaudeBoundary');
}

function policyDocumentViolations(stackName, logicalId, document) {
  const out = [];
  if (!isRecord(document) || !Array.isArray(document.Statement)) {
    out.push(violation('IAM_POLICY_OPAQUE', stackName, logicalId, 'PolicyDocument.Statement is not a concrete array'));
    return out;
  }
  for (const statement of document.Statement) {
    if (!isRecord(statement) || statement.Effect !== 'Allow') continue;
    const actions = asArray(statement.Action).filter((x) => typeof x === 'string').map((x) => x.toLowerCase());
    const resources = asArray(statement.Resource);
    if (actions.includes('*') || actions.includes('iam:*') || actions.includes('sts:*') || actions.includes('kms:*')) {
      out.push(violation('IAM_ADMIN_OR_CONTROL_PLANE', stackName, logicalId, `broad control-plane action: ${actions.join(',')}`));
    }
    for (const action of actions) {
      if (LOOP_CAPABLE_IAM_ACTIONS.has(action)) {
        out.push(violation('IAM_LOOP_CAPABLE_ACTION', stackName, logicalId, `runtime role may trigger work recursively: ${action}`));
      }
    }
    if (resources.includes('*')) {
      const unsafe = actions.filter((action) => !GLOBAL_RESOURCE_SAFE_ACTIONS.has(action));
      if (unsafe.length > 0) {
        out.push(violation('IAM_UNSCOPED_RESOURCE', stackName, logicalId, `Resource:* with non-reviewed actions: ${unsafe.join(',')}`));
      }
    }
  }
  return out;
}

function evaluateResource(stackName, logicalId, resource) {
  const out = [];
  if (!isRecord(resource) || typeof resource.Type !== 'string') {
    return [violation('RESOURCE_SHAPE_INVALID', stackName, logicalId, 'resource has no concrete Type')];
  }
  const type = resource.Type;
  const props = isRecord(resource.Properties) ? resource.Properties : {};

  if (HUMAN_GATE_RESOURCE_TYPES.has(type)) {
    out.push(violation('RESOURCE_TYPE_HUMAN_GATE', stackName, logicalId, HUMAN_GATE_RESOURCE_TYPES.get(type)));
    return out;
  }
  if (!APPROVED_RESOURCE_TYPES.has(type)) {
    out.push(violation('RESOURCE_TYPE_NOT_APPROVED', stackName, logicalId, `resource type ${type} is outside the reviewed dev set`));
    return out;
  }

  if (type === 'AWS::IAM::Role' && !REVIEWED_CARVE_OUT_ROLES.has(logicalId)) {
    if (!('PermissionsBoundary' in props) || !boundaryLooksCorrect(props.PermissionsBoundary)) {
      out.push(violation('IAM_BOUNDARY_REQUIRED', stackName, logicalId, 'role must carry OpenReceptionClaudeBoundary'));
    }
  }

  if (type === 'AWS::IAM::Policy') {
    out.push(...policyDocumentViolations(stackName, logicalId, props.PolicyDocument));
  }

  if (type === 'AWS::Lambda::Function') {
    const memory = props.MemorySize;
    if (typeof memory === 'number' && memory > 2048) {
      out.push(violation('LAMBDA_MEMORY_TOO_HIGH', stackName, logicalId, `MemorySize ${memory}MB exceeds dev ceiling 2048MB`));
    }
    if (Object.prototype.hasOwnProperty.call(PRODUCT_LAMBDA_CONCURRENCY, logicalId)) {
      const max = PRODUCT_LAMBDA_CONCURRENCY[logicalId];
      const reserved = props.ReservedConcurrentExecutions;
      if (typeof reserved !== 'number') {
        out.push(violation('LAMBDA_CONCURRENCY_REQUIRED', stackName, logicalId, `product Lambda requires ReservedConcurrentExecutions <= ${max}`));
      } else if (reserved < 1 || reserved > max) {
        out.push(violation('LAMBDA_CONCURRENCY_TOO_HIGH', stackName, logicalId, `ReservedConcurrentExecutions ${reserved} outside 1..${max}`));
      }
    }
  }

  if (type === 'AWS::DynamoDB::Table') {
    if (props.BillingMode !== 'PAY_PER_REQUEST') {
      out.push(violation('DYNAMODB_ON_DEMAND_REQUIRED', stackName, logicalId, 'dev table must use PAY_PER_REQUEST'));
    }
    if ('ProvisionedThroughput' in props) {
      out.push(violation('DYNAMODB_PROVISIONED_FORBIDDEN', stackName, logicalId, 'ProvisionedThroughput is not allowed in dev'));
    }
  }

  if (type === 'AWS::S3::Bucket') {
    const pab = props.PublicAccessBlockConfiguration;
    const safe =
      isRecord(pab) &&
      pab.BlockPublicAcls === true &&
      pab.BlockPublicPolicy === true &&
      pab.IgnorePublicAcls === true &&
      pab.RestrictPublicBuckets === true;
    if (!safe) {
      out.push(violation('S3_PUBLIC_BLOCK_REQUIRED', stackName, logicalId, 'all S3 public-access-block flags must be true'));
    }
  }

  if (type === 'AWS::CloudFront::Distribution') {
    const config = props.DistributionConfig;
    if (!isRecord(config) || !['PriceClass_100', 'PriceClass_200'].includes(config.PriceClass)) {
      out.push(violation('CLOUDFRONT_PRICE_CLASS_BOUNDED', stackName, logicalId, 'dev distribution must use PriceClass_100 or PriceClass_200'));
    }
  }

  if (type === 'AWS::Lambda::Url') {
    const reviewed = APPROVED_FUNCTION_URLS[logicalId];
    if (!reviewed) {
      out.push(violation('FUNCTION_URL_NOT_REVIEWED', stackName, logicalId, 'unknown Function URL is a new public ingress'));
    } else {
      if (props.AuthType !== reviewed.authType) {
        out.push(violation('FUNCTION_URL_AUTH_CHANGED', stackName, logicalId, `expected AuthType ${reviewed.authType}`));
      }
      if (!resolvesToLogicalId(props.TargetFunctionArn, reviewed.functionLogicalId)) {
        out.push(violation('FUNCTION_URL_TARGET_CHANGED', stackName, logicalId, `expected target ${reviewed.functionLogicalId}`));
      }
    }
  }

  if (type === 'AWS::Lambda::Permission' && props.Principal === '*') {
    const expected = APPROVED_PUBLIC_PERMISSIONS[logicalId];
    if (!expected || !resolvesToLogicalId(props.FunctionName, expected)) {
      out.push(violation('PUBLIC_LAMBDA_PERMISSION_NOT_REVIEWED', stackName, logicalId, 'Principal:* is not one of the reviewed server Function URL permissions'));
    }
  }

  return out;
}

function safeTemplatePath(assemblyDir, templateFile) {
  if (typeof templateFile !== 'string' || templateFile.length === 0) return null;
  const resolved = path.resolve(assemblyDir, templateFile);
  const root = path.resolve(assemblyDir) + path.sep;
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

export function evaluateAssembly({ assemblyDir, targetAccount }) {
  const violations = [];
  const manifestPath = path.join(assemblyDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      policyVersion: POLICY_VERSION,
      result: 'denied',
      violations: [violation('ASSEMBLY_MANIFEST_INVALID', null, null, String(error))],
      counts: {},
    };
  }

  if (!isRecord(manifest) || !isRecord(manifest.artifacts)) {
    return {
      policyVersion: POLICY_VERSION,
      result: 'denied',
      violations: [violation('ASSEMBLY_MANIFEST_INVALID', null, null, 'manifest.artifacts must be an object')],
      counts: {},
    };
  }

  const seenStacks = new Set();
  const counts = {};
  let totalResources = 0;

  for (const [artifactId, artifact] of Object.entries(manifest.artifacts)) {
    if (!isRecord(artifact) || artifact.type !== 'aws:cloudformation:stack') continue;
    const props = isRecord(artifact.properties) ? artifact.properties : {};
    const stackName = typeof props.stackName === 'string' ? props.stackName : artifactId;
    const expectedRegion = APPROVED_STACKS[stackName];

    if (!expectedRegion) {
      violations.push(violation('STACK_NOT_APPROVED', stackName, null, 'stack is outside the ADR 0009 autonomous dev set'));
      continue;
    }
    seenStacks.add(stackName);

    const expectedEnvironment = `aws://${targetAccount}/${expectedRegion}`;
    if (artifact.environment !== expectedEnvironment) {
      violations.push(violation('STACK_ENVIRONMENT_MISMATCH', stackName, null, `expected ${expectedEnvironment}, got ${String(artifact.environment)}`));
    }

    const templatePath = safeTemplatePath(assemblyDir, props.templateFile);
    if (!templatePath) {
      violations.push(violation('TEMPLATE_PATH_INVALID', stackName, null, 'templateFile escapes or is missing from cloud assembly'));
      continue;
    }

    let template;
    try {
      template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    } catch (error) {
      violations.push(violation('TEMPLATE_INVALID', stackName, null, String(error)));
      continue;
    }
    if (!isRecord(template) || !isRecord(template.Resources)) {
      violations.push(violation('TEMPLATE_INVALID', stackName, null, 'Resources must be an object'));
      continue;
    }

    const entries = Object.entries(template.Resources);
    if (entries.length > MAX_RESOURCES_PER_STACK) {
      violations.push(violation('STACK_RESOURCE_COUNT_EXCEEDED', stackName, null, `${entries.length} resources exceeds ${MAX_RESOURCES_PER_STACK}`));
    }

    for (const [logicalId, resource] of entries) {
      totalResources += 1;
      if (isRecord(resource) && typeof resource.Type === 'string') {
        counts[resource.Type] = (counts[resource.Type] ?? 0) + 1;
      }
      violations.push(...evaluateResource(stackName, logicalId, resource));
    }
  }

  for (const stackName of Object.keys(APPROVED_STACKS)) {
    if (!seenStacks.has(stackName)) {
      violations.push(violation('STACK_MISSING', stackName, null, 'approved promotion assembly must contain all three reviewed stacks'));
    }
  }

  if (totalResources > MAX_TOTAL_RESOURCES) {
    violations.push(violation('ASSEMBLY_RESOURCE_COUNT_EXCEEDED', null, null, `${totalResources} resources exceeds ${MAX_TOTAL_RESOURCES}`));
  }

  for (const [type, cap] of Object.entries(RESOURCE_COUNT_CAPS)) {
    const count = counts[type] ?? 0;
    if (count > cap) {
      violations.push(violation('RESOURCE_COUNT_EXCEEDED', null, type, `${count} resources exceeds reviewed cap ${cap}`));
    }
  }

  return {
    policyVersion: POLICY_VERSION,
    result: violations.length === 0 ? 'allowed' : 'denied',
    violations,
    counts,
  };
}

function parseCli(argv) {
  let assemblyDir = '';
  let targetAccount = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--assembly') assemblyDir = argv[++i] ?? '';
    else if (argv[i] === '--account') targetAccount = argv[++i] ?? '';
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!assemblyDir) throw new Error('--assembly is required');
  if (!/^[0-9]{12}$/.test(targetAccount)) throw new Error('--account must be a 12-digit AWS account id');
  return { assemblyDir, targetAccount };
}

async function main() {
  try {
    const args = parseCli(process.argv.slice(2));
    const result = evaluateAssembly(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.result === 'allowed' ? 0 : 41;
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : error) + '\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
