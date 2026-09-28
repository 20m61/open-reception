#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const POLICY_VERSION = 2;

export const APPROVED_STACKS = Object.freeze({
  'OpenReception-Web-dev': 'ap-northeast-1',
  'OpenReception-WebMonitoring-dev': 'ap-northeast-1',
  'OpenReception-CfMon-dev': 'us-east-1',
});

/**
 * CDK-generated roles that cannot carry the permissions boundary (the CDK cross-region export
 * providers are created outside the Aspect that adds it). A logical id alone is not a review:
 * a candidate can declare a role with the same id. The exemption therefore applies only while
 * the role keeps exactly the reviewed shape below (Lambda trust, AWSLambdaBasicExecutionRole,
 * inline SSM statements limited to the reviewed actions on `parameter/cdk/exports/...` of the
 * target account, and no standalone policy attached). Anything else is an ordinary role and
 * needs the boundary. Every other CDK provider role in the real dev assembly carries the
 * boundary and needs no carve-out.
 */
export const REVIEWED_CARVE_OUT_ROLES = Object.freeze({
  CustomCrossRegionExportWriterCustomResourceProviderRoleC951B1E1: Object.freeze([
    'ssm:deleteparameters',
    'ssm:listtagsforresource',
    'ssm:getparameters',
    'ssm:putparameter',
  ]),
  CustomCrossRegionExportReaderCustomResourceProviderRole10531BBD: Object.freeze([
    'ssm:addtagstoresource',
    'ssm:removetagsfromresource',
    'ssm:getparameters',
  ]),
});

/**
 * CDK provider functions whose role holds authority beyond the permissions boundary or over a
 * resource policy (the two cross-region export carve-outs, and the auto-delete provider that the
 * asset bucket's policy lets rewrite that policy). Their code is an asset the candidate build
 * produces, so a logical id and a role are not a review: the function must keep the reviewed
 * handler, no environment / layers, and code whose directory digest (see `treeDigest`) equals the
 * aws-cdk-lib handler reviewed here. Any other function running as one of these roles is denied.
 * A CDK upgrade that changes a handler changes the digest and is a policy change.
 */
export const PINNED_PROVIDER_FUNCTIONS = Object.freeze({
  CustomS3AutoDeleteObjectsCustomResourceProviderHandler9D90184F: Object.freeze({
    role: 'CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092',
    handler: 'index.handler',
    customType: 'Custom::S3AutoDeleteObjects',
    codeDigest: 'c85818e2a87fe325f46222ff8803b09e1cf2621d8558c0debbb13f4e6fc25280',
  }),
  CustomCrossRegionExportWriterCustomResourceProviderHandlerD8786E8A: Object.freeze({
    role: 'CustomCrossRegionExportWriterCustomResourceProviderRoleC951B1E1',
    handler: '__entrypoint__.handler',
    customType: 'Custom::CrossRegionExportWriter',
    codeDigest: '55ab878a83a06a76b47733bf8c40d408f6e0136df7c5a062e1307bf605a8e465',
  }),
  CustomCrossRegionExportReaderCustomResourceProviderHandler46647B68: Object.freeze({
    role: 'CustomCrossRegionExportReaderCustomResourceProviderRole10531BBD',
    handler: '__entrypoint__.handler',
    customType: 'Custom::CrossRegionExportReader',
    codeDigest: '995bb422d7f6a33bfe7fdad08fc5b6af4bc09333949def485ca5b6e4a139570b',
  }),
});
const PINNED_PROVIDER_BY_ROLE = new Map(Object.entries(PINNED_PROVIDER_FUNCTIONS).map(([fn, p]) => [p.role, fn]));

/**
 * The one reviewed resource-policy grant of a sharing action: CDK's auto-delete provider on the
 * bucket it empties (exact actions, principal and local resources). Its code is pinned above.
 */
const AUTO_DELETE_GRANT_ACTIONS = Object.freeze(['s3:DeleteObject*', 's3:GetBucket*', 's3:List*', 's3:PutBucketPolicy']);

/**
 * Actions that change who else can reach a resource or where its data / events go (resource
 * policies, ACLs, replication, notifications, subscriptions, export, function URLs / event
 * wiring, OAuth clients). A deployed workload holding one could create at runtime the grants this
 * policy refuses in templates, so candidate IAM never gets them, on any resource. Matched as IAM
 * globs (`s3:Put*`, `s3:*`, `*` all hit).
 */
export const RESOURCE_SHARING_ACTIONS = Object.freeze([
  's3:putbucketpolicy', 's3:deletebucketpolicy', 's3:putbucketacl', 's3:putobjectacl', 's3:putobjectversionacl',
  's3:putreplicationconfiguration', 's3:putbucketnotification', 's3:putaccesspointpolicy', 's3:createaccesspoint',
  's3:putbucketpublicaccessblock', 's3:putaccountpublicaccessblock', 's3:putbucketownershipcontrols', 's3:putbucketwebsite',
  's3:putbucketlogging', 's3:putinventoryconfiguration', 's3:putanalyticsconfiguration', 's3:putmultiregionaccesspointpolicy',
  's3:putaccessgrantsinstanceresourcepolicy', 's3:createaccessgrant', 's3:putaccesspointpolicyforobjectlambda',
  'dynamodb:putresourcepolicy', 'dynamodb:deleteresourcepolicy', 'dynamodb:exporttabletopointintime', 'dynamodb:updatetable',
  'dynamodb:createtablereplica', 'dynamodb:enablekinesisstreamingdestination', 'dynamodb:updatekinesisstreamingdestination',
  'lambda:addpermission', 'lambda:addlayerversionpermission', 'lambda:createfunctionurlconfig', 'lambda:updatefunctionurlconfig',
  'lambda:putfunctioneventinvokeconfig', 'lambda:updatefunctioneventinvokeconfig', 'lambda:createeventsourcemapping',
  'lambda:updatefunctionconfiguration', 'lambda:updatefunctioncode', 'lambda:createfunction', 'lambda:putfunctionrecursionconfig',
  'cognito-idp:updateuserpoolclient', 'cognito-idp:createuserpoolclient', 'cognito-idp:updateuserpool',
  'cognito-idp:createidentityprovider', 'cognito-idp:updateidentityprovider', 'cognito-idp:createuserpooldomain',
  'cognito-idp:setlogdeliveryconfiguration', 'cognito-idp:createresourceserver', 'cognito-idp:admincreateuser',
  'cognito-idp:adminaddusertogroup', 'cognito-idp:adminsetuserpassword',
  'logs:putsubscriptionfilter', 'logs:putresourcepolicy', 'logs:putdestination', 'logs:putdestinationpolicy', 'logs:createexporttask',
  'logs:putdataprotectionpolicy', 'logs:putaccountpolicy', 'logs:associatekmskey', 'logs:createdelivery',
  'logs:putdeliverydestination', 'logs:putdeliverydestinationpolicy', 'logs:putdeliverysource',
  'sns:addpermission', 'sns:settopicattributes', 'sns:subscribe', 'sns:putdataprotectionpolicy', 'sns:createtopic',
  'sqs:addpermission', 'sqs:setqueueattributes',
  'kms:putkeypolicy', 'kms:creategrant',
  'events:putpermission', 'events:puttargets',
  'secretsmanager:putresourcepolicy', 'ecr:setrepositorypolicy',
  'cloudfront:updatedistribution', 'cloudfront:createdistribution', 'cloudfront:updatedistributionwithstagingconfig',
  'cloudfront:associatealias', 'cloudfront:updateoriginaccesscontrol',
  'ssm:putresourcepolicy', 'ssm:modifydocumentpermission',
  'apigateway:updaterestapipolicy', 'apigateway:patch', 'apigateway:post', 'apigateway:put',
]);

/** Name of the one permissions boundary every ordinary role must carry (exact ARN, see boundaryArnViolation). */
export const PERMISSIONS_BOUNDARY_NAME = 'OpenReceptionClaudeBoundary';

/** Service principals a role in the dev assembly may trust. Everything else (accounts, roles, `*`, federation) is denied. */
const REVIEWED_TRUST_SERVICES = new Set(['lambda.amazonaws.com']);

/** Services whose actions change identity, trust or stacks. Candidate IAM never gets them on a pattern. */
const CONTROL_PLANE_SERVICES = Object.freeze(['iam', 'sts', 'cloudformation', 'organizations', 'account']);

/** Cloud-assembly artifact types the broker understands. A nested assembly (`cdk:cloud-assembly`) is not reviewed. */
const REVIEWED_ARTIFACT_TYPES = new Set([
  'aws:cloudformation:stack',
  'cdk:asset-manifest',
  'cdk:tree',
  'cdk:feature-flag-report',
]);

const APPROVED_FUNCTION_URLS = Object.freeze({
  ServerFnFunctionUrlFFF9E3E1: { authType: 'NONE', functionLogicalId: 'ServerFn4F3A536E' },
  ImageFnFunctionUrlBBD47D3E: { authType: 'AWS_IAM', functionLogicalId: 'ImageFnCD541B83' },
});

const APPROVED_PUBLIC_PERMISSIONS = Object.freeze({
  ServerFninvokefunctionurl715820CF: 'ServerFn4F3A536E',
  ServerFninvokefunctionA3A7399A: 'ServerFn4F3A536E',
});

/**
 * The exact reviewed shape of each public (`Principal: "*"`) permission, besides its target.
 * Anything else (another action such as `lambda:*` / `GetFunction`, or dropping the Function URL
 * binding) would open direct public invocation or read access.
 */
const APPROVED_PUBLIC_PERMISSION_SHAPES = Object.freeze({
  ServerFninvokefunctionurl715820CF: Object.freeze({ Action: 'lambda:InvokeFunctionUrl', FunctionUrlAuthType: 'NONE' }),
  ServerFninvokefunctionA3A7399A: Object.freeze({ Action: 'lambda:InvokeFunction', InvokedViaFunctionUrl: true }),
});

/** The only actions a Lambda::Permission may grant. */
const REVIEWED_LAMBDA_PERMISSION_ACTIONS = new Set(['lambda:InvokeFunction', 'lambda:InvokeFunctionUrl']);

/**
 * Top-level properties reviewed for types whose other properties can send data or authority to
 * another account or principal (replication, notifications, resource policies, triggers, DLQs,
 * KMS keys, VPC / file-system attachment ...). Anything not listed is PROPERTY_NOT_REVIEWED: a new
 * property is a policy change, not a candidate choice. Derived from the real dev assembly.
 */
const REVIEWED_PROPERTIES = Object.freeze({
  'AWS::S3::Bucket': new Set(['BucketEncryption', 'LifecycleConfiguration', 'PublicAccessBlockConfiguration', 'Tags', 'VersioningConfiguration', 'OwnershipControls', 'CorsConfiguration']),
  'AWS::DynamoDB::Table': new Set([
    'AttributeDefinitions', 'BillingMode', 'DeletionProtectionEnabled', 'GlobalSecondaryIndexes', 'KeySchema', 'LocalSecondaryIndexes',
    'PointInTimeRecoverySpecification', 'SSESpecification', 'Tags', 'TimeToLiveSpecification', 'TableName', 'ProvisionedThroughput',
  ]),
  'AWS::Cognito::UserPool': new Set([
    'AccountRecoverySetting', 'AdminCreateUserConfig', 'AliasAttributes', 'AutoVerifiedAttributes', 'EmailVerificationMessage',
    'EmailVerificationSubject', 'Policies', 'SmsVerificationMessage', 'UserPoolTags', 'VerificationMessageTemplate', 'UserPoolName',
    'DeletionProtection', 'MfaConfiguration', 'EnabledMfas', 'UsernameAttributes', 'UsernameConfiguration', 'Schema',
  ]),
  'AWS::Lambda::Function': new Set([
    'Architectures', 'Code', 'Description', 'Environment', 'Handler', 'Layers', 'LoggingConfig', 'MemorySize',
    'ReservedConcurrentExecutions', 'Role', 'Runtime', 'Tags', 'Timeout', 'EphemeralStorage',
  ]),
  'AWS::SNS::Topic': new Set(['DisplayName', 'Tags', 'TopicName']),
  // No KmsKeyId (a foreign key holds the logs hostage) and no DataProtectionPolicy (its audit
  // findings go to a destination outside this review).
  'AWS::Logs::LogGroup': new Set(['LogGroupName', 'LogGroupClass', 'RetentionInDays', 'Tags']),
  // No RedrivePolicy / DeliveryPolicy / FilterPolicy scope games: the endpoint check below is the review.
  'AWS::SNS::Subscription': new Set(['Endpoint', 'Protocol', 'TopicArn']),
});

/**
 * CloudFront keys reviewed at each level (from the real dev assembly). Edge functions, WAF,
 * real-time logs, field-level encryption, aliases / certificates are new code paths or data
 * destinations and are not reviewed.
 */
const REVIEWED_DISTRIBUTION_KEYS = Object.freeze({
  config: new Set(['CacheBehaviors', 'Comment', 'CustomErrorResponses', 'DefaultCacheBehavior', 'Enabled', 'HttpVersion', 'IPV6Enabled', 'Origins', 'PriceClass']),
  behavior: new Set(['AllowedMethods', 'CachePolicyId', 'Compress', 'OriginRequestPolicyId', 'PathPattern', 'ResponseHeadersPolicyId', 'TargetOriginId', 'ViewerProtocolPolicy']),
  origin: new Set(['CustomOriginConfig', 'DomainName', 'Id', 'OriginAccessControlId', 'OriginCustomHeaders', 'OriginPath', 'S3OriginConfig']),
});

/**
 * ADR 0009 dedicated CDK bootstrap qualifier. The armed broker deploys through the ADR 0009 role
 * chain, which may only assume `cdk-orcloud01-*` roles; the shared default bootstrap is denied.
 */
export const BOOTSTRAP_QUALIFIER = 'orcloud01';

/** Stack artifact properties the CDK CLI honours that this policy reviews. Anything else is denied. */
const REVIEWED_STACK_ARTIFACT_PROPERTIES = new Set([
  'templateFile', 'stackName', 'terminationProtection', 'validateOnSynth', 'tags', 'assumeRoleArn',
  'cloudFormationExecutionRoleArn', 'lookupRole', 'requiresBootstrapStackVersion',
  'bootstrapStackVersionSsmParameter', 'stackTemplateAssetObjectUrl', 'additionalDependencies',
]);
const REVIEWED_ASSET_ARTIFACT_PROPERTIES = new Set(['file', 'requiresBootstrapStackVersion', 'bootstrapStackVersionSsmParameter']);

/** Top-level keys of a manifest artifact. */
const REVIEWED_ARTIFACT_KEYS = new Set(['type', 'environment', 'properties', 'dependencies', 'metadata', 'displayName', 'additionalMetadataFile']);

/** Stack tag keys the app sets, and the tags whose values are pinned. */
const REVIEWED_STACK_TAG_KEYS = new Set(['Component', 'Environment', 'ManagedBy', 'Owner', 'Project']);
const PINNED_STACK_TAGS = Object.freeze({ Project: 'open-reception', Environment: 'dev', ManagedBy: 'cdk' });

/**
 * Reviewed values of properties that send users or data to an address: an OAuth client's redirect
 * targets. A change is a policy change. (The current value is CDK's default when OAuth flows are
 * enabled without explicit URLs; recorded as a product finding.)
 */
const REVIEWED_USER_POOL_CLIENT_URLS = Object.freeze({
  CallbackURLs: ['https://example.com'],
  LogoutURLs: undefined,
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

/*
 * Candidate IAM that could reach the broker stack's ledger table - exact, prefix, wildcard, or
 * built by an intrinsic - would let a deployed workload forge overrides or reset counters
 * (#1153, Foundation S6a), so it is rejected before mutation.
 */

/** IAM resource glob: `*` any run of characters (including `/`), `?` one character, case-sensitive. */
function iamGlobMatches(pattern, value) {
  const re = new RegExp(
    `^${[...pattern].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`,
  );
  return re.test(value);
}

/**
 * Could this action pattern include any DynamoDB action? The service part (before the first `:`,
 * or the whole pattern) is glob-matched against `dynamodb`, so `*`, `*:UpdateItem`, `dynamo*`,
 * `dynamod?:PutItem` and `dynamodb:*` all count. A non-string action is opaque and counts too.
 */
function actionMayIncludeDynamo(action) {
  if (typeof action !== 'string') return true;
  const a = action.toLowerCase();
  const service = a.includes(':') ? a.slice(0, a.indexOf(':')) : a;
  return iamGlobMatches(service, 'dynamodb');
}

/**
 * Reference attributes whose value the SERVICE fixes (an ARN / name of a resource this template
 * declares). Custom resources are excluded: their Ref / GetAtt values are whatever the provider
 * Lambda returns, which candidate code can control.
 */
const SERVICE_FIXED_REFERENCES = Object.freeze({
  'AWS::DynamoDB::Table': ['Ref', 'Arn', 'StreamArn'],
  'AWS::S3::Bucket': ['Arn'],
  'AWS::Lambda::Function': ['Arn'],
  'AWS::Logs::LogGroup': ['Arn'],
  'AWS::IAM::Role': ['Arn'],
  'AWS::SNS::Topic': ['Ref'],
  'AWS::SQS::Queue': ['Arn'],
  'AWS::Cognito::UserPool': ['Arn'],
});

const serviceFixed = (templateResources, logicalId, attribute) => {
  const target = typeof logicalId === 'string' && Object.hasOwn(templateResources, logicalId) ? templateResources[logicalId] : null;
  const allowed = isRecord(target) && typeof target.Type === 'string' ? SERVICE_FIXED_REFERENCES[target.Type] : undefined;
  return Array.isArray(allowed) && allowed.includes(attribute);
};

/**
 * A resource reference whose target is fully determined by THIS template and the service:
 * `GetAtt X.<attr>` / `Ref X` of a declared resource of a reviewed type (see
 * SERVICE_FIXED_REFERENCES), or `Fn::Join('', [that, '/literal-suffix'])` (CDK's index / stream
 * grants). Anything else (parameters, mappings, imports, Sub, Select, dynamic references,
 * custom resources ...) cannot be resolved by this policy and fails closed.
 */
function isLocalResourceRef(value, templateResources) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  if (keys[0] === 'Ref') return serviceFixed(templateResources, value.Ref, 'Ref');
  if (keys[0] === 'Fn::GetAtt') {
    const g = value['Fn::GetAtt'];
    return Array.isArray(g) && g.length === 2 && serviceFixed(templateResources, g[0], g[1]);
  }
  if (keys[0] === 'Fn::Join') {
    const j = value['Fn::Join'];
    if (!Array.isArray(j) || j.length !== 2 || j[0] !== '' || !Array.isArray(j[1]) || j[1].length !== 2) return false;
    const [head, tail] = j[1];
    return isLocalResourceRef(head, templateResources) && !isRecord(head['Fn::Join'] ?? null) && typeof tail === 'string' && /^\/[A-Za-z0-9_.*/-]*$/.test(tail);
  }
  return false;
}

/**
 * Resource-part prefix of every ledger table ARN and each of its sub-resources (stream, index,
 * backup, export). CloudFormation names the table `<stack name>-<logical id><hash>-<random>`.
 */
const SPARSE_LEDGER_RESOURCE_PREFIX = 'table/OpenReception-DevDeployBroker-';

/**
 * Can IAM glob `pattern` (`*` = any run, `?` = one character) match SOME string that starts with
 * `prefix`? Walk the pattern against the prefix: a literal must equal, `?` takes any character,
 * and the first `*` can absorb the rest of the prefix (after it, the remainder of the string is
 * free to satisfy the rest of the pattern). Running out of pattern before the prefix ends means
 * no match.
 */
function globMayMatchStringWithPrefix(pattern, prefix) {
  for (let i = 0; i < prefix.length; i += 1) {
    const p = pattern[i];
    if (p === '*') return true;
    if (p === undefined || (p !== '?' && p !== prefix[i])) return false;
  }
  return true;
}

function reachesSparseLedger(resource, templateResources) {
  if (typeof resource !== 'string') return !isLocalResourceRef(resource, templateResources);
  if (resource.includes('{{resolve:')) return true;
  // IAM policy variables (`${aws:PrincipalTag/x}` ...) are substituted per request, and a
  // candidate controls its own role's tags: the resource is not determined by the template.
  if (resource.includes('${')) return true;
  if (/DevDeployBroker|SparseDeployLedger/i.test(resource)) return true;
  // Match segment by segment: partition and service are glob-matched, region / account are the
  // assembly's own and cannot rule the ledger out (any value counts as matching), and the
  // resource part (everything after the fifth `:`) must not be able to match anything starting
  // with the ledger prefix - this covers globs on the real (deterministic) name hash and mangled
  // `table/` literals. Real IAM lets a segment-final `*` expand across `:`; that only matters for
  // ARNs with more than five colons, and every ledger ARN has exactly five because the table has
  // no stream (pinned in dev-deploy-broker-invariants.test.ts).
  const parts = resource.split(':');
  if (parts.length < 6 || parts[0] !== 'arn') return /[*?]/.test(resource);
  const [, partition, service] = parts;
  if (!iamGlobMatches(partition.toLowerCase(), 'aws') || !iamGlobMatches(service.toLowerCase(), 'dynamodb')) return false;
  return globMayMatchStringWithPrefix(parts.slice(5).join(':'), SPARSE_LEDGER_RESOURCE_PREFIX);
}

/** Could this action pattern (IAM glob) match one of `actions` (lowercase)? Non-strings are opaque and match. */
function actionPatternMayMatch(pattern, actions) {
  if (typeof pattern !== 'string') return true;
  const p = pattern.toLowerCase();
  return actions.some((a) => iamGlobMatches(p, a));
}

/** A pattern that can only name a read of `service` (its action part starts with a literal get / list / describe). */
function isReadOnlyPattern(pattern, service) {
  if (typeof pattern !== 'string') return false;
  const p = pattern.toLowerCase();
  if (!p.startsWith(`${service}:`)) return false;
  const name = p.slice(service.length + 1);
  return ['get', 'list', 'describe'].some((verb) => name.startsWith(verb) && !/[*?]/.test(name.slice(0, verb.length)));
}

/**
 * Bootstrap state the broker's deploy relies on: the `cdk-*` asset buckets (the broker uploads the
 * reviewed template there, and publishing skips an object that already exists) and the
 * `/cdk-bootstrap/*` SSM parameters. Candidate IAM may read the bucket (CDK's BucketDeployment
 * does) but never write it or touch the parameters.
 */
const BOOTSTRAP_TARGETS = Object.freeze([
  { service: 's3', prefix: 'cdk-' },
  { service: 'ssm', prefix: 'parameter/cdk-bootstrap/' },
  // Cross-region export values: the reader resolves them when the consumer stack deploys, so a
  // runtime write would change a value the review never saw. Only the pinned writer (a reviewed
  // carve-out) may write them.
  { service: 'ssm', prefix: 'parameter/cdk/exports/' },
]);

function resourceMayMatch(resource, service, prefix, templateResources, targetAccount) {
  const resolved = typeof resource === 'string' ? resource : resolvePseudoArn(resource, targetAccount);
  if (resolved === null) return !isLocalResourceRef(resource, templateResources);
  if (resolved.includes('{{resolve:') || resolved.includes('${')) return true;
  const parts = resolved.split(':');
  if (parts.length < 6 || parts[0] !== 'arn') return /[*?]/.test(resolved);
  if (!iamGlobMatches(parts[1].toLowerCase(), 'aws') || !iamGlobMatches(parts[2].toLowerCase(), service)) return false;
  return globMayMatchStringWithPrefix(parts.slice(5).join(':'), prefix);
}

function statementReachesBootstrap(statement, templateResources, targetAccount, exportWriter = false) {
  const actions = asArray(statement.Action);
  for (const { service, prefix } of BOOTSTRAP_TARGETS) {
    if (exportWriter && prefix === 'parameter/cdk/exports/') continue;
    const writes = statement.NotAction !== undefined || actions.some((a) => actionMayMatchService(a, [service]) && !isReadOnlyPattern(a, service));
    if (writes && asArray(statement.Resource).some((r) => resourceMayMatch(r, service, prefix, templateResources, targetAccount))) return true;
  }
  return false;
}

/**
 * Digest of an asset directory: SHA-256 over `<relative path>\0<sha256 of the file>\n` for every
 * file, sorted by path. Only plain files and directories are accepted (a symlink could point the
 * packaged code elsewhere); anything else returns null.
 */
export function treeDigest(dir) {
  const lines = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) lines.push(`${path.relative(dir, full)}\u0000${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}\n`);
      else throw new Error(`not a plain file: ${full}`);
    }
  };
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null;
    walk(dir);
  } catch {
    return null;
  }
  lines.sort();
  return createHash('sha256').update(lines.join('')).digest('hex');
}

/** Only statements that can grant a DynamoDB action are relevant to the ledger. */
function statementReachesSparseLedger(statement, templateResources) {
  const actions = asArray(statement.Action);
  const dynamoCapable = statement.NotAction !== undefined || actions.some((a) => typeof a !== 'string' || actionMayIncludeDynamo(a));
  if (!dynamoCapable) return false;
  return asArray(statement.Resource).some((r) => reachesSparseLedger(r, templateResources));
}

/** AWS-managed policies a candidate role may attach. Everything else is unreviewed authority. */
const REVIEWED_MANAGED_POLICIES = new Set([
  'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
]);

/** Resolve the CDK shapes of an AWS-managed policy ARN (literal, Sub / Join with AWS::Partition). */
function resolveManagedPolicyArn(value) {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  if (typeof value['Fn::Sub'] === 'string') return value['Fn::Sub'].replaceAll('${AWS::Partition}', 'aws');
  const j = value['Fn::Join'];
  if (Array.isArray(j) && j.length === 2 && j[0] === '' && Array.isArray(j[1])) {
    const parts = j[1].map((p) => (typeof p === 'string' ? p : isRecord(p) && p.Ref === 'AWS::Partition' ? 'aws' : null));
    return parts.includes(null) ? null : parts.join('');
  }
  return null;
}

/** A statement this policy cannot evaluate: not a plain record, intrinsic keys, or a non-literal Effect. */
function isOpaqueStatement(statement) {
  if (!isRecord(statement)) return true;
  if (Object.keys(statement).some((k) => k.startsWith('Fn::'))) return true;
  return statement.Effect !== 'Allow' && statement.Effect !== 'Deny';
}

/**
 * Resolve the CDK shapes of an ARN built from pseudo parameters: a literal, `Fn::Sub` using only
 * `${AWS::Partition}` / `${AWS::AccountId}`, or `Fn::Join('', [...])` of literals and those two
 * `Ref`s. The stack environment is pinned to the target account (STACK_ENVIRONMENT_MISMATCH), so
 * `AWS::AccountId` is that account. Anything else (other parameters, imports, conditions) is
 * unresolvable and returns null, which callers treat as a violation.
 */
function resolvePseudoArn(value, targetAccount) {
  if (typeof value === 'string') return value;
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  if (typeof value['Fn::Sub'] === 'string') {
    const out = value['Fn::Sub'].replaceAll('${AWS::Partition}', 'aws').replaceAll('${AWS::AccountId}', targetAccount);
    return out.includes('${') ? null : out;
  }
  const j = value['Fn::Join'];
  if (Array.isArray(j) && j.length === 2 && j[0] === '' && Array.isArray(j[1])) {
    const parts = j[1].map((p) => {
      if (typeof p === 'string') return p;
      if (isRecord(p) && Object.keys(p).length === 1 && p.Ref === 'AWS::Partition') return 'aws';
      if (isRecord(p) && Object.keys(p).length === 1 && p.Ref === 'AWS::AccountId') return targetAccount;
      return null;
    });
    return parts.includes(null) ? null : parts.join('');
  }
  return null;
}

/** The boundary must be exactly this account's `OpenReceptionClaudeBoundary`, not any string containing the name. */
function boundaryIsExact(value, targetAccount) {
  return resolvePseudoArn(value, targetAccount) === `arn:aws:iam::${targetAccount}:policy/${PERMISSIONS_BOUNDARY_NAME}`;
}

const localOfType = (templateResources, logicalId, types) =>
  typeof logicalId === 'string' &&
  Object.hasOwn(templateResources, logicalId) &&
  isRecord(templateResources[logicalId]) &&
  types.includes(templateResources[logicalId].Type);

/** `{ Ref: X }` where X is declared in this template with one of `types`. */
const isLocalRef = (value, templateResources, types) =>
  isRecord(value) && Object.keys(value).length === 1 && localOfType(templateResources, value.Ref, types);

/** `{ Fn::GetAtt: [X, attribute] }` where X is declared in this template with one of `types`. */
function isLocalGetAtt(value, templateResources, types, attribute) {
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  const g = value['Fn::GetAtt'];
  return Array.isArray(g) && g.length === 2 && g[1] === attribute && localOfType(templateResources, g[0], types);
}

/** Can the service part of this action pattern match one of `services` (glob, case-insensitive)? */
function actionMayMatchService(action, services) {
  if (typeof action !== 'string') return true;
  const a = action.toLowerCase();
  const service = a.includes(':') ? a.slice(0, a.indexOf(':')) : a;
  return services.some((svc) => iamGlobMatches(service, svc));
}

/**
 * Role trust policy: only reviewed AWS service principals may assume a candidate role, with
 * `sts:AssumeRole`. An account / role / `*` / federated principal is cross-account or admin trust.
 */
function trustPolicyViolations(stackName, logicalId, document) {
  if (!isRecord(document) || !Array.isArray(document.Statement)) {
    return [violation('IAM_TRUST_NOT_REVIEWED', stackName, logicalId, 'AssumeRolePolicyDocument.Statement is not a concrete array')];
  }
  const out = [];
  for (const statement of document.Statement) {
    if (isOpaqueStatement(statement)) {
      out.push(violation('IAM_TRUST_NOT_REVIEWED', stackName, logicalId, 'trust statement is not a plain object with a literal Effect'));
      continue;
    }
    if (statement.Effect !== 'Allow') continue;
    const principal = statement.Principal;
    const services = isRecord(principal) && Object.keys(principal).length === 1 ? asArray(principal.Service) : [];
    const principalOk =
      statement.NotPrincipal === undefined &&
      services.length > 0 &&
      services.every((svc) => typeof svc === 'string' && REVIEWED_TRUST_SERVICES.has(svc));
    const actions = asArray(statement.Action);
    const actionOk =
      statement.NotAction === undefined &&
      actions.length > 0 &&
      actions.every((a) => typeof a === 'string' && a.toLowerCase() === 'sts:assumerole');
    if (!principalOk || !actionOk) {
      out.push(violation('IAM_TRUST_NOT_REVIEWED', stackName, logicalId, `role may be assumed by something other than ${[...REVIEWED_TRUST_SERVICES].join(', ')} via sts:AssumeRole: ${JSON.stringify(principal ?? statement.NotPrincipal ?? null)}`));
    }
  }
  return out;
}

const reviewedCarveOutResource = (targetAccount) =>
  new RegExp(`^arn:aws:ssm:[a-z0-9-]+:${targetAccount}:parameter/cdk/exports/[A-Za-z0-9/_.*-]*$`);

/** Does this role still have exactly the reviewed CDK carve-out shape? (See REVIEWED_CARVE_OUT_ROLES.) */
function carveOutShapeHolds(logicalId, props, attachedPolicyCount, targetAccount) {
  const reviewedActions = Object.hasOwn(REVIEWED_CARVE_OUT_ROLES, logicalId) ? REVIEWED_CARVE_OUT_ROLES[logicalId] : undefined;
  if (!Array.isArray(reviewedActions) || attachedPolicyCount > 0) return false;
  if (trustPolicyViolations('', logicalId, props.AssumeRolePolicyDocument).length > 0) return false;
  const managed = asArray(props.ManagedPolicyArns);
  if (managed.length !== 1 || resolveManagedPolicyArn(managed[0]) !== 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole') return false;
  const resourcePattern = reviewedCarveOutResource(targetAccount);
  for (const policy of asArray(props.Policies)) {
    const statements = isRecord(policy) && isRecord(policy.PolicyDocument) ? policy.PolicyDocument.Statement : undefined;
    if (!Array.isArray(statements)) return false;
    for (const statement of statements) {
      if (isOpaqueStatement(statement) || statement.Effect !== 'Allow') return false;
      if (statement.NotAction !== undefined || statement.NotResource !== undefined || statement.Condition !== undefined) return false;
      const actions = asArray(statement.Action);
      if (actions.length === 0 || !actions.every((a) => typeof a === 'string' && reviewedActions.includes(a.toLowerCase()))) return false;
      const resources = asArray(statement.Resource);
      if (resources.length === 0 || !resources.every((r) => resourcePattern.test(resolvePseudoArn(r, targetAccount) ?? ''))) return false;
    }
  }
  return true;
}

/**
 * Resource-based policy (bucket / topic): an Allow may name only a service principal restricted
 * by a source condition, or a role declared in this template. `*`, `{AWS: "*"}`, an account id or
 * any other ARN would open the resource to the public or to another account.
 */
/**
 * Resolve a condition / SourceArn value to a string with every template-local reference replaced
 * by `{local}` (the service fixes it, in this stack's account) and pseudo parameters substituted.
 * Returns null when the value depends on anything else (parameters, imports, conditions).
 */
function resolveBound(value, templateResources, targetAccount) {
  if (typeof value === 'string') return value;
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  if (typeof value.Ref === 'string') {
    if (value.Ref === 'AWS::Partition') return 'aws';
    if (value.Ref === 'AWS::AccountId') return targetAccount;
    if (value.Ref === 'AWS::Region') return '{region}';
    return serviceFixed(templateResources, value.Ref, 'Ref') || localOfType(templateResources, value.Ref, ['AWS::CloudFront::Distribution'])
      ? '{local}'
      : null;
  }
  const g = value['Fn::GetAtt'];
  if (Array.isArray(g)) return g.length === 2 && serviceFixed(templateResources, g[0], g[1]) ? '{local}' : null;
  const j = value['Fn::Join'];
  if (Array.isArray(j) && j.length === 2 && typeof j[0] === 'string' && Array.isArray(j[1])) {
    const parts = j[1].map((p) => resolveBound(p, templateResources, targetAccount));
    return parts.includes(null) ? null : parts.join(j[0]);
  }
  return null;
}

/** Account field of a resolved ARN: the target for a local reference, '' for account-less ARNs (S3), null if not an ARN. */
function arnAccount(resolved, targetAccount) {
  // `{local}` must be the whole value or be followed by `/` or `:`; `{local}-x` is another name
  // (e.g. a look-alike bucket anyone can register) and says nothing about its account.
  if (resolved === '{local}' || resolved.startsWith('{local}/') || resolved.startsWith('{local}:')) return targetAccount;
  if (resolved.includes('{local}') && !resolved.startsWith('arn:')) return null;
  if (!resolved.startsWith('arn:')) return null;
  const parts = resolved.split(':');
  return parts.length >= 6 ? parts[4] : null;
}

/**
 * Does this Condition pin the calling service to this account? Only an exact `StringEquals` /
 * `ArnEquals` counts (no `Not`, `Like`, `IfExists` or `Null` form), on `aws:SourceArn` whose every
 * value is a wildcard-free ARN in the target account, or on `aws:SourceAccount` whose every value
 * is the target account.
 */
function conditionBindsSource(condition, templateResources, targetAccount) {
  if (!isRecord(condition)) return false;
  let bound = false;
  for (const [operator, block] of Object.entries(condition)) {
    if (!['stringequals', 'arnequals'].includes(operator.toLowerCase()) || !isRecord(block)) continue;
    for (const [key, raw] of Object.entries(block)) {
      const values = asArray(raw).map((v) => resolveBound(v, templateResources, targetAccount));
      if (values.length === 0 || values.some((v) => v === null || /[*?]/.test(v))) continue;
      const k = key.toLowerCase();
      if (k === 'aws:sourcearn' && values.every((v) => arnAccount(v, targetAccount) === targetAccount)) bound = true;
      if (k === 'aws:sourceaccount' && values.every((v) => v === targetAccount)) bound = true;
    }
  }
  return bound;
}

function resourcePolicyViolations(stackName, logicalId, document, templateResources, targetAccount) {
  if (!isRecord(document) || !Array.isArray(document.Statement)) {
    return [violation('IAM_POLICY_OPAQUE', stackName, logicalId, 'PolicyDocument.Statement is not a concrete array')];
  }
  const out = [];
  for (const statement of document.Statement) {
    if (isOpaqueStatement(statement)) {
      out.push(violation('IAM_POLICY_OPAQUE', stackName, logicalId, 'statement is not a plain object with a literal Effect (e.g. Fn::If)'));
      continue;
    }
    if (statement.Effect !== 'Allow') continue;
    const principal = statement.Principal;
    const sourceBound = conditionBindsSource(statement.Condition, templateResources, targetAccount);
    let ok = statement.NotPrincipal === undefined && isRecord(principal) && Object.keys(principal).length > 0;
    if (ok) {
      for (const [kind, value] of Object.entries(principal)) {
        const values = asArray(value);
        if (kind === 'Service') {
          ok &&= sourceBound && values.length > 0 && values.every((svc) => typeof svc === 'string' && /^[a-z0-9.-]+\.amazonaws\.com$/.test(svc));
        } else if (kind === 'AWS') {
          ok &&= values.length > 0 && values.every((v) => isLocalGetAtt(v, templateResources, ['AWS::IAM::Role'], 'Arn'));
        } else {
          ok = false;
        }
      }
    }
    if (!ok) {
      out.push(violation('RESOURCE_POLICY_PRINCIPAL_NOT_REVIEWED', stackName, logicalId, `Allow to a public, foreign or source-unbound principal: ${JSON.stringify(principal ?? statement.NotPrincipal ?? null)}`));
    }
    const sharing = statement.NotAction !== undefined ? ['NotAction'] : asArray(statement.Action).filter((a) => actionPatternMayMatch(a, RESOURCE_SHARING_ACTIONS));
    if (sharing.length > 0 && !isAutoDeleteGrant(statement, templateResources)) {
      out.push(violation('RESOURCE_POLICY_SHARING_ACTION', stackName, logicalId, `resource policy lets a principal change who can reach the resource: ${sharing.map((a) => JSON.stringify(a)).join(',')}`));
    }
  }
  return out;
}

/** CDK's auto-delete grant, exactly (see AUTO_DELETE_GRANT_ACTIONS); the provider's code is pinned. */
function isAutoDeleteGrant(statement, templateResources) {
  const role = PINNED_PROVIDER_FUNCTIONS.CustomS3AutoDeleteObjectsCustomResourceProviderHandler9D90184F.role;
  const principal = statement.Principal;
  return (
    statement.Condition === undefined &&
    JSON.stringify(asArray(statement.Action)) === JSON.stringify(AUTO_DELETE_GRANT_ACTIONS) &&
    isRecord(principal) &&
    Object.keys(principal).length === 1 &&
    JSON.stringify(principal.AWS) === JSON.stringify({ 'Fn::GetAtt': [role, 'Arn'] }) &&
    localOfType(templateResources, role, ['AWS::IAM::Role']) &&
    asArray(statement.Resource).length > 0 &&
    asArray(statement.Resource).every((r) => isLocalResourceRef(r, templateResources))
  );
}

/**
 * Every 12-digit account id that appears as a delimited token (ARN account field, bucket /
 * repository name segment, destination key) must be the target account.
 */
function foreignAccounts(value, targetAccount, found = new Set()) {
  const scan = (text) => {
    // Delimited by non-alphanumerics, so a digit run inside a hex asset hash is not an account.
    for (const m of text.matchAll(/(?<![0-9A-Za-z])([0-9]{12})(?![0-9A-Za-z])/g)) if (m[1] !== targetAccount) found.add(m[1]);
  };
  if (typeof value === 'string') scan(value);
  else if (Array.isArray(value)) value.forEach((v) => foreignAccounts(v, targetAccount, found));
  else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      scan(k);
      foreignAccounts(v, targetAccount, found);
    }
  }
  return found;
}

/** An `Fn::Transform` anywhere expands a macro after this review. */
function containsTransform(value) {
  if (Array.isArray(value)) return value.some(containsTransform);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([k, v]) => k === 'Fn::Transform' || containsTransform(v));
}

function policyDocumentViolations(stackName, logicalId, document, templateResources, targetAccount, { exportWriter = false } = {}) {
  const out = [];
  if (!isRecord(document) || !Array.isArray(document.Statement)) {
    out.push(violation('IAM_POLICY_OPAQUE', stackName, logicalId, 'PolicyDocument.Statement is not a concrete array'));
    return out;
  }
  for (const statement of document.Statement) {
    if (isOpaqueStatement(statement)) {
      out.push(violation('IAM_POLICY_OPAQUE', stackName, logicalId, 'statement is not a plain object with a literal Effect (e.g. Fn::If)'));
      continue;
    }
    if (statement.Effect !== 'Allow') continue;
    const actions = asArray(statement.Action).filter((x) => typeof x === 'string').map((x) => x.toLowerCase());
    const resources = asArray(statement.Resource);
    if (actions.includes('*') || actions.includes('iam:*') || actions.includes('sts:*') || actions.includes('kms:*')) {
      out.push(violation('IAM_ADMIN_OR_CONTROL_PLANE', stackName, logicalId, `broad control-plane action: ${actions.join(',')}`));
    }
    for (const action of actions) {
      if (actionPatternMayMatch(action, [...LOOP_CAPABLE_IAM_ACTIONS])) {
        out.push(violation('IAM_LOOP_CAPABLE_ACTION', stackName, logicalId, `runtime role may trigger work recursively: ${action}`));
      }
    }
    if (statement.NotResource !== undefined) {
      out.push(violation('IAM_NOT_RESOURCE', stackName, logicalId, 'Allow with NotResource grants everything except a list, including the sparse deploy ledger'));
    }
    if (statement.NotAction !== undefined) {
      out.push(violation('IAM_NOT_ACTION', stackName, logicalId, 'Allow with NotAction grants every action except a list, including control-plane actions'));
    }
    // iam / sts / cloudformation / organizations on any resource pattern (`arn:aws:iam::*:role/*`,
    // not only a bare `*`) is privilege escalation. The one reviewed shape is iam:PassRole of a
    // role declared in this template.
    const controlPlane = asArray(statement.Action).filter((a) => actionMayMatchService(a, CONTROL_PLANE_SERVICES));
    // Never a pinned provider / carve-out role: a runtime role could otherwise create its own
    // function running with that role's authority (outside the template review).
    const passLocalRoleOnly =
      controlPlane.every((a) => typeof a === 'string' && a.toLowerCase() === 'iam:passrole') &&
      resources.length > 0 &&
      resources.every(
        (r) =>
          isLocalGetAtt(r, templateResources, ['AWS::IAM::Role'], 'Arn') &&
          // (the carve-out roles are pinned provider roles too)
          !PINNED_PROVIDER_BY_ROLE.has(r['Fn::GetAtt'][0]),
      );
    if (controlPlane.length > 0 && !passLocalRoleOnly) {
      out.push(violation('IAM_CONTROL_PLANE_ACTION', stackName, logicalId, `identity / trust / stack action on a resource this template does not pin: ${controlPlane.map((a) => JSON.stringify(a)).join(',')}`));
    }
    if (statementReachesSparseLedger(statement, templateResources)) {
      out.push(violation('IAM_REACHES_SPARSE_LEDGER', stackName, logicalId, 'candidate IAM may reach the broker-only sparse deploy ledger'));
    }
    const sharing = statement.NotAction !== undefined ? ['NotAction'] : asArray(statement.Action).filter((a) => actionPatternMayMatch(a, RESOURCE_SHARING_ACTIONS));
    if (sharing.length > 0) {
      out.push(violation('IAM_RESOURCE_SHARING_ACTION', stackName, logicalId, `runtime role may change who can reach a resource or where its data goes: ${sharing.map((a) => JSON.stringify(a)).join(',')}`));
    }
    if (statementReachesBootstrap(statement, templateResources, targetAccount, exportWriter)) {
      out.push(violation('IAM_REACHES_BOOTSTRAP', stackName, logicalId, `candidate IAM may write the ${BOOTSTRAP_QUALIFIER} bootstrap asset bucket, its /cdk-bootstrap parameters or the /cdk/exports parameters`));
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

/**
 * Standalone AWS::IAM::Policy attachments per role logical id. A policy that names a role not
 * declared in this template (a literal existing-role name, a parameter, an import) is attaching
 * candidate authority to a role outside the review and is reported by evaluateResource.
 */
function policyAttachmentCounts(templateResources) {
  const counts = new Map();
  for (const resource of Object.values(templateResources)) {
    if (!isRecord(resource) || resource.Type !== 'AWS::IAM::Policy' || !isRecord(resource.Properties)) continue;
    for (const role of asArray(resource.Properties.Roles)) {
      if (isRecord(role) && typeof role.Ref === 'string') counts.set(role.Ref, (counts.get(role.Ref) ?? 0) + 1);
    }
  }
  return counts;
}

function evaluateResource(stackName, logicalId, resource, templateResources = {}, context = {}) {
  const { targetAccount = '', attachedPolicies = new Map(), region = '', codeDigest = () => null } = context;
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

  if (Object.hasOwn(REVIEWED_PROPERTIES, type)) {
    for (const key of Object.keys(props)) {
      if (!REVIEWED_PROPERTIES[type].has(key)) {
        out.push(violation('PROPERTY_NOT_REVIEWED', stackName, logicalId, `${type}.${key} is not a reviewed property (it may send data or authority elsewhere)`));
      }
    }
  }

  if (type === 'AWS::IAM::Role') {
    out.push(...trustPolicyViolations(stackName, logicalId, props.AssumeRolePolicyDocument));
    const carveOut = carveOutShapeHolds(logicalId, props, attachedPolicies.get(logicalId) ?? 0, targetAccount);
    if (!carveOut && !boundaryIsExact(props.PermissionsBoundary, targetAccount)) {
      out.push(violation('IAM_BOUNDARY_REQUIRED', stackName, logicalId, `role must carry exactly arn:aws:iam::${targetAccount}:policy/${PERMISSIONS_BOUNDARY_NAME}${Object.hasOwn(REVIEWED_CARVE_OUT_ROLES, logicalId) ? ' (carve-out id, but not the reviewed carve-out shape)' : ''}`));
    }
  }

  if (type === 'AWS::IAM::Policy') {
    out.push(...policyDocumentViolations(stackName, logicalId, props.PolicyDocument, templateResources, targetAccount));
    const attachedElsewhere =
      props.Users !== undefined ||
      props.Groups !== undefined ||
      !asArray(props.Roles).every((role) => isLocalRef(role, templateResources, ['AWS::IAM::Role']));
    if (attachedElsewhere) {
      out.push(violation('IAM_POLICY_ATTACHMENT_NOT_LOCAL', stackName, logicalId, 'policy attaches to a role / user / group this template does not declare'));
    }
  }

  // Managed policies are authority this file cannot inspect: only reviewed AWS-managed ones.
  if (type === 'AWS::IAM::Role' && props.ManagedPolicyArns !== undefined) {
    for (const arn of asArray(props.ManagedPolicyArns)) {
      const resolved = resolveManagedPolicyArn(arn);
      if (resolved === null || !REVIEWED_MANAGED_POLICIES.has(resolved)) {
        out.push(violation('IAM_MANAGED_POLICY_NOT_REVIEWED', stackName, logicalId, `managed policy outside the reviewed set: ${JSON.stringify(arn)}`));
      }
    }
  }

  // Role inline policies get the same review as standalone policies, including CDK carve-outs.
  if (type === 'AWS::IAM::Role' && props.Policies !== undefined) {
    for (const policy of asArray(props.Policies)) {
      // The two cross-region export carve-outs, in their exact reviewed shape, are the only roles
      // that write (or tag) /cdk/exports/ (their code and properties are pinned below).
      const exportWriter = Object.hasOwn(REVIEWED_CARVE_OUT_ROLES, logicalId) && carveOutShapeHolds(logicalId, props, attachedPolicies.get(logicalId) ?? 0, targetAccount);
      out.push(...policyDocumentViolations(stackName, logicalId, isRecord(policy) ? policy.PolicyDocument : undefined, templateResources, targetAccount, { exportWriter }));
    }
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

  // Encryption with a key this review cannot see (a foreign KMS key can be revoked to hold the
  // data hostage): only service-managed keys.
  if (type === 'AWS::DynamoDB::Table' && props.SSESpecification !== undefined) {
    const sse = props.SSESpecification;
    if (!isRecord(sse) || !Object.keys(sse).every((k) => k === 'SSEEnabled' || k === 'SSEType') || (sse.SSEType !== undefined && sse.SSEType !== 'KMS')) {
      out.push(violation('PROPERTY_NOT_REVIEWED', stackName, logicalId, 'SSESpecification may only enable service-managed encryption (no KMSMasterKeyId)'));
    }
  }
  if (type === 'AWS::S3::Bucket' && props.BucketEncryption !== undefined) {
    const rules = isRecord(props.BucketEncryption) ? props.BucketEncryption.ServerSideEncryptionConfiguration : undefined;
    const ok =
      Object.keys(props.BucketEncryption).every((k) => k === 'ServerSideEncryptionConfiguration') &&
      Array.isArray(rules) &&
      rules.length > 0 &&
      rules.every(
        (r) =>
          isRecord(r) &&
          Object.keys(r).every((k) => k === 'ServerSideEncryptionByDefault' || k === 'BucketKeyEnabled') &&
          isRecord(r.ServerSideEncryptionByDefault) &&
          Object.keys(r.ServerSideEncryptionByDefault).length === 1 &&
          r.ServerSideEncryptionByDefault.SSEAlgorithm === 'AES256',
      );
    if (!ok) out.push(violation('PROPERTY_NOT_REVIEWED', stackName, logicalId, 'BucketEncryption may only use S3-managed keys (AES256)'));
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

  if (type === 'AWS::SNS::Subscription') {
    // Notifications may only go to a function or queue declared here (no email / https / foreign ARN).
    const endpointLocal =
      isLocalGetAtt(props.Endpoint, templateResources, ['AWS::Lambda::Function', 'AWS::SQS::Queue'], 'Arn') ||
      isLocalRef(props.Endpoint, templateResources, ['AWS::Lambda::Function']);
    if (!['lambda', 'sqs'].includes(props.Protocol) || !endpointLocal || !isLocalRef(props.TopicArn, templateResources, ['AWS::SNS::Topic'])) {
      out.push(violation('SUBSCRIPTION_NOT_REVIEWED', stackName, logicalId, 'a subscription must connect a local topic to a local function or queue'));
    }
  }

  if (type === 'AWS::Cognito::UserPoolClient') {
    for (const [key, reviewed] of Object.entries(REVIEWED_USER_POOL_CLIENT_URLS)) {
      if (JSON.stringify(props[key]) !== JSON.stringify(reviewed)) {
        out.push(violation('PROPERTY_NOT_REVIEWED', stackName, logicalId, `${type}.${key} differs from the reviewed value`));
      }
    }
  }

  if (type === 'AWS::CloudFront::Distribution' && isRecord(props.DistributionConfig) && props.DistributionConfig.Logging !== undefined) {
    out.push(violation('PROPERTY_NOT_REVIEWED', stackName, logicalId, 'CloudFront access logging is not reviewed (it would send request logs to a bucket)'));
  }
  if (type === 'AWS::CloudFront::Distribution' && isRecord(props.DistributionConfig)) {
    const config = props.DistributionConfig;
    const unreviewed = (obj, keys, where) =>
      (isRecord(obj) ? Object.keys(obj) : ['(not an object)']).filter((k) => !keys.has(k)).map((k) => `${where}.${k}`);
    const found = [
      ...unreviewed(config, REVIEWED_DISTRIBUTION_KEYS.config, 'DistributionConfig'),
      ...unreviewed(config.DefaultCacheBehavior, REVIEWED_DISTRIBUTION_KEYS.behavior, 'DefaultCacheBehavior'),
      ...asArray(config.CacheBehaviors).flatMap((b, i) => unreviewed(b, REVIEWED_DISTRIBUTION_KEYS.behavior, `CacheBehaviors[${i}]`)),
      ...asArray(config.Origins).flatMap((o, i) => unreviewed(o, REVIEWED_DISTRIBUTION_KEYS.origin, `Origins[${i}]`)),
    ];
    if (!Array.isArray(config.Origins) || (config.CacheBehaviors !== undefined && !Array.isArray(config.CacheBehaviors))) found.push('Origins / CacheBehaviors must be arrays');
    if (found.length > 0) {
      out.push(violation('PROPERTY_NOT_REVIEWED', stackName, logicalId, `CloudFront keys not reviewed (edge code, WAF, logs, aliases ...): ${found.join(', ')}`));
    }
  }

  if (type === 'AWS::CloudWatch::Alarm') {
    for (const key of ['AlarmActions', 'OKActions', 'InsufficientDataActions']) {
      if (!asArray(props[key]).every((a) => isLocalRef(a, templateResources, ['AWS::SNS::Topic']))) {
        out.push(violation('ALARM_ACTION_NOT_REVIEWED', stackName, logicalId, `${key} may only notify a topic declared in this template`));
      }
    }
  }

  if (type === 'AWS::Lambda::Url') {
    const reviewed = Object.hasOwn(APPROVED_FUNCTION_URLS, logicalId) ? APPROVED_FUNCTION_URLS[logicalId] : undefined;
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
    const expected = Object.hasOwn(APPROVED_PUBLIC_PERMISSIONS, logicalId) ? APPROVED_PUBLIC_PERMISSIONS[logicalId] : undefined;
    if (!expected || !resolvesToLogicalId(props.FunctionName, expected)) {
      out.push(violation('PUBLIC_LAMBDA_PERMISSION_NOT_REVIEWED', stackName, logicalId, 'Principal:* is not one of the reviewed server Function URL permissions'));
    }
  }

  if (type === 'AWS::Lambda::Permission') {
    const localTarget =
      isLocalRef(props.FunctionName, templateResources, ['AWS::Lambda::Function']) ||
      isLocalGetAtt(props.FunctionName, templateResources, ['AWS::Lambda::Function'], 'Arn') ||
      isLocalGetAtt(props.FunctionName, templateResources, ['AWS::Lambda::Url'], 'FunctionArn');
    if (!localTarget) {
      out.push(violation('LAMBDA_PERMISSION_TARGET_NOT_LOCAL', stackName, logicalId, 'permission targets a function this template does not declare'));
    }
    // Beyond the reviewed public URL permissions, only an AWS service bound to a source may invoke.
    // An account id or ARN principal is a grant to another account.
    // The source must be a wildcard-free ARN in this account, or an account-less ARN (S3) together
    // with SourceAccount = this account. A foreign or wildcard source lets another account invoke.
    const servicePrincipal = typeof props.Principal === 'string' && /^[a-z0-9.-]+\.amazonaws\.com$/.test(props.Principal);
    const arn = props.SourceArn === undefined ? undefined : resolveBound(props.SourceArn, templateResources, targetAccount);
    const account = props.SourceAccount === undefined ? undefined : resolveBound(props.SourceAccount, templateResources, targetAccount);
    const arnFieldAccount = typeof arn === 'string' && !/[*?]/.test(arn) ? arnAccount(arn, targetAccount) : null;
    const arnOk = arn === undefined || arnFieldAccount === targetAccount || arnFieldAccount === '';
    const accountOk = account === undefined || account === targetAccount;
    const bound = arnFieldAccount === targetAccount || account === targetAccount;
    if (props.Principal !== '*' && !(servicePrincipal && arnOk && accountOk && bound)) {
      out.push(violation('LAMBDA_PERMISSION_PRINCIPAL_NOT_REVIEWED', stackName, logicalId, `invoke permission for a non-service, foreign or source-unbound principal: ${JSON.stringify(props.Principal)} / ${JSON.stringify(props.SourceArn ?? null)}`));
    }
    if (!REVIEWED_LAMBDA_PERMISSION_ACTIONS.has(props.Action)) {
      out.push(violation('LAMBDA_PERMISSION_ACTION_NOT_REVIEWED', stackName, logicalId, `permission grants ${JSON.stringify(props.Action)}`));
    }
    if (props.Principal === '*' && Object.hasOwn(APPROVED_PUBLIC_PERMISSION_SHAPES, logicalId)) {
      const shape = APPROVED_PUBLIC_PERMISSION_SHAPES[logicalId];
      const allowedKeys = new Set(['Action', 'FunctionName', 'Principal', ...Object.keys(shape)]);
      const shapeOk = Object.entries(shape).every(([k, v]) => props[k] === v) && Object.keys(props).every((k) => allowedKeys.has(k));
      if (!shapeOk) {
        out.push(violation('PUBLIC_LAMBDA_PERMISSION_NOT_REVIEWED', stackName, logicalId, 'reviewed public permission does not keep its reviewed action / Function URL binding'));
      }
    }
  }

  // A function runs as a role this template declares, never a literal / imported existing role,
  // and loads only layers this template declares (a foreign layer ARN injects code from elsewhere).
  if (type === 'AWS::Lambda::Function') {
    if (!isLocalGetAtt(props.Role, templateResources, ['AWS::IAM::Role'], 'Arn')) {
      out.push(violation('LAMBDA_ROLE_NOT_LOCAL', stackName, logicalId, `execution role is not a role declared in this template: ${JSON.stringify(props.Role)}`));
    }
    if (!asArray(props.Layers).every((layer) => isLocalRef(layer, templateResources, ['AWS::Lambda::LayerVersion']))) {
      out.push(violation('LAMBDA_LAYER_NOT_LOCAL', stackName, logicalId, 'layer is not declared in this template'));
    }
  }

  // A provider function whose role holds authority beyond the boundary / a resource policy runs
  // only the reviewed aws-cdk-lib handler (see PINNED_PROVIDER_FUNCTIONS).
  if (type === 'AWS::Lambda::Function') {
    const roleId = isRecord(props.Role) && Array.isArray(props.Role['Fn::GetAtt']) ? props.Role['Fn::GetAtt'][0] : undefined;
    const pinnedForRole = typeof roleId === 'string' ? PINNED_PROVIDER_BY_ROLE.get(roleId) : undefined;
    const pinned = Object.hasOwn(PINNED_PROVIDER_FUNCTIONS, logicalId) ? PINNED_PROVIDER_FUNCTIONS[logicalId] : undefined;
    if (pinnedForRole !== undefined || pinned !== undefined) {
      const code = props.Code;
      const codeOk =
        pinned !== undefined &&
        pinnedForRole === logicalId &&
        props.Handler === pinned.handler &&
        props.Environment === undefined &&
        props.Layers === undefined &&
        isRecord(code) &&
        Object.keys(code).length === 2 &&
        isBootstrapBucket(code.S3Bucket, region, targetAccount) &&
        typeof code.S3Key === 'string' &&
        codeDigest(code.S3Key, region) === pinned.codeDigest;
      if (!codeOk) {
        out.push(violation('PROVIDER_CODE_NOT_REVIEWED', stackName, logicalId, `function runs as a pinned CDK provider role but is not that provider with its reviewed handler / code${roleId ? ` (role ${roleId})` : ''}`));
      }
    }
  }

  if (type.startsWith('Custom::')) {
    const tokenFn = isRecord(props.ServiceToken) && Array.isArray(props.ServiceToken['Fn::GetAtt']) ? props.ServiceToken['Fn::GetAtt'][0] : undefined;
    const pinnedType = typeof tokenFn === 'string' && Object.hasOwn(PINNED_PROVIDER_FUNCTIONS, tokenFn) ? PINNED_PROVIDER_FUNCTIONS[tokenFn].customType : undefined;
    const reviewedPinnedTypes = Object.values(PINNED_PROVIDER_FUNCTIONS).map((p) => p.customType);
    if ((pinnedType !== undefined || reviewedPinnedTypes.includes(type)) && (pinnedType !== type || !customPropertiesReviewed(type, props, stackName, templateResources))) {
      out.push(violation('CUSTOM_RESOURCE_NOT_REVIEWED', stackName, logicalId, `${type} must use its pinned provider with reviewed properties (own bucket / approved export paths)`));
    }
  }

  // A custom resource sends its properties to, and trusts the response of, whatever ServiceToken
  // names. It must be a provider function declared in this template.
  if (type.startsWith('Custom::') && !isLocalGetAtt(props.ServiceToken, templateResources, ['AWS::Lambda::Function'], 'Arn')) {
    out.push(violation('CUSTOM_RESOURCE_PROVIDER_NOT_LOCAL', stackName, logicalId, `ServiceToken is not a provider function declared in this template: ${JSON.stringify(props.ServiceToken)}`));
  }

  if (type === 'AWS::S3::BucketPolicy' || type === 'AWS::SNS::TopicPolicy') {
    const targets =
      type === 'AWS::S3::BucketPolicy'
        ? [props.Bucket].filter((b) => b !== undefined)
        : asArray(props.Topics);
    const targetType = type === 'AWS::S3::BucketPolicy' ? 'AWS::S3::Bucket' : 'AWS::SNS::Topic';
    if (targets.length === 0 || !targets.every((t) => isLocalRef(t, templateResources, [targetType]))) {
      out.push(violation('RESOURCE_POLICY_TARGET_NOT_LOCAL', stackName, logicalId, `policy attaches to a ${targetType} this template does not declare`));
    }
    out.push(...resourcePolicyViolations(stackName, logicalId, props.PolicyDocument, templateResources, targetAccount));
  }

  return out;
}

/**
 * Properties of the pinned-provider custom resources. The auto-delete provider empties exactly a
 * bucket of this template; the cross-region export providers write / read only SSM parameters
 * under `/cdk/exports/<approved stack>/` (their role may write any `/cdk/exports/*` parameter of
 * the account, so the paths are the review).
 */
function customPropertiesReviewed(type, props, stackName, templateResources) {
  const keys = (obj, allowed) => isRecord(obj) && Object.keys(obj).every((k) => allowed.includes(k));
  const exportPath = (key, consumer) => typeof key === 'string' && key.startsWith(`/cdk/exports/${consumer}/`) && /^\/cdk\/exports\/[A-Za-z0-9-]+\/[A-Za-z0-9]+$/.test(key);
  if (type === 'Custom::S3AutoDeleteObjects') {
    return keys(props, ['ServiceToken', 'BucketName']) && isLocalRef(props.BucketName, templateResources, ['AWS::S3::Bucket']);
  }
  if (type === 'Custom::CrossRegionExportWriter') {
    const w = props.WriterProps;
    if (!keys(props, ['ServiceToken', 'WriterProps']) || !keys(w, ['region', 'exports']) || !isRecord(w.exports)) return false;
    const entries = Object.keys(w.exports);
    return entries.length > 0 && entries.every((k) => Object.keys(APPROVED_STACKS).some((consumer) => APPROVED_STACKS[consumer] === w.region && consumer !== stackName && exportPath(k, consumer)));
  }
  if (type === 'Custom::CrossRegionExportReader') {
    const r = props.ReaderProps;
    if (!keys(props, ['ServiceToken', 'ReaderProps']) || !keys(r, ['region', 'prefix', 'imports']) || !isRecord(r.imports)) return false;
    return (
      r.prefix === stackName &&
      r.region === APPROVED_STACKS[stackName] &&
      Object.entries(r.imports).every(([k, v]) => exportPath(k, stackName) && v === `{{resolve:ssm:${k}}}`)
    );
  }
  return false;
}

/**
 * JSON.parse keeps the last of two equal keys; another reader (the CDK CLI, CloudFormation) may
 * keep the first, so the reviewed document and the deployed one could differ. Reject duplicate
 * keys (compared after JSON unescaping) at any depth, then parse normally.
 */
export function parseStrictJson(text) {
  let i = 0;
  const fail = (why) => {
    throw new Error(`invalid JSON at offset ${i}: ${why}`);
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i += 1;
  };
  const string = () => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (text[i] !== '"') fail('unterminated string');
    i += 1;
    return JSON.parse(text.slice(start, i));
  };
  const value = () => {
    ws();
    if (text[i] === '{') {
      i += 1;
      const seen = new Set();
      ws();
      if (text[i] === '}') {
        i += 1;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected a key');
        const k = string();
        if (seen.has(k)) fail(`duplicate key ${JSON.stringify(k)}`);
        seen.add(k);
        ws();
        if (text[i] !== ':') fail('expected ":"');
        i += 1;
        value();
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === '}') {
          i += 1;
          return;
        }
        fail('expected "," or "}"');
      }
    }
    if (text[i] === '[') {
      i += 1;
      ws();
      if (text[i] === ']') {
        i += 1;
        return;
      }
      for (;;) {
        value();
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === ']') {
          i += 1;
          return;
        }
        fail('expected "," or "]"');
      }
    }
    if (text[i] === '"') {
      string();
      return;
    }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail('unexpected token');
    i += m[0].length;
  };
  value();
  ws();
  if (i !== text.length) fail('trailing data');
  return JSON.parse(text);
}

const readJson = (file) => parseStrictJson(fs.readFileSync(file, 'utf8'));

const ACCOUNT_FORMS = (targetAccount) => `(?:${targetAccount}|\\$\\{AWS::AccountId\\})`;

/** Exact ADR 0009 bootstrap role ARN for `kind` in `region` (partition / account may be CDK placeholders). */
function isBootstrapRole(value, kind, region, targetAccount) {
  if (typeof value !== 'string') return false;
  const a = ACCOUNT_FORMS(targetAccount);
  return new RegExp(`^arn:(?:aws|\\$\\{AWS::Partition\\}):iam::${a}:role/cdk-${BOOTSTRAP_QUALIFIER}-${kind}-role-${a}-${region}$`).test(value);
}

const isBootstrapBucket = (value, region, targetAccount) =>
  typeof value === 'string' && new RegExp(`^cdk-${BOOTSTRAP_QUALIFIER}-assets-${ACCOUNT_FORMS(targetAccount)}-${region}$`).test(value);

const BOOTSTRAP_VERSION_PARAMETER = `/cdk-bootstrap/${BOOTSTRAP_QUALIFIER}/version`;
const APPROVED_REGIONS = () => new Set(Object.values(APPROVED_STACKS));

/**
 * Asset manifest: everything the CDK CLI would publish. Every file asset must come from a path
 * inside the assembly (no `executable` build command, which would run on the broker), and every
 * destination must be the ADR 0009 bootstrap bucket with its file-publishing role. Container
 * image assets are not reviewed. Returns violations and the template-asset index (objectKey ->
 * source paths) used to bind each stack's template URL to its reviewed templateFile.
 */
function assetManifestViolations(artifactId, props, assets, assemblyDir, targetAccount, objectKeySources, templateFiles) {
  const out = [];
  const bad = (why) => out.push(violation('ASSET_NOT_REVIEWED', artifactId, null, why));
  for (const key of Object.keys(props)) {
    if (!REVIEWED_ASSET_ARTIFACT_PROPERTIES.has(key)) bad(`asset manifest artifact property ${key} is not reviewed`);
  }
  if (props.bootstrapStackVersionSsmParameter !== undefined && props.bootstrapStackVersionSsmParameter !== BOOTSTRAP_VERSION_PARAMETER) {
    bad(`bootstrap version parameter is not ${BOOTSTRAP_VERSION_PARAMETER}`);
  }
  for (const key of Object.keys(assets)) {
    if (!['version', 'files', 'dockerImages'].includes(key)) bad(`asset manifest key ${key} is not reviewed`);
  }
  if (isRecord(assets.dockerImages) ? Object.keys(assets.dockerImages).length > 0 : assets.dockerImages !== undefined) {
    bad('container image assets are not reviewed');
  }
  if (assets.files !== undefined && !isRecord(assets.files)) bad('files is not an object');
  const regions = APPROVED_REGIONS();
  for (const [assetId, asset] of Object.entries(isRecord(assets.files) ? assets.files : {})) {
    const source = isRecord(asset) ? asset.source : undefined;
    if (!isRecord(source) || Object.keys(source).some((k) => !['path', 'packaging'].includes(k))) {
      bad(`asset ${assetId}: source must be only { path, packaging } (no executable)`);
      continue;
    }
    if (!safeTemplatePath(assemblyDir, source.path) || ![undefined, 'file', 'zip'].includes(source.packaging)) {
      bad(`asset ${assetId}: source path escapes the assembly or packaging is not reviewed`);
      continue;
    }
    if (!isRecord(asset.destinations) || Object.keys(asset.destinations).length === 0) {
      bad(`asset ${assetId}: no destinations`);
      continue;
    }
    for (const [destId, dest] of Object.entries(asset.destinations)) {
      const keysOk = isRecord(dest) && Object.keys(dest).every((k) => ['bucketName', 'objectKey', 'region', 'assumeRoleArn'].includes(k));
      const region = isRecord(dest) ? dest.region : undefined;
      const ok =
        keysOk &&
        regions.has(region) &&
        isBootstrapBucket(dest.bucketName, region, targetAccount) &&
        isBootstrapRole(dest.assumeRoleArn, 'file-publishing', region, targetAccount) &&
        typeof dest.objectKey === 'string' &&
        /^[0-9a-f]{64}(?:\.json|\.zip)?$/.test(dest.objectKey);
      if (!ok) {
        bad(`asset ${assetId} destination ${destId}: not the ${BOOTSTRAP_QUALIFIER} bootstrap bucket / file-publishing role in an approved region`);
        continue;
      }
      const list = objectKeySources.get(dest.objectKey) ?? [];
      // A `.json` key is where a template lives. Only a stack template file may be published there,
      // under the SHA-256 of its own bytes; otherwise another asset could plant (or pre-plant for a
      // later run, since publishing skips existing objects) the object a template URL names.
      if (dest.objectKey.endsWith('.json')) {
        let bytesHash = null;
        try {
          bytesHash = createHash('sha256').update(fs.readFileSync(safeTemplatePath(assemblyDir, source.path))).digest('hex');
        } catch {
          bytesHash = null;
        }
        if ((source.packaging ?? 'file') !== 'file' || bytesHash === null || dest.objectKey !== `${bytesHash}.json` || !templateFiles.has(source.path)) {
          bad(`asset ${assetId} destination ${destId}: a .json object key is only for a stack template published under the SHA-256 of its own bytes`);
          continue;
        }
      } else if (source.packaging === 'zip' && !dest.objectKey.endsWith('.zip')) {
        bad(`asset ${assetId} destination ${destId}: a zip asset must use a .zip key`);
        continue;
      }
      list.push({ path: source.path, packaging: source.packaging ?? 'file', manifest: artifactId, bucketName: dest.bucketName, region });
      objectKeySources.set(dest.objectKey, list);
    }
  }
  return out;
}

/**
 * Stack artifact: the CLI deploys the template at `stackTemplateAssetObjectUrl` with the
 * manifest's roles. The URL must be the bootstrap bucket object whose key is the SHA-256 of the
 * reviewed templateFile, published from exactly that file; the roles must be the ADR 0009
 * bootstrap roles for the stack's region; no other deploy option (parameters, notification
 * ARNs, external ids ...) is accepted.
 */
function stackArtifactViolations(stackName, props, region, templateBytes, targetAccount, objectKeySources, dependencies, assetManifestIds) {
  const out = [];
  const bad = (rule, why) => out.push(violation(rule, stackName, null, why));
  // Stack tags propagate to every resource; the ADR 0009 boundary keys on `Project`.
  if (props.tags !== undefined) {
    const tags = props.tags;
    const ok =
      isRecord(tags) &&
      Object.entries(tags).every(([k, v]) => REVIEWED_STACK_TAG_KEYS.has(k) && typeof v === 'string') &&
      Object.entries(PINNED_STACK_TAGS).every(([k, v]) => tags[k] === v);
    if (!ok) bad('MANIFEST_PROPERTY_NOT_REVIEWED', 'stack tags are outside the reviewed keys or change a pinned tag');
  }
  if (props.additionalDependencies !== undefined && !(Array.isArray(props.additionalDependencies) && props.additionalDependencies.every((d) => assetManifestIds.has(d)))) {
    bad('MANIFEST_PROPERTY_NOT_REVIEWED', 'additionalDependencies may only name asset manifests of this assembly');
  }
  for (const key of Object.keys(props)) {
    if (!REVIEWED_STACK_ARTIFACT_PROPERTIES.has(key)) bad('MANIFEST_PROPERTY_NOT_REVIEWED', `stack artifact property ${key} is not reviewed`);
  }
  if (!isBootstrapRole(props.assumeRoleArn, 'deploy', region, targetAccount)) {
    bad('MANIFEST_ROLE_NOT_REVIEWED', `assumeRoleArn is not the ${BOOTSTRAP_QUALIFIER} deploy role for ${region}`);
  }
  if (!isBootstrapRole(props.cloudFormationExecutionRoleArn, 'cfn-exec', region, targetAccount)) {
    bad('MANIFEST_ROLE_NOT_REVIEWED', `cloudFormationExecutionRoleArn is not the ${BOOTSTRAP_QUALIFIER} cfn-exec role for ${region}`);
  }
  if (props.lookupRole !== undefined) {
    const lr = props.lookupRole;
    const ok =
      isRecord(lr) &&
      Object.keys(lr).every((k) => ['arn', 'requiresBootstrapStackVersion', 'bootstrapStackVersionSsmParameter'].includes(k)) &&
      isBootstrapRole(lr.arn, 'lookup', region, targetAccount) &&
      (lr.bootstrapStackVersionSsmParameter === undefined || lr.bootstrapStackVersionSsmParameter === BOOTSTRAP_VERSION_PARAMETER);
    if (!ok) bad('MANIFEST_ROLE_NOT_REVIEWED', `lookupRole is not the ${BOOTSTRAP_QUALIFIER} lookup role for ${region}`);
  }
  if (props.bootstrapStackVersionSsmParameter !== undefined && props.bootstrapStackVersionSsmParameter !== BOOTSTRAP_VERSION_PARAMETER) {
    bad('MANIFEST_PROPERTY_NOT_REVIEWED', `bootstrap version parameter is not ${BOOTSTRAP_VERSION_PARAMETER}`);
  }
  if (props.stackTemplateAssetObjectUrl !== undefined) {
    const hash = createHash('sha256').update(templateBytes).digest('hex');
    const m = typeof props.stackTemplateAssetObjectUrl === 'string' ? /^s3:\/\/([^/]+)\/([^/]+)$/.exec(props.stackTemplateAssetObjectUrl) : null;
    if (!m || !isBootstrapBucket(m[1], region, targetAccount) || m[2] !== `${hash}.json`) {
      bad('MANIFEST_TEMPLATE_NOT_REVIEWED', 'stackTemplateAssetObjectUrl is not the bootstrap-bucket object named by the SHA-256 of the reviewed templateFile');
    } else {
      const sources = objectKeySources.get(m[2]) ?? [];
      if (sources.length === 0 || sources.some((s) => s.path !== props.templateFile || s.packaging !== 'file')) {
        bad('MANIFEST_TEMPLATE_NOT_REVIEWED', 'the template object is not published from exactly the reviewed templateFile');
      } else if (!sources.every((s) => dependencies.includes(s.manifest))) {
        // Otherwise the CLI may not publish it in this run and would deploy whatever object exists.
        bad('MANIFEST_TEMPLATE_NOT_REVIEWED', 'the stack does not depend on the asset manifest that publishes its template');
      }
    }
  }
  return out;
}

/**
 * Template-level sections: only CDK's bootstrap-version parameter and rule. Any other parameter
 * (a default the CLI would pass through) or rule is an input this policy did not review.
 */
function templateSectionViolations(stackName, template) {
  const out = [];
  const params = template.Parameters;
  const reviewedParam = {
    Type: 'AWS::SSM::Parameter::Value<String>',
    Default: BOOTSTRAP_VERSION_PARAMETER,
  };
  if (params !== undefined) {
    const ok =
      isRecord(params) &&
      Object.keys(params).every((k) => k === 'BootstrapVersion') &&
      (params.BootstrapVersion === undefined ||
        (isRecord(params.BootstrapVersion) && params.BootstrapVersion.Type === reviewedParam.Type && params.BootstrapVersion.Default === reviewedParam.Default));
    if (!ok) out.push(violation('TEMPLATE_PARAMETER_NOT_REVIEWED', stackName, null, `only the ${BOOTSTRAP_QUALIFIER} BootstrapVersion parameter is reviewed`));
  }
  if (template.Rules !== undefined && !(isRecord(template.Rules) && Object.keys(template.Rules).every((k) => k === 'CheckBootstrapVersion'))) {
    out.push(violation('TEMPLATE_PARAMETER_NOT_REVIEWED', stackName, null, 'only the CheckBootstrapVersion rule is reviewed'));
  }
  for (const key of Object.keys(template)) {
    // No Mappings / Conditions: values chosen by Fn::FindInMap / Fn::If are not resolved by this review.
    if (!['AWSTemplateFormatVersion', 'Description', 'Metadata', 'Parameters', 'Rules', 'Resources', 'Outputs'].includes(key)) {
      out.push(violation('TEMPLATE_SECTION_NOT_REVIEWED', stackName, null, `template section ${key} is not reviewed`));
    }
  }
  return out;
}

/**
 * Literal projections of `Fn::Join` / `Fn::Sub` values, so a number split across intrinsic parts
 * (`['...:999999', '999999:...']`, `${A}${B}` with a variable map) is still scanned as one string.
 * Non-literal parts become a NUL, which is never part of an account id.
 */
function joinedLiterals(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((v) => joinedLiterals(v, out));
    return out;
  }
  if (!isRecord(value)) return out;
  if (['Fn::Join', 'Fn::Sub', 'Fn::Select'].some((k) => Object.hasOwn(value, k))) out.push(literalProjection(value));
  Object.values(value).forEach((v) => joinedLiterals(v, out));
  return out;
}

/**
 * The string an intrinsic evaluates to, as far as literals decide it, with every other part a
 * NUL: nested `Fn::Join`, `Fn::Sub` variables that are themselves intrinsics, and `Fn::Select` of
 * a literal list are resolved recursively, so no nesting splits an account id out of view.
 */
function literalProjection(value, depth = 0) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (!isRecord(value) || depth > 32) return '\u0000';
  const j = value['Fn::Join'];
  if (Array.isArray(j) && j.length === 2 && typeof j[0] === 'string') {
    const parts = literalList(j[1], depth + 1);
    if (parts) return parts.map((p) => literalProjection(p, depth + 1)).join(j[0]);
  }
  const sub = value['Fn::Sub'];
  if (typeof sub === 'string' || (Array.isArray(sub) && typeof sub[0] === 'string')) {
    const [text, vars] = typeof sub === 'string' ? [sub, {}] : [sub[0], isRecord(sub[1]) ? sub[1] : {}];
    return text.replace(/\$\{([^}]*)\}/g, (_m, name) => (Object.hasOwn(vars, name) ? literalProjection(vars[name], depth + 1) : '\u0000'));
  }
  const sel = value['Fn::Select'];
  if (Array.isArray(sel) && sel.length === 2) {
    const list = literalList(sel[1], depth + 1);
    const index = Number(literalProjection(sel[0], depth + 1));
    return list && Number.isInteger(index) && index >= 0 && index < list.length ? literalProjection(list[index], depth + 1) : '\u0000';
  }
  return '\u0000';
}

/** A literal list, or `Fn::Split` of a projectable string; otherwise null. */
function literalList(value, depth) {
  if (Array.isArray(value)) return value;
  const split = isRecord(value) ? value['Fn::Split'] : undefined;
  if (Array.isArray(split) && split.length === 2 && typeof split[0] === 'string' && split[0] !== '') {
    return literalProjection(split[1], depth + 1).split(split[0]);
  }
  return null;
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
    manifest = readJson(manifestPath);
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

  // Pass 1: artifact types and asset manifests (the template index must be complete before stacks).
  const objectKeySources = new Map();
  const assetManifestIds = new Set();
  const templateFiles = new Set(
    Object.values(manifest.artifacts)
      .filter((a) => isRecord(a) && a.type === 'aws:cloudformation:stack' && isRecord(a.properties) && typeof a.properties.templateFile === 'string')
      .map((a) => a.properties.templateFile),
  );
  for (const [artifactId, artifact] of Object.entries(manifest.artifacts)) {
    if (!isRecord(artifact) || typeof artifact.type !== 'string' || !REVIEWED_ARTIFACT_TYPES.has(artifact.type)) {
      const nested = isRecord(artifact) && artifact.type === 'cdk:cloud-assembly';
      violations.push(violation(nested ? 'NESTED_ASSEMBLY' : 'ARTIFACT_TYPE_NOT_REVIEWED', artifactId, null,
        nested ? 'nested cloud assemblies are not evaluated by this policy' : `artifact type ${JSON.stringify(isRecord(artifact) ? artifact.type : artifact)} is not reviewed`));
      continue;
    }
    for (const key of Object.keys(artifact)) {
      if (!REVIEWED_ARTIFACT_KEYS.has(key)) {
        violations.push(violation('ARTIFACT_KEY_NOT_REVIEWED', artifactId, null, `artifact key ${key} is not reviewed`));
      }
    }
    // Legacy asset metadata (`aws:cdk:asset`) is published by the CLI outside the asset manifest
    // (a container-image entry even runs a docker build on the deploying host).
    const metadataEntries = [];
    if (artifact.metadata !== undefined) metadataEntries.push(artifact.metadata);
    if (artifact.additionalMetadataFile !== undefined) {
      const metadataFile = safeTemplatePath(assemblyDir, artifact.additionalMetadataFile);
      try {
        metadataEntries.push(readJson(metadataFile));
      } catch {
        violations.push(violation('ARTIFACT_METADATA_INVALID', artifactId, null, 'additionalMetadataFile is missing, escapes the assembly, is not JSON or has duplicate keys'));
      }
    }
    for (const entries of metadataEntries) {
      const list = isRecord(entries) ? Object.values(entries).flatMap((v) => (Array.isArray(v) ? v : [v])) : [entries];
      if (list.some((e) => !isRecord(e) || typeof e.type !== 'string' || e.type === 'aws:cdk:asset')) {
        violations.push(violation('LEGACY_ASSET_METADATA', artifactId, null, 'artifact metadata carries an aws:cdk:asset (or unparseable) entry the CLI would publish'));
      }
    }
    if (artifact.type !== 'cdk:asset-manifest') continue;
    assetManifestIds.add(artifactId);
    const props = isRecord(artifact.properties) ? artifact.properties : {};
    const file = safeTemplatePath(assemblyDir, props.file);
    let assets;
    try {
      assets = file ? readJson(file) : undefined;
    } catch {
      assets = undefined;
    }
    if (!isRecord(assets)) {
      violations.push(violation('ASSET_MANIFEST_INVALID', artifactId, null, 'asset manifest is missing, escapes the assembly, is not JSON or has duplicate keys'));
      continue;
    }
    for (const account of foreignAccounts(assets, targetAccount)) {
      violations.push(violation('MANIFEST_FOREIGN_ACCOUNT', artifactId, null, `asset manifest names account ${account}`));
    }
    violations.push(...assetManifestViolations(artifactId, props, assets, assemblyDir, targetAccount, objectKeySources, templateFiles));
  }

  // Digest of the code the CLI would publish under an object key: every source published there
  // must be a zip of an in-assembly directory with the same digest, else null (never reviewed).
  const codeDigest = (objectKey, region) => {
    const all = /^[0-9a-f]{64}\.zip$/.test(objectKey) ? objectKeySources.get(objectKey) ?? [] : [];
    // Every source published under this key must match, and at least one must publish it to the
    // function's own region (the bucket there is checked against the Code by the caller).
    if (!all.some((src) => src.region === region)) return null;
    const sources = all;
    const digests = sources.map((src) => (src.packaging === 'zip' ? treeDigest(safeTemplatePath(assemblyDir, src.path)) : null));
    return digests.length > 0 && digests.every((d) => d !== null && d === digests[0]) ? digests[0] : null;
  };

  // Pass 2: stacks.
  for (const [artifactId, artifact] of Object.entries(manifest.artifacts)) {
    if (!isRecord(artifact) || artifact.type !== 'aws:cloudformation:stack') continue;
    const props = isRecord(artifact.properties) ? artifact.properties : {};
    const stackName = typeof props.stackName === 'string' ? props.stackName : artifactId;
    const expectedRegion = Object.hasOwn(APPROVED_STACKS, stackName) ? APPROVED_STACKS[stackName] : undefined;
    for (const account of foreignAccounts(props, targetAccount)) {
      violations.push(violation('MANIFEST_FOREIGN_ACCOUNT', stackName, null, `stack deploy / lookup role or asset location names account ${account}`));
    }

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
    let templateBytes;
    try {
      templateBytes = fs.readFileSync(templatePath);
      template = parseStrictJson(templateBytes.toString('utf8'));
    } catch (error) {
      violations.push(violation('TEMPLATE_INVALID', stackName, null, String(error)));
      continue;
    }
    if (!isRecord(template) || !isRecord(template.Resources)) {
      violations.push(violation('TEMPLATE_INVALID', stackName, null, 'Resources must be an object'));
      continue;
    }
    violations.push(...stackArtifactViolations(stackName, props, expectedRegion, templateBytes, targetAccount, objectKeySources, Array.isArray(artifact.dependencies) ? artifact.dependencies : [], assetManifestIds));
    violations.push(...templateSectionViolations(stackName, template));
    // Any other account named anywhere in the template (alarm actions, KMS keys, event targets,
    // ARNs in resource properties) is a cross-account reference this policy did not review.
    for (const account of foreignAccounts([template, joinedLiterals(template)], targetAccount)) {
      violations.push(violation('TEMPLATE_FOREIGN_ACCOUNT', stackName, null, `template names account ${account}`));
    }

    if (template.Transform !== undefined || containsTransform(template)) {
      violations.push(violation('TEMPLATE_TRANSFORM', stackName, null, 'Transform / Fn::Transform expands a macro after this review'));
    }

    const entries = Object.entries(template.Resources);
    const attachedPolicies = policyAttachmentCounts(template.Resources);
    if (entries.length > MAX_RESOURCES_PER_STACK) {
      violations.push(violation('STACK_RESOURCE_COUNT_EXCEEDED', stackName, null, `${entries.length} resources exceeds ${MAX_RESOURCES_PER_STACK}`));
    }

    for (const [logicalId, resource] of entries) {
      totalResources += 1;
      if (isRecord(resource) && typeof resource.Type === 'string') {
        counts[resource.Type] = (counts[resource.Type] ?? 0) + 1;
      }
      violations.push(...evaluateResource(stackName, logicalId, resource, template.Resources, { targetAccount, attachedPolicies, region: expectedRegion, codeDigest }));
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
