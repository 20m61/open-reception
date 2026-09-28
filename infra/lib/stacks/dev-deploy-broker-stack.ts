import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';

export const DEV_DEPLOY_PROMOTION_BRANCH = 'dev-deploy';

/**
 * The one AWS account the broker may ever deploy to (pre-arming blocker 3). This is a reviewed
 * constant, not the stack's own `AWS::AccountId`: the same account is pinned by the ADR 0009
 * policies in `scripts/aws-policies/` (a test keeps them equal). A concrete synth for another
 * account fails, the trusted policy evaluates the cloud assembly against this account, and the
 * broker build refuses to run in any other account.
 */
export const DEV_DEPLOY_TARGET_ACCOUNT = '822063948773';

const VALIDATION_PROJECT_NAME = 'OpenReceptionDevDeployValidation';
const BROKER_PROJECT_NAME = 'OpenReceptionTrustedDevDeployBroker';

/** Source of the trusted cloud-assembly policy that the broker stack publishes as an asset. */
export const TRUSTED_POLICY_SOURCE_PATH = path.join(__dirname, '../../broker/trusted-policy.mjs');

/** Partition key value of every sparse-ledger item (`infra/broker/sparse-ledger.mjs` PROJECT_KEY). */
export const SPARSE_LEDGER_PROJECT_KEY = 'PROJECT#open-reception';

/**
 * The only DynamoDB actions the broker needs for the sparse ledger (#1153): consistent reads,
 * create-only attempt records, and conditional counter/override updates (TransactWriteItems is
 * authorized per contained Put/Update). No Delete, Scan, Query, Batch* or table management.
 */
/**
 * Data-plane writes the table's resource policy denies to every principal except the broker role
 * and the human override-issuer role. The Claude boundary / CFN exec policies also deny
 * `dynamodb:*` on this stack's tables (`scripts/aws-policies`), so a deployed candidate workload
 * cannot forge an override or reset a counter even though it lives in the same account.
 */
/**
 * Pattern for the two human role ARN parameters. The negative lookahead (on the role name, after
 * any path) refuses roles that must never hold ledger authority: Claude's deploy chain / CDK
 * bootstrap roles (`cdk-orcloud01-*`), every `OpenReception*` role (Claude's entry / deploy
 * roles, this stack's broker / validation roles, and candidate workload roles such as
 * `OpenReception-Web-dev-*`), and other projects' workload prefixes in the same account.
 * CloudFormation AllowedPattern is a Java regex, which supports lookahead.
 */
export const HUMAN_ROLE_ARN_PATTERN =
  '^arn:aws[^:]*:iam::[0-9]{12}:role/(?:[A-Za-z0-9+=,.@_-]+/)*(?!cdk-orcloud01-|OpenReception|nodi-|salon-loop-|Kiaff)[A-Za-z0-9+=,.@_-]+$';

export const SPARSE_LEDGER_PROTECTED_WRITES = [
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem',
  'dynamodb:PartiQLInsert',
  'dynamodb:PartiQLUpdate',
  'dynamodb:PartiQLDelete',
] as const;

/**
 * Control-plane actions that could silently reset or unprotect the ledger: TTL on a counter
 * attribute deletes items, a resource-policy change removes this protection, UpdateTable can
 * disable deletion protection, and so on. Denied to every principal except the human override
 * issuer and the human stack-deploy (CloudFormation execution) role, which needs them to update
 * this stack.
 */
export const SPARSE_LEDGER_PROTECTED_CONTROL = [
  'dynamodb:UpdateTimeToLive',
  'dynamodb:PutResourcePolicy',
  'dynamodb:DeleteResourcePolicy',
  'dynamodb:UpdateTable',
  'dynamodb:DeleteTable',
  'dynamodb:UpdateContinuousBackups',
  'dynamodb:RestoreTableFromBackup',
  'dynamodb:RestoreTableToPointInTime',
  'dynamodb:UpdateKinesisStreamingDestination',
  'dynamodb:EnableKinesisStreamingDestination',
  'dynamodb:DisableKinesisStreamingDestination',
] as const;

/** Actions on the ledger audit bucket that could erase or unprotect delivered CloudTrail files. */
export const LEDGER_AUDIT_PROTECTED_ACTIONS = [
  's3:DeleteObject',
  's3:DeleteObjectVersion',
  's3:PutBucketVersioning',
  's3:PutLifecycleConfiguration',
  's3:PutBucketPolicy',
  's3:DeleteBucketPolicy',
  's3:PutBucketObjectLockConfiguration',
  's3:PutReplicationConfiguration',
  // Exposure / takeover of the logs (log file validation detects edits, not reads).
  's3:PutBucketAcl',
  's3:PutObjectAcl',
  's3:PutBucketPublicAccessBlock',
  's3:PutEncryptionConfiguration',
  's3:PutBucketOwnershipControls',
  // An empty bucket (before the first delivery) could otherwise be deleted.
  's3:DeleteBucket',
] as const;

export const SPARSE_LEDGER_BROKER_ACTIONS = [
  'dynamodb:GetItem',
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
] as const;

/** Days a pipeline artifact (candidate source archive / cloud assembly) is kept (pre-arming blocker 5). */
export const PIPELINE_ARTIFACT_RETENTION_DAYS = 7;

/** Broker-local download target of the trusted policy (outside the candidate artifact tree). */
export const TRUSTED_POLICY_LOCAL_PATH = '/tmp/open-reception-trusted-policy.mjs';

/** Trusted execution-provenance module (pre-arming blockers 2 and 4), published like the policy. */
export const PROVENANCE_SOURCE_PATH = path.join(__dirname, '../../broker/run-provenance.mjs');
export const PROVENANCE_LOCAL_PATH = '/tmp/open-reception-run-provenance.mjs';

/**
 * Broker-owned directories outside the candidate artifact tree (same values as
 * `infra/broker/run-provenance.mjs`, pinned by test). The broker never reads from or writes into
 * the tree CodeBuild extracted: a candidate symlink there could redirect a write onto a verified
 * module. Gates read only the exact artifact version the provenance check fetched into
 * BROKER_VALIDATED_DIR, and results go to BROKER_OUT_DIR, which must not exist beforehand.
 */
export const BROKER_WORK_DIR = '/tmp/open-reception-broker-work';
export const BROKER_VALIDATED_DIR = `${BROKER_WORK_DIR}/validated`;
export const BROKER_OUT_DIR = '/tmp/open-reception-broker-out';
export const BROKER_EVIDENCE_PATH = `${BROKER_VALIDATED_DIR}/broker-evidence.json`;
export const BROKER_ASSEMBLY_DIR = `${BROKER_VALIDATED_DIR}/infra/cdk.out`;
export const PROVENANCE_DECISION_PATH = `${BROKER_OUT_DIR}/provenance.json`;
export const POLICY_RESULT_PATH = `${BROKER_OUT_DIR}/trusted-policy-result.json`;
export const BROKER_RESULT_PATH = `${BROKER_OUT_DIR}/broker-result.json`;
export const TARGET_STACKS_DECISION_PATH = `${BROKER_OUT_DIR}/target-stacks.json`;

/**
 * Sparse ledger modules (#1153 wiring). Published as stack assets and SHA-256 verified like the
 * trusted policy; the runner imports `./sparse-ledger.mjs`, so both land in one broker-local dir.
 */
export const LEDGER_MODULE_SOURCE_PATH = path.join(__dirname, '../../broker/sparse-ledger.mjs');
export const LEDGER_RUNNER_SOURCE_PATH = path.join(__dirname, '../../broker/ledger-runner.mjs');
export const LEDGER_LOCAL_DIR = '/tmp/open-reception-ledger';
export const LEDGER_MODULE_LOCAL_PATH = `${LEDGER_LOCAL_DIR}/sparse-ledger.mjs`;
export const LEDGER_RUNNER_LOCAL_PATH = `${LEDGER_LOCAL_DIR}/ledger-runner.mjs`;
export const LEDGER_GATE_FILE = `${LEDGER_LOCAL_DIR}/gate`;
/** Same shape as `isLedgerId` in sparse-ledger.mjs (the genesis item must carry this value). */
export const LEDGER_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$';

export const PIPELINE_NAME = 'OpenReceptionSparseDevDeploy';

/**
 * S10a target-stack stability gate (#1146 / #1153). The stacks the promotion may change: the
 * three stacks ADR 0009 admits (the Validation synth names the same three). `region: null` is the
 * broker's own region; CfMon lives in us-east-1 (CloudFront metrics).
 */
export const TARGET_STACKS = [
  { stackName: 'OpenReception-Web-dev', region: null },
  { stackName: 'OpenReception-WebMonitoring-dev', region: null },
  { stackName: 'OpenReception-CfMon-dev', region: 'us-east-1' },
] as const;
export const TARGET_STACKS_SOURCE_PATH = path.join(__dirname, '../../broker/target-stacks.mjs');
export const TARGET_STACKS_LOCAL_PATH = '/tmp/open-reception-target-stacks.mjs';
/** The only read the gate needs, on the three stack ARNs (a reviewed exception to the cloudformation: ban). */
export const TARGET_STACK_READ_ACTIONS = ['cloudformation:DescribeStacks'] as const;

/**
 * Ledger / gate rules that need a human (S10a escalation): alerted whenever the runner logs them.
 * The repeated-failure rule is logged by `reserve` once armed; the stability gate by `deny`.
 */
export const ESCALATION_RULES = [
  'TARGET_STACK_NOT_STABLE',
  'TARGET_STACK_UNVERIFIABLE',
  'TARGET_STACK_INPUT_INVALID',
  'SPARSE_REVISION_REPEATED_FAILURE',
] as const;

/**
 * CloudTrail data events on the ledger table (#1153): the authenticated principal behind every
 * write (genesis, override issuance, reservations, and refused attempts), since the ledger's own
 * `approver` attribute is written by the issuer and is not itself authenticated.
 */
export const LEDGER_AUDIT_TRAIL_NAME = 'OpenReceptionSparseLedgerAudit';

/**
 * Runner events after which a reserved attempt may stay `in_progress` (holding budget) or a
 * denial went unaudited (#1153 "alert on in_progress attempts"). Each is alerted when it happens,
 * instead of scanning the ledger later:
 * - `ledger.reserve_ambiguous`: the reservation may have committed but this build cannot use it;
 * - `ledger.outcome_failed`: a reserved attempt's outcome could not be recorded;
 * - `ledger.runner_error`: the runner itself failed;
 * - `ledger.denial_audit_failed`, or any event with `audited: false`: a denial is only in the log;
 * - `ledger.usage_error`: a malformed runner call (e.g. an `outcome` that never recorded).
 */
export const LEDGER_ATTENTION_EVENTS = [
  'ledger.reserve_ambiguous',
  'ledger.outcome_failed',
  'ledger.runner_error',
  'ledger.denial_audit_failed',
  'ledger.usage_error',
] as const;

/**
 * Broker build endings without its own `finally` / outcome bookkeeping. CodeBuild documents
 * `build-status` of "Build State Change" events as IN_PROGRESS / SUCCEEDED / FAILED / STOPPED, and
 * a timeout or fault as the `completed-phase-status` of a "Build Phase Change" event, so both are
 * matched (a stop may notify twice). Needs live verification.
 */
export const BROKER_ABORT_STATES = ['TIMED_OUT', 'STOPPED', 'FAULT'] as const;
export const LEDGER_AUDIT_RETENTION_DAYS = 400;
/** Stage/Action names the provenance check binds to (Source, Validate, BrokerBoundary). */
export const PIPELINE_STAGES = Object.freeze({
  source: { stage: 'Source', action: 'PromotionBranch' },
  validate: { stage: 'Validate', action: 'UnprivilegedValidation' },
  broker: { stage: 'BrokerBoundary', action: 'TrustedBrokerUnarmed' },
});

/**
 * S3 actions that could erase or rewrite the version history the provenance check relies on, or
 * turn versioning off. Explicitly denied to the Validation role (candidate code) and the broker.
 */
export const ARTIFACT_HISTORY_WRITES = [
  's3:DeleteObject',
  's3:DeleteObjectVersion',
  's3:PutBucketVersioning',
  's3:PutLifecycleConfiguration',
  's3:PutBucketPolicy',
  's3:DeleteBucketPolicy',
  's3:PutReplicationConfiguration',
  's3:PutBucketObjectLockConfiguration',
] as const;

/** Read-only APIs the provenance check calls (and nothing else). */
export const PROVENANCE_READ_ACTIONS = {
  pipeline: ['codepipeline:ListPipelineExecutions', 'codepipeline:ListActionExecutions'],
  validationBuild: ['codebuild:BatchGetBuilds'],
  artifactBucket: ['s3:ListBucketVersions', 's3:GetBucketVersioning'],
} as const;

/**
 * SHA-256 of the trusted policy file content, computed at synth time.
 *
 * This is deliberately NOT the CDK asset fingerprint (`Asset.assetHash`), which is a CDK-internal
 * staging hash and cannot be recomputed from the downloaded object. The broker verifies the
 * downloaded bytes against this value before executing them.
 */
export const trustedPolicySha256 = (file: string = TRUSTED_POLICY_SOURCE_PATH): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Wrap a dependency-free JS snippet as a POSIX-shell-safe `node -e '<script>' [args...]` command.
 * Shell single quotes disable every expansion (`$`, backticks, `\`), so the snippet must not
 * contain a single quote itself; JS string literals inside use double quotes. Positional args
 * (read via `process.argv[1..]`) are restricted to plain absolute/relative path characters.
 */
export const nodeEval = (script: string, ...args: string[]): string => {
  if (script.includes("'")) {
    throw new Error('inline broker script must not contain a single quote');
  }
  for (const arg of args) {
    if (!/^[A-Za-z0-9_./-]+$/.test(arg)) {
      throw new Error(`inline broker script argument must be a plain path: ${arg}`);
    }
  }
  return [`node -e '${script}'`, ...args].join(' ');
};

/**
 * Broker: the account this build runs in (from the CodeBuild build ARN, set by the service) must
 * be the pinned deploy account. Runs before anything else; no AWS call is needed. The pin is a
 * literal in the stack-owned buildspec, never an environment variable: a StartBuild
 * `environmentVariablesOverride` (or an action-level override) could replace an env value.
 */
export const BROKER_ACCOUNT_PIN_CHECK_SCRIPT = [
  `const pinned="${DEV_DEPLOY_TARGET_ACCOUNT}";`,
  'const arn=process.env.CODEBUILD_BUILD_ARN;',
  'const m=typeof arn==="string"?arn.match(/^arn:aws[a-z-]*:codebuild:[a-z0-9-]+:([0-9]{12}):build[/].+$/):null;',
  'if(!m){throw new Error("broker build ARN missing or malformed")}',
  'if(m[1]!==pinned){throw new Error("broker runs outside the pinned deploy account")}',
].join(' ');

/** Validation: record the trusted CodePipeline CommitId (never candidate metadata). */
export const VALIDATION_EVIDENCE_SCRIPT = [
  'const fs=require("fs");',
  'const revision=process.env.OR_TRUSTED_SOURCE_REVISION;',
  'if(typeof revision!=="string"||!/^[0-9a-f]{40}$/.test(revision)){throw new Error("trusted source revision missing or invalid")}',
  'const out={schemaVersion:1,sourceRevision:revision,validationBuildArn:process.env.CODEBUILD_BUILD_ARN||"unknown",observedAt:new Date().toISOString(),status:"validation-complete"};',
  'fs.writeFileSync("broker-evidence.json",JSON.stringify(out,null,2));',
].join(' ');

/**
 * Broker: verify a downloaded trusted module against the SHA-256 pinned at synth. argv[1] is the
 * file, argv[2] the NAME of the environment variable holding the pin (so one reviewed script
 * serves every module). Missing / malformed pin or any byte difference fails closed.
 */
export const BROKER_MODULE_HASH_CHECK_SCRIPT = [
  'const fs=require("fs");',
  'const crypto=require("crypto");',
  'const name=process.argv[2];',
  'if(typeof name!=="string"||!/^OR_[A-Z0-9_]+_SHA256$/.test(name)){throw new Error("pin variable name missing or invalid")}',
  'const expected=process.env[name];',
  'if(typeof expected!=="string"||!/^[0-9a-f]{64}$/.test(expected)){throw new Error("module sha256 pin missing or invalid")}',
  'const file=process.argv[1];',
  'if(typeof file!=="string"||!file){throw new Error("module path missing")}',
  'const actual=crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");',
  'if(actual!==expected){throw new Error("module sha256 mismatch")}',
].join(' ');

/** Name the gate the broker is about to evaluate; `deny` records it if the build stops there. */
export const gateCommand = (
  rule: 'BROKER_MODULE_INTEGRITY' | 'TRUSTED_PROVENANCE_DENIED' | 'TRUSTED_REVISION_MISMATCH' | 'TRUSTED_POLICY_DENIED' | 'TARGET_STACK_NOT_STABLE' | 'BROKER_NOT_ARMED',
) =>
  `echo ${rule} > ${LEDGER_GATE_FILE}`;

/**
 * `finally`: audit the denial of whichever gate stopped the build (S6b: recorded, no budget).
 * The ledger files are re-verified in the same shell line, so an unverified runner never runs
 * (e.g. when the build failed at its own hash check). Never fails the phase.
 */
export const LEDGER_DENY_COMMAND =
  // Only a failing build is a denial (a future successful path must never be recorded as one).
  'if [ "$CODEBUILD_BUILD_SUCCEEDING" = 0 ]; then ' +
  [
    nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, LEDGER_MODULE_LOCAL_PATH, 'OR_LEDGER_MODULE_SHA256'),
    nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, LEDGER_RUNNER_LOCAL_PATH, 'OR_LEDGER_RUNNER_SHA256'),
    `node ${LEDGER_RUNNER_LOCAL_PATH} deny --gate-file ${LEDGER_GATE_FILE}`,
  ].join(' && ') +
  ' || echo "ledger denial audit skipped (modules unverified)" >&2; fi';

/** The broker command that runs the verified provenance module (blockers 2 and 4). */
export const PROVENANCE_COMMAND = [
  `node ${PROVENANCE_LOCAL_PATH}`,
  `--pipeline ${PIPELINE_NAME}`,
  `--validation-project ${VALIDATION_PROJECT_NAME}`,
  '--artifact-bucket-env OR_PIPELINE_ARTIFACT_BUCKET',
  `--stages ${[PIPELINE_STAGES.source, PIPELINE_STAGES.validate, PIPELINE_STAGES.broker].map((x) => `${x.stage}/${x.action}`).join(',')}`,
].join(' ');

/**
 * Broker: the provenance module's exit code is not the only control. Its decision file (in the
 * broker-owned output dir) must say allowed, for THIS execution and revision, with the artifact
 * materialized in the broker-owned directory. argv[1] is the decision file.
 */
export const PROVENANCE_RESULT_CHECK_SCRIPT = [
  'const fs=require("fs");',
  'const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));',
  'const f=d&&d.facts;',
  'const ok=d&&d.result==="allowed"&&d.rule===null&&f&&f.executionId===process.env.OR_PIPELINE_EXECUTION_ID&&typeof f.executionId==="string"&&f.revision===process.env.OR_TRUSTED_SOURCE_REVISION&&typeof f.revision==="string"&&f.validatedArtifact&&f.validatedArtifact.extractedTo==="/tmp/open-reception-broker-work/validated";',
  'if(!ok){throw new Error("provenance decision missing, denied or not for this execution")}',
].join(' ');

/** The broker command that runs the verified target-stack module (S10a). */
export const TARGET_STACKS_COMMAND = `node ${TARGET_STACKS_LOCAL_PATH} --stacks ${TARGET_STACKS.map((t) => (t.region ? `${t.stackName}@${t.region}` : t.stackName)).join(',')}`;

/**
 * Broker: the target-stack decision (in the broker-owned output dir) must say allowed, for THIS
 * execution and revision, covering exactly the reviewed stacks. argv[1] is the decision file.
 */
export const TARGET_STACKS_RESULT_CHECK_SCRIPT = [
  'const fs=require("fs");',
  'const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));',
  `const expected=${JSON.stringify(TARGET_STACKS.map((t) => t.stackName).join(','))};`,
  'const ok=d&&d.result==="allowed"&&d.rule===null&&typeof d.executionId==="string"&&d.executionId===process.env.OR_PIPELINE_EXECUTION_ID&&typeof d.revision==="string"&&d.revision===process.env.OR_TRUSTED_SOURCE_REVISION&&Array.isArray(d.stacks)&&d.stacks.map((s)=>s&&s.stackName).join(",")===expected;',
  'if(!ok){throw new Error("target stack decision missing, denied or not for this execution")}',
].join(' ');

/** Trusted revision shape: a full 40-hex commit SHA (short or missing values fail closed). */
const FULL_SHA_CHECK =
  'const isFullSha=(v)=>typeof v==="string"&&/^[0-9a-f]{40}$/.test(v);';

/**
 * Broker: candidate-produced evidence must name exactly the trusted pipeline CommitId.
 * Both sides must be full 40-hex SHAs; a stale/substituted artifact that declares another
 * revision, a short SHA, or no revision is rejected before the policy runs.
 */
export const BROKER_REVISION_CHECK_SCRIPT = [
  'const fs=require("fs");',
  FULL_SHA_CHECK,
  'if(typeof process.argv[1]!=="string"||!process.argv[1]){throw new Error("evidence path missing")}',
  'const e=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));',
  'const trusted=process.env.OR_TRUSTED_SOURCE_REVISION;',
  'if(!isFullSha(trusted)){throw new Error("trusted source revision missing or invalid")}',
  'if(e===null||typeof e!=="object"||e.schemaVersion!==1||!isFullSha(e.sourceRevision)||e.sourceRevision!==trusted){throw new Error("validation evidence revision mismatch")}',
].join(' ');

/**
 * Broker: verify the downloaded trusted policy before executing it.
 *
 * The object lives in the shared CDK bootstrap asset bucket, so read access is not exclusive to
 * the broker role and any principal with write access to that bucket could replace it. The
 * content SHA-256 pinned at synth (`OR_TRUSTED_POLICY_SHA256`) is the control: a missing or
 * malformed pin, a missing file, or any byte difference fails closed before `node` runs it.
 * The file path is `process.argv[1]`.
 */
export const BROKER_POLICY_HASH_CHECK_SCRIPT = [
  'const fs=require("fs");',
  'const crypto=require("crypto");',
  'const expected=process.env.OR_TRUSTED_POLICY_SHA256;',
  'if(typeof expected!=="string"||!/^[0-9a-f]{64}$/.test(expected)){throw new Error("trusted policy sha256 pin missing or invalid")}',
  'const file=process.argv[1];',
  'if(typeof file!=="string"||!file){throw new Error("trusted policy path missing")}',
  'const actual=crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");',
  'if(actual!==expected){throw new Error("trusted policy sha256 mismatch")}',
].join(' ');

/**
 * Broker: even an allowed static assembly cannot mutate yet.
 *
 * Emits the Foundation safe-dev-deploy S11 minimum shape. `source_revision` is the trusted
 * CodePipeline CommitId; `attempt_id` is the CodeBuild build id (unique per attempt, so two
 * attempts on one revision differ); `decided_at` is the broker clock; `policy_version` binds the
 * decision to the stack-owned policy (`POLICY_VERSION` reported by the trusted policy run, plus
 * the synth-time content SHA-256 of the policy file, verified before the policy ran). Missing inputs fail closed (no result file).
 */
export const BROKER_NOT_ARMED_RESULT_SCRIPT = [
  'const fs=require("fs");',
  FULL_SHA_CHECK,
  'const sourceRevision=process.env.OR_TRUSTED_SOURCE_REVISION;',
  'if(!isFullSha(sourceRevision)){throw new Error("trusted source revision missing or invalid")}',
  'const attemptId=process.env.CODEBUILD_BUILD_ID;',
  'if(typeof attemptId!=="string"||!attemptId){throw new Error("attempt id missing")}',
  'const policySha256=process.env.OR_TRUSTED_POLICY_SHA256;',
  'if(typeof policySha256!=="string"||!/^[0-9a-f]{64}$/.test(policySha256)){throw new Error("trusted policy sha256 missing or invalid")}',
  'if(typeof process.argv[1]!=="string"||!process.argv[1]||typeof process.argv[2]!=="string"||!process.argv[2]){throw new Error("result paths missing")}',
  'const policy=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));',
  'if(policy===null||typeof policy!=="object"||policy.result!=="allowed"||!Number.isInteger(policy.policyVersion)){throw new Error("trusted policy result missing or not allowed")}',
  'const result={result:"denied",source_revision:sourceRevision,attempt_id:attemptId,decided_at:new Date().toISOString(),policy_version:"trusted-policy@"+policy.policyVersion+"+sha256:"+policySha256,stage:"broker-bootstrap",rule:"BROKER_NOT_ARMED",resource:null,reason:"Static trusted policy passed, but sparse ledger/live ChangeSet/role chain are intentionally not armed",retryable:false,evidence_ref:process.env.CODEBUILD_BUILD_ARN||"unknown"};',
  'fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2),{flag:"wx"});',
  'console.log(JSON.stringify(result));',
].join(' ');

export class DevDeployBrokerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Pre-arming blocker 3: refuse to synthesize for any account but the pinned one. (A
    // CloudFormation rule on AWS::AccountId was considered and left out: whether CloudFormation
    // evaluates a rule that references no parameter is unverified, and a wrong guess either does
    // nothing or breaks the human deploy.) An environment-agnostic synth is still possible; the
    // broker's first command then refuses to run in any other account.
    if (!cdk.Token.isUnresolved(this.account) && this.account !== DEV_DEPLOY_TARGET_ACCOUNT) {
      throw new Error(`DevDeployBrokerStack must be deployed to ${DEV_DEPLOY_TARGET_ACCOUNT}, not ${this.account}`);
    }

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

    // S5a: the human override channel. The owner names the role at deploy time; it is the only
    // principal besides the broker that the ledger accepts writes from.
    const overrideIssuerRoleArn = new cdk.CfnParameter(this, 'SparseLedgerOverrideIssuerRoleArn', {
      type: 'String',
      description:
        'IAM role ARN (this account) that a human uses to initialise the sparse ledger and issue one-shot overrides. Never a Claude/candidate role.',
      allowedPattern: HUMAN_ROLE_ARN_PATTERN,
    });

    // The CloudFormation execution role a human uses to deploy/update THIS stack. It is the only
    // principal besides the issuer allowed to change the ledger's configuration.
    const stackDeployRoleArn = new cdk.CfnParameter(this, 'SparseLedgerStackDeployRoleArn', {
      type: 'String',
      description:
        'IAM role ARN (this account) CloudFormation uses when a human deploys this stack (e.g. the admin CDK bootstrap cfn-exec role). Never a Claude/candidate role.',
      allowedPattern: HUMAN_ROLE_ARN_PATTERN,
    });

    // The ledger instance the broker accepts (#1153). The human writes the genesis item with this
    // exact id; a missing or different genesis (table emptied or replaced) is SPARSE_LEDGER_CORRUPT.
    // Not a secret; chosen by the owner at deploy.
    const sparseLedgerId = new cdk.CfnParameter(this, 'SparseLedgerId', {
      type: 'String',
      description: 'Ledger instance id pinned in the broker; the human-written genesis item must carry the same id.',
      allowedPattern: LEDGER_ID_PATTERN,
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

    // Published to the shared CDK bootstrap asset bucket when the human-managed broker stack is
    // deployed. Candidate pipeline artifacts never supply the trusted policy implementation.
    // Read access to that bucket is not exclusive to the broker, so the broker pins and verifies
    // the file's content SHA-256 (computed here from the same source file) before executing it.
    const trustedPolicyAsset = new s3assets.Asset(this, 'TrustedPolicyAsset', {
      path: TRUSTED_POLICY_SOURCE_PATH,
    });
    const trustedPolicyContentSha256 = trustedPolicySha256();
    trustedPolicyAsset.grantRead(brokerRole);
    const provenanceAsset = new s3assets.Asset(this, 'ProvenanceModuleAsset', {
      path: PROVENANCE_SOURCE_PATH,
    });
    provenanceAsset.grantRead(brokerRole);
    const ledgerModuleAsset = new s3assets.Asset(this, 'LedgerModuleAsset', { path: LEDGER_MODULE_SOURCE_PATH });
    const ledgerRunnerAsset = new s3assets.Asset(this, 'LedgerRunnerAsset', { path: LEDGER_RUNNER_SOURCE_PATH });
    ledgerModuleAsset.grantRead(brokerRole);
    ledgerRunnerAsset.grantRead(brokerRole);
    const targetStacksAsset = new s3assets.Asset(this, 'TargetStacksModuleAsset', { path: TARGET_STACKS_SOURCE_PATH });
    targetStacksAsset.grantRead(brokerRole);

    // Sparse dev-deploy attempt ledger (#1153, Foundation S6a): state in the trusted account,
    // writable only by the broker. The Validation role (candidate code) gets no statement on it.
    // Not armed yet: nothing in the broker buildspec reads or writes it until mutation is armed
    // (unarmed runs never reach the mutation boundary, so there is no attempt to count).
    // No fixed physical name (avoids the recreate collision recorded as pre-arming blocker 6).
    const sparseLedger = new dynamodb.Table(this, 'SparseDeployLedger', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // A table resource policy cannot name its own ARN (circular); '*' here means this table.
      resourcePolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'DenyLedgerWritesExceptBrokerAndHumanIssuer',
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: [...SPARSE_LEDGER_PROTECTED_WRITES],
            resources: ['*'],
            conditions: {
              ArnNotEquals: {
                'aws:PrincipalArn': [brokerRole.roleArn, overrideIssuerRoleArn.valueAsString],
              },
            },
          }),
          new iam.PolicyStatement({
            sid: 'DenyLedgerControlExceptHumanRoles',
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: [...SPARSE_LEDGER_PROTECTED_CONTROL],
            resources: ['*'],
            conditions: {
              ArnNotEquals: {
                'aws:PrincipalArn': [overrideIssuerRoleArn.valueAsString, stackDeployRoleArn.valueAsString],
              },
            },
          }),
        ],
      }),
    });
    // Write data events of the ledger table only (no management events: the account's own trail
    // covers those, and a second copy would be billed). Log file validation makes deletion or
    // editing of delivered files detectable; versioning keeps overwritten files.
    const ledgerAuditBucket = new s3.Bucket(this, 'LedgerAuditLogs', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'KeepLedgerAudit',
          enabled: true,
          expiration: cdk.Duration.days(LEDGER_AUDIT_RETENTION_DAYS),
          noncurrentVersionExpiration: cdk.Duration.days(LEDGER_AUDIT_RETENTION_DAYS),
        },
      ],
    });
    const ledgerTrailArn = cdk.Stack.of(this).formatArn({
      service: 'cloudtrail',
      resource: 'trail',
      resourceName: LEDGER_AUDIT_TRAIL_NAME,
    });
    ledgerAuditBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'CloudTrailAclCheck',
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['s3:GetBucketAcl'],
        resources: [ledgerAuditBucket.bucketArn],
        conditions: { StringEquals: { 'aws:SourceArn': ledgerTrailArn } },
      }),
    );
    ledgerAuditBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'CloudTrailWrite',
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [ledgerAuditBucket.arnForObjects(`AWSLogs/${cdk.Aws.ACCOUNT_ID}/*`)],
        conditions: {
          StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceArn': ledgerTrailArn },
        },
      }),
    );
    // Nobody but the human stack-deploy role may erase history or change the bucket's protection.
    ledgerAuditBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyAuditHistoryRewrite',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: [...LEDGER_AUDIT_PROTECTED_ACTIONS],
        resources: [ledgerAuditBucket.bucketArn, ledgerAuditBucket.arnForObjects('*')],
        conditions: { ArnNotEquals: { 'aws:PrincipalArn': [stackDeployRoleArn.valueAsString] } },
      }),
    );
    // Identity-based s3:PutObject elsewhere in the account would otherwise let any principal add
    // objects to this trail-only store (an Allow here is not an allowlist). Only a request made on
    // behalf of this trail (aws:SourceArn is set by CloudTrail) may write.
    ledgerAuditBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyWritesExceptThisTrail',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [ledgerAuditBucket.arnForObjects('*')],
        conditions: { StringNotEqualsIfExists: { 'aws:SourceArn': ledgerTrailArn } },
      }),
    );
    // The protection must outlive a stack deletion as long as the retained logs do.
    ledgerAuditBucket.policy!.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const ledgerTrail = new cloudtrail.CfnTrail(this, 'LedgerDataEventsTrail', {
      trailName: LEDGER_AUDIT_TRAIL_NAME,
      isLogging: true,
      s3BucketName: ledgerAuditBucket.bucketName,
      enableLogFileValidation: true,
      isMultiRegionTrail: false,
      includeGlobalServiceEvents: false,
      advancedEventSelectors: [
        {
          name: 'SparseLedgerWrites',
          fieldSelectors: [
            { field: 'eventCategory', equalTo: ['Data'] },
            { field: 'resources.type', equalTo: ['AWS::DynamoDB::Table'] },
            { field: 'resources.ARN', equalTo: [sparseLedger.tableArn] },
            { field: 'readOnly', equalTo: ['false'] },
          ],
        },
      ],
    });
    ledgerTrail.node.addDependency(ledgerAuditBucket.policy!);

    brokerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [...SPARSE_LEDGER_BROKER_ACTIONS],
        resources: [sparseLedger.tableArn],
        conditions: {
          'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [SPARSE_LEDGER_PROJECT_KEY] },
        },
      }),
    );

    // Build logs are audit evidence, so they outlive the stack (RETAIN). They have no fixed name
    // (pre-arming blocker 6): a retained group with a fixed name makes deleting and recreating
    // the stack fail on a name conflict. The names below that stay fixed (roles, projects,
    // pipeline) are deleted with the stack and give the future ADR 0009 trust a stable ARN.
    const validationLogs = new logs.LogGroup(this, 'ValidationLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const brokerLogs = new logs.LogGroup(this, 'BrokerLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Pipeline artifacts are candidate output (source archive, cloud assembly). They are only
    // useful to the execution that produced them, so they expire (pre-arming blocker 5): no
    // unbounded cost, and no long-lived pool of stale artifacts for a later execution to reuse.
    // Same encryption / public-access / TLS settings as the CDK default pipeline bucket.
    // Versioned (pre-arming blocker 2): an overwrite by candidate code leaves a second version,
    // which the broker's provenance check detects; deletes are denied to both build roles below.
    const artifactBucket = new s3.Bucket(this, 'PipelineArtifacts', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'ExpireCandidateArtifacts',
          enabled: true,
          expiration: cdk.Duration.days(PIPELINE_ARTIFACT_RETENTION_DAYS),
          noncurrentVersionExpiration: cdk.Duration.days(PIPELINE_ARTIFACT_RETENTION_DAYS),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
        {
          // Current-version expiry leaves a delete marker per key; remove it once it is alone.
          id: 'RemoveExpiredDeleteMarkers',
          enabled: true,
          expiredObjectDeleteMarker: true,
        },
      ],
    });

    for (const role of [validationRole, brokerRole]) {
      role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: [...ARTIFACT_HISTORY_WRITES],
          resources: [artifactBucket.bucketArn, artifactBucket.arnForObjects('*')],
        }),
      );
    }
    brokerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [...PROVENANCE_READ_ACTIONS.artifactBucket],
        resources: [artifactBucket.bucketArn],
      }),
    );

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
          OR_BROKER_TARGET_ACCOUNT: { value: DEV_DEPLOY_TARGET_ACCOUNT },
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
              nodeEval(VALIDATION_EVIDENCE_SCRIPT),
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
          OR_BROKER_TARGET_ACCOUNT: { value: DEV_DEPLOY_TARGET_ACCOUNT },
          OR_TRUSTED_POLICY_BUCKET: { value: trustedPolicyAsset.s3BucketName },
          OR_TRUSTED_POLICY_KEY: { value: trustedPolicyAsset.s3ObjectKey },
          OR_TRUSTED_POLICY_SHA256: { value: trustedPolicyContentSha256 },
          OR_PROVENANCE_MODULE_BUCKET: { value: provenanceAsset.s3BucketName },
          OR_PROVENANCE_MODULE_KEY: { value: provenanceAsset.s3ObjectKey },
          OR_PROVENANCE_MODULE_SHA256: { value: trustedPolicySha256(PROVENANCE_SOURCE_PATH) },
          OR_PIPELINE_ARTIFACT_BUCKET: { value: artifactBucket.bucketName },
          OR_LEDGER_MODULE_BUCKET: { value: ledgerModuleAsset.s3BucketName },
          OR_LEDGER_MODULE_KEY: { value: ledgerModuleAsset.s3ObjectKey },
          OR_LEDGER_MODULE_SHA256: { value: trustedPolicySha256(LEDGER_MODULE_SOURCE_PATH) },
          OR_LEDGER_RUNNER_BUCKET: { value: ledgerRunnerAsset.s3BucketName },
          OR_LEDGER_RUNNER_KEY: { value: ledgerRunnerAsset.s3ObjectKey },
          OR_LEDGER_RUNNER_SHA256: { value: trustedPolicySha256(LEDGER_RUNNER_SOURCE_PATH) },
          OR_SPARSE_LEDGER_TABLE: { value: sparseLedger.tableName },
          OR_SPARSE_LEDGER_ID: { value: sparseLedgerId.valueAsString },
          OR_TARGET_STACKS_MODULE_BUCKET: { value: targetStacksAsset.s3BucketName },
          OR_TARGET_STACKS_MODULE_KEY: { value: targetStacksAsset.s3ObjectKey },
          OR_TARGET_STACKS_MODULE_SHA256: { value: trustedPolicySha256(TARGET_STACKS_SOURCE_PATH) },
          OR_BROKER_TARGET_REGION: { value: cdk.Aws.REGION },
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
              nodeEval(BROKER_ACCOUNT_PIN_CHECK_SCRIPT),
              // Broker-owned output dir; fails if anything already exists there.
              `mkdir -m 700 ${BROKER_OUT_DIR}`,
              // Ledger modules first, so every later gate's denial can be audited (see finally).
              `mkdir -p ${LEDGER_LOCAL_DIR}`,
              `aws s3 cp "s3://$OR_LEDGER_MODULE_BUCKET/$OR_LEDGER_MODULE_KEY" ${LEDGER_MODULE_LOCAL_PATH} --only-show-errors`,
              nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, LEDGER_MODULE_LOCAL_PATH, 'OR_LEDGER_MODULE_SHA256'),
              `aws s3 cp "s3://$OR_LEDGER_RUNNER_BUCKET/$OR_LEDGER_RUNNER_KEY" ${LEDGER_RUNNER_LOCAL_PATH} --only-show-errors`,
              nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, LEDGER_RUNNER_LOCAL_PATH, 'OR_LEDGER_RUNNER_SHA256'),
              // A failed download / hash check of a trusted module is an integrity event, not a denial
              // of the candidate by that gate.
              gateCommand('BROKER_MODULE_INTEGRITY'),
              // Blockers 2 / 4: prove the input artifacts are the single versions this execution's
              // own actions wrote, and that this execution is the newest and fresh, before any
              // candidate file is read.
              `aws s3 cp "s3://$OR_PROVENANCE_MODULE_BUCKET/$OR_PROVENANCE_MODULE_KEY" ${PROVENANCE_LOCAL_PATH} --only-show-errors`,
              nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, PROVENANCE_LOCAL_PATH, 'OR_PROVENANCE_MODULE_SHA256'),
              gateCommand('TRUSTED_PROVENANCE_DENIED'),
              PROVENANCE_COMMAND,
              nodeEval(PROVENANCE_RESULT_CHECK_SCRIPT, PROVENANCE_DECISION_PATH),
              gateCommand('TRUSTED_REVISION_MISMATCH'),
              // From here on, only the materialized, provenance-bound artifact is read.
              `test -f ${BROKER_EVIDENCE_PATH}`,
              `test -f ${BROKER_ASSEMBLY_DIR}/manifest.json`,
              nodeEval(BROKER_REVISION_CHECK_SCRIPT, BROKER_EVIDENCE_PATH),
              gateCommand('BROKER_MODULE_INTEGRITY'),
              // Download policy by the S3 location injected by this stack, then verify the pinned
              // content SHA-256 before executing it (fail closed on any mismatch).
              `aws s3 cp "s3://$OR_TRUSTED_POLICY_BUCKET/$OR_TRUSTED_POLICY_KEY" ${TRUSTED_POLICY_LOCAL_PATH} --only-show-errors`,
              nodeEval(BROKER_POLICY_HASH_CHECK_SCRIPT, TRUSTED_POLICY_LOCAL_PATH),
              gateCommand('TRUSTED_POLICY_DENIED'),
              `node ${TRUSTED_POLICY_LOCAL_PATH} --assembly ${BROKER_ASSEMBLY_DIR} --account ${DEV_DEPLOY_TARGET_ACCOUNT} > ${POLICY_RESULT_PATH}`,
              // S10a: a target stack that is mid-operation or in a failed (rollback) state blocks
              // automated attempts until a human resolves it; audited as a denial, no budget.
              gateCommand('BROKER_MODULE_INTEGRITY'),
              `aws s3 cp "s3://$OR_TARGET_STACKS_MODULE_BUCKET/$OR_TARGET_STACKS_MODULE_KEY" ${TARGET_STACKS_LOCAL_PATH} --only-show-errors`,
              nodeEval(BROKER_MODULE_HASH_CHECK_SCRIPT, TARGET_STACKS_LOCAL_PATH, 'OR_TARGET_STACKS_MODULE_SHA256'),
              gateCommand('TARGET_STACK_NOT_STABLE'),
              TARGET_STACKS_COMMAND,
              nodeEval(TARGET_STACKS_RESULT_CHECK_SCRIPT, TARGET_STACKS_DECISION_PATH),
              // Even an allowed static assembly cannot mutate yet. When armed, the live ChangeSet
              // gate and then `ledger-runner.mjs reserve` (the last deny-capable step) go here,
              // and `outcome` after the mutation.
              gateCommand('BROKER_NOT_ARMED'),
              nodeEval(BROKER_NOT_ARMED_RESULT_SCRIPT, POLICY_RESULT_PATH, BROKER_RESULT_PATH),
              'echo "Trusted broker is intentionally unarmed." >&2',
              'exit 42',
            ],
            finally: [LEDGER_DENY_COMMAND],
          },
        },
      }),
    });

    // Alerts (no subscription here: the owner subscribes a human endpoint after deploy).
    const brokerAlerts = new sns.Topic(this, 'BrokerAlerts', {
      displayName: 'open-reception dev deploy broker alerts',
      enforceSSL: true,
    });
    const ledgerAttention = new logs.MetricFilter(this, 'LedgerAttentionFilter', {
      logGroup: brokerLogs,
      metricNamespace: 'OpenReception/DevDeployBroker',
      metricName: 'LedgerAttention',
      metricValue: '1',
      filterPattern: logs.FilterPattern.any(
        ...LEDGER_ATTENTION_EVENTS.map((e) => logs.FilterPattern.stringValue('$.event', '=', e)),
        logs.FilterPattern.booleanValue('$.audited', false),
        ...ESCALATION_RULES.map((r) => logs.FilterPattern.stringValue('$.rule', '=', r)),
      ),
    });
    const ledgerAttentionAlarm = new cloudwatch.Alarm(this, 'LedgerAttentionAlarm', {
      metric: ledgerAttention.metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'A sparse-ledger attempt may be left in_progress (ambiguous reservation / unrecorded outcome / runner error), a denial went unaudited, or a denial needs a human (unstable target stack / repeated failure of one revision, S10a). See docs/architecture/aws-dev-deploy-broker.md.',
    });
    ledgerAttentionAlarm.addAlarmAction(new cwActions.SnsAction(brokerAlerts));
    // The topic's resource policy (created for EventBridge / TLS) replaces the default one, so
    // CloudWatch is named explicitly, bound to this alarm.
    brokerAlerts.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBrokerAlarmPublish',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [brokerAlerts.topicArn],
        conditions: {
          ArnEquals: { 'aws:SourceArn': ledgerAttentionAlarm.alarmArn },
          StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
        },
      }),
    );

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: PIPELINE_NAME,
      pipelineType: codepipeline.PipelineType.V1,
      artifactBucket,
      crossAccountKeys: false,
      restartExecutionOnUpdate: false,
    });

    const source = new codepipeline.Artifact('Source');
    const validated = new codepipeline.Artifact('Validated');

    const sourceAction = new actions.CodeStarConnectionsSourceAction({
      actionName: 'PromotionBranch',
      owner: '20m61',
      repo: 'open-reception',
      branch: DEV_DEPLOY_PROMOTION_BRANCH,
      connectionArn: githubConnectionArn.valueAsString,
      output: source,
      triggerOnPush: true,
      variablesNamespace: 'OpenReceptionSource',
    });

    pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction],
    });

    pipeline.addStage({
      stageName: 'Validate',
      actions: [
        new actions.CodeBuildAction({
          actionName: 'UnprivilegedValidation',
          project: validationProject,
          input: source,
          outputs: [validated],
          environmentVariables: {
            // Trusted source metadata comes from the CodeConnections action, not candidate files.
            OR_TRUSTED_SOURCE_REVISION: {
              type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
              value: sourceAction.variables.commitId,
            },
          },
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
          environmentVariables: {
            // Set by CodePipeline for this run; the provenance check reads the execution by it.
            OR_PIPELINE_EXECUTION_ID: {
              type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
              value: '#{codepipeline.PipelineExecutionId}',
            },
            OR_TRUSTED_SOURCE_REVISION: {
              type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
              value: sourceAction.variables.commitId,
            },
          },
        }),
      ],
    });

    // A broker build that times out, is stopped or faults never reaches its own bookkeeping.
    new events.Rule(this, 'BrokerBuildAbortedRule', {
      description: 'Broker build ended without finishing (a reserved attempt may stay in_progress).',
      eventPattern: {
        source: ['aws.codebuild'],
        detailType: ['CodeBuild Build State Change'],
        detail: {
          'project-name': [BROKER_PROJECT_NAME],
          'build-status': [...BROKER_ABORT_STATES],
        },
      },
      targets: [new eventTargets.SnsTopic(brokerAlerts)],
    });
    new events.Rule(this, 'BrokerPhaseAbortedRule', {
      description: 'A broker build phase timed out, was stopped or faulted (its bookkeeping may not have run).',
      eventPattern: {
        source: ['aws.codebuild'],
        detailType: ['CodeBuild Build Phase Change'],
        detail: {
          'project-name': [BROKER_PROJECT_NAME],
          'completed-phase-status': [...BROKER_ABORT_STATES],
        },
      },
      targets: [new eventTargets.SnsTopic(brokerAlerts)],
    });

    brokerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [...PROVENANCE_READ_ACTIONS.pipeline],
        resources: [pipeline.pipelineArn],
      }),
    );
    brokerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [...PROVENANCE_READ_ACTIONS.validationBuild],
        resources: [validationProject.projectArn],
      }),
    );

    brokerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [...TARGET_STACK_READ_ACTIONS],
        resources: TARGET_STACKS.map((t) =>
          cdk.Stack.of(this).formatArn({ service: 'cloudformation', region: t.region ?? undefined, resource: 'stack', resourceName: `${t.stackName}/*` }),
        ),
      }),
    );

    cdk.Tags.of(this).add('Project', 'open-reception');
    cdk.Tags.of(this).add('Environment', 'dev');
    cdk.Tags.of(this).add('Component', 'dev-deploy-broker');
    cdk.Tags.of(this).add('ManagedBy', 'cdk');
  }
}
