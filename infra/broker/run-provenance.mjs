#!/usr/bin/env node
/**
 * Execution provenance and freshness for the trusted dev-deploy broker (#1146, pre-arming
 * blockers 2 and 4 in docs/architecture/aws-dev-deploy-broker.md).
 *
 * Blocker 2 (artifact substitution): the Validation role runs candidate code and can write the
 * pipeline artifact bucket, so candidate code of one execution could overwrite another
 * execution's source archive or cloud assembly. The bucket is versioned and nobody but S3
 * lifecycle can delete a version, so every overwrite leaves a second version behind. This check
 * accepts the broker's input only when, for THIS pipeline execution:
 * - the Source action succeeded, recorded the trusted CommitId, and its output object has
 *   exactly one version, written while that action ran;
 * - exactly one Validate action succeeded, its CodeBuild build is the validation project and
 *   succeeded, and its output object has exactly one version, written while that build ran;
 * - the broker action in progress reads exactly that validated object;
 * - this build is that action's build: CodeBuild's own record of THIS build (BatchGetBuilds on
 *   CODEBUILD_BUILD_ID) shows it in progress, in the broker project, started by this pipeline
 *   (`initiator` is exactly `codepipeline/<pipeline name>`) no earlier than the action started.
 *   Run 5 of #1146 runbook 7.5 showed the in-progress action has no build id to compare with.
 *   This denies a build started outside the pipeline (a retried or hand-started build carrying a
 *   copied execution id). It does NOT stop a principal that can StartBuild with overrides
 *   (buildspec or environment): such a build need not run this check at all. That boundary is
 *   IAM (who may start, retry or update the broker project / pipeline), an arming requirement.
 * A substituted object (a second version, a delete marker, a version written outside the
 * producing action) is denied. The time windows are a second line; the single version is the
 * control.
 *
 * Blocker 4 (stale retry): retrying an old BrokerBoundary stage re-runs with that execution's
 * CommitId and artifacts. The execution must be the newest execution of the pipeline (the
 * promotion pointer has not moved and nobody started another run) and must have started less
 * than MAX_EXECUTION_AGE_MS ago.
 *
 * The decision (`evaluateProvenance`) is a pure function over the JSON the AWS APIs return, so
 * it is tested offline. The CLI gathers that JSON with the AWS CLI (execFileSync, no shell) and
 * fails closed on any error: an unverifiable provenance is a denial.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROVENANCE_VERSION = 2;

/** The broker's CodeBuild project (mirrors the stack; pinned by test). */
export const BROKER_PROJECT_NAME = 'OpenReceptionTrustedDevDeployBroker';

/** A retried broker stage may reuse its execution for at most this long after the execution started. */
export const MAX_EXECUTION_AGE_MS = 12 * 60 * 60 * 1000;

/** S3 LastModified has one-second resolution; service clocks differ slightly. */
export const CLOCK_TOLERANCE_MS = 5 * 1000;

/** How many recent executions are listed. The execution under evaluation must be the newest. */
export const RECENT_EXECUTIONS = 10;

/**
 * Trusted, broker-owned locations outside the candidate artifact tree. The broker never reads from
 * or writes into the tree CodeBuild extracted (a candidate symlink there could redirect a write
 * onto a verified module). Both directories must not exist yet (created exclusively).
 */
export const BROKER_WORK_DIR = '/tmp/open-reception-broker-work';
export const BROKER_OUT_DIR = '/tmp/open-reception-broker-out';
export const VALIDATED_DIR = `${BROKER_WORK_DIR}/validated`;
export const DECISION_PATH = `${BROKER_OUT_DIR}/provenance.json`;

/** Bounds on the materialized artifact (fail closed beyond them). */
export const MAX_ARTIFACT_ENTRIES = 50000;

export const RULES = Object.freeze({
  INPUT_INVALID: 'PROVENANCE_INPUT_INVALID',
  UNVERIFIABLE: 'PROVENANCE_UNVERIFIABLE',
  REVISION_MISMATCH: 'PIPELINE_REVISION_MISMATCH',
  STALE: 'PIPELINE_EXECUTION_STALE',
  ARTIFACT_SUBSTITUTED: 'ARTIFACT_PROVENANCE_MISMATCH',
  ARTIFACT_UNSAFE: 'ARTIFACT_CONTENT_UNSAFE',
});

const FULL_SHA = /^[0-9a-f]{40}$/;
const EXECUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

/**
 * Parse an AWS CLI timestamp (ISO 8601 with any fraction length and offset, or epoch seconds).
 * Returns epoch milliseconds or NaN.
 */
export function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value * 1000 : Number.NaN;
  if (typeof value !== 'string') return Number.NaN;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!m) return Number.NaN;
  const fraction = (m[2] ?? '').padEnd(3, '0').slice(0, 3);
  const offset = m[3] === 'Z' ? 'Z' : m[3].includes(':') ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  return Date.parse(`${m[1]}.${fraction}${offset}`);
}

const deny = (rule, reason, facts = {}) => ({ result: 'denied', rule, reason, facts });

const within = (t, start, end) =>
  Number.isFinite(t) && Number.isFinite(start) && Number.isFinite(end) && t >= start - CLOCK_TOLERANCE_MS && t <= end + CLOCK_TOLERANCE_MS;

/** Exactly one version and no delete marker for exactly this key. */
function singleVersion(versionsResponse, key) {
  if (!isRecord(versionsResponse)) return { ok: false, why: 'object version listing missing' };
  if (versionsResponse.IsTruncated === true) return { ok: false, why: 'object version listing truncated' };
  const versions = list(versionsResponse.Versions).filter((v) => isRecord(v) && v.Key === key);
  const markers = list(versionsResponse.DeleteMarkers).filter((v) => isRecord(v) && v.Key === key);
  if (markers.length > 0) return { ok: false, why: `${markers.length} delete marker(s) on the artifact` };
  if (versions.length !== 1) return { ok: false, why: `${versions.length} versions of the artifact (expected exactly 1)` };
  const [v] = versions;
  if (typeof v.VersionId !== 'string' || !v.VersionId || v.VersionId === 'null') {
    return { ok: false, why: 'artifact version is not a real version (bucket versioning off when written)' };
  }
  const lastModified = parseTime(v.LastModified);
  if (!Number.isFinite(lastModified)) return { ok: false, why: 'artifact version has no valid LastModified' };
  return { ok: true, versionId: v.VersionId, lastModified };
}

/** Presence and key names of an action's output (no values). */
function actionShape(action) {
  const shape = { output: isRecord(action.output) };
  if (shape.output) shape.outputKeys = Object.keys(action.output).sort();
  shape.executionResult = isRecord(action.output?.executionResult);
  if (shape.executionResult) shape.executionResultKeys = Object.keys(action.output.executionResult).sort();
  return shape;
}

const s3Location = (artifact) =>
  isRecord(artifact) && isRecord(artifact.s3location) && typeof artifact.s3location.bucket === 'string' && typeof artifact.s3location.key === 'string'
    ? { bucket: artifact.s3location.bucket, key: artifact.s3location.key }
    : null;

/**
 * Pure decision. `observed` is the raw AWS CLI JSON:
 * - `executions`: `codepipeline list-pipeline-executions`
 * - `actions`: `codepipeline list-action-executions --filter pipelineExecutionId=<id>`
 * - `validationBuilds`: `codebuild batch-get-builds --ids <validate build id>`
 * - `brokerBuilds`: `codebuild batch-get-builds --ids <CODEBUILD_BUILD_ID>` (this build)
 * - `bucketVersioning`: `s3api get-bucket-versioning`
 * - `sourceVersions` / `validatedVersions`: `s3api list-object-versions --prefix <key>`
 */
export function evaluateProvenance({ config, now, observed }) {
  const { pipelineName, executionId, revision, stages, validationProject, brokerProject, artifactBucket, buildId: brokerBuildId } = config ?? {};
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny(RULES.INPUT_INVALID, 'broker clock is not a valid time');
  if (!NAME.test(pipelineName ?? '') || !NAME.test(validationProject ?? '') || !NAME.test(brokerProject ?? '') || !NAME.test(artifactBucket ?? '')) {
    return deny(RULES.INPUT_INVALID, 'pipeline, project or artifact bucket name missing or malformed');
  }
  if (!isRecord(stages) || !['source', 'validate', 'broker'].every((k) => isRecord(stages[k]) && NAME.test(stages[k].stage ?? '') && NAME.test(stages[k].action ?? ''))) {
    return deny(RULES.INPUT_INVALID, 'stage / action names missing or malformed');
  }
  if (typeof executionId !== 'string' || !EXECUTION_ID.test(executionId)) return deny(RULES.INPUT_INVALID, 'pipeline execution id missing or malformed');
  if (typeof revision !== 'string' || !FULL_SHA.test(revision)) return deny(RULES.INPUT_INVALID, 'trusted source revision missing or malformed');
  if (typeof brokerBuildId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,254}$/.test(brokerBuildId)) {
    return deny(RULES.INPUT_INVALID, 'broker build id missing or malformed');
  }
  const facts = { provenanceVersion: PROVENANCE_VERSION, pipelineName, executionId, revision };
  const nowMs = now.getTime();

  // --- Blocker 4: this execution is the newest one and is fresh -------------------------------
  const summaries = list(observed?.executions?.pipelineExecutionSummaries).filter(isRecord);
  const mine = summaries.filter((s) => s.pipelineExecutionId === executionId);
  if (mine.length !== 1) {
    return deny(RULES.STALE, `execution ${executionId} is not among the ${RECENT_EXECUTIONS} most recent executions`, facts);
  }
  const started = parseTime(mine[0].startTime);
  if (!Number.isFinite(started)) return deny(RULES.UNVERIFIABLE, 'execution start time missing or malformed', facts);
  facts.executionStartedAt = new Date(started).toISOString();
  for (const other of summaries) {
    if (other === mine[0]) continue;
    const t = parseTime(other.startTime);
    if (!Number.isFinite(t) || t >= started) {
      return deny(RULES.STALE, `a newer (or unordered) execution ${String(other.pipelineExecutionId)} exists; the promotion moved on`, facts);
    }
  }
  if (started > nowMs + CLOCK_TOLERANCE_MS) return deny(RULES.UNVERIFIABLE, 'execution started in the future (clock skew)', facts);
  if (nowMs - started > MAX_EXECUTION_AGE_MS) {
    return deny(RULES.STALE, `execution started ${Math.round((nowMs - started) / 60000)} min ago (limit ${MAX_EXECUTION_AGE_MS / 60000} min)`, facts);
  }
  if (mine[0].status !== 'InProgress') return deny(RULES.STALE, `execution status is ${String(mine[0].status)}, not InProgress`, facts);
  const summaryRevisions = list(mine[0].sourceRevisions).filter(isRecord);
  if (summaryRevisions.length !== 1 || summaryRevisions[0].revisionId !== revision) {
    return deny(RULES.REVISION_MISMATCH, 'the execution\'s recorded source revision is not the trusted revision', facts);
  }

  // --- Blocker 2: each artifact is the single version its producing action wrote ---------------
  const actions = list(observed?.actions?.actionExecutionDetails).filter((a) => isRecord(a) && a.pipelineExecutionId === executionId);
  const pick = (which, status) =>
    actions.filter((a) => a.stageName === stages[which].stage && a.actionName === stages[which].action && a.status === status);
  const sources = pick('source', 'Succeeded');
  const validations = pick('validate', 'Succeeded');
  const brokers = pick('broker', 'InProgress');
  if (sources.length !== 1 || validations.length !== 1 || brokers.length !== 1) {
    return deny(RULES.UNVERIFIABLE, `expected one succeeded source, one succeeded validation and one in-progress broker action; found ${sources.length}/${validations.length}/${brokers.length}`, facts);
  }
  const [source] = sources;
  const [validation] = validations;
  const [broker] = brokers;
  // Observation only (never part of the decision): whether the in-progress action already shows
  // a build id. Presence and key names, no values.
  facts.observedBrokerActionShape = actionShape(broker);
  // This build must be the pipeline's build of that action, not one started outside the pipeline
  // with the execution id copied into its environment. CodeBuild records who started a build:
  // `codepipeline/<name>` for a pipeline, the user's name otherwise. Only the class is recorded
  // (a user name can be a person's e-mail address).
  const ownBuilds = list(observed?.brokerBuilds?.builds);
  const own = ownBuilds.length === 1 && isRecord(ownBuilds[0]) ? ownBuilds[0] : null;
  facts.brokerInitiator = own?.initiator === `codepipeline/${pipelineName}` ? 'pipeline' : 'other';
  if (own === null || own.id !== brokerBuildId || own.projectName !== brokerProject || own.buildStatus !== 'IN_PROGRESS') {
    return deny(RULES.UNVERIFIABLE, 'this build is not an in-progress build of the broker project', facts);
  }
  if (facts.brokerInitiator !== 'pipeline') {
    return deny(RULES.UNVERIFIABLE, 'this build was not started by this pipeline', facts);
  }
  const ownStart = parseTime(own.startTime);
  const actionStart = parseTime(broker.startTime);
  if (!Number.isFinite(ownStart) || !Number.isFinite(actionStart) || ownStart < actionStart - CLOCK_TOLERANCE_MS) {
    return deny(RULES.UNVERIFIABLE, 'this build did not start after the in-progress broker action started', facts);
  }
  const commitId = isRecord(source.output?.outputVariables) ? source.output.outputVariables.CommitId : undefined;
  if (commitId !== revision) return deny(RULES.REVISION_MISMATCH, 'the source action recorded another CommitId', facts);

  const sourceOut = list(source.output?.outputArtifacts).map(s3Location);
  const validationIn = list(validation.input?.inputArtifacts).map(s3Location);
  const validationOut = list(validation.output?.outputArtifacts).map(s3Location);
  const brokerIn = list(broker.input?.inputArtifacts).map(s3Location);
  if ([sourceOut, validationIn, validationOut, brokerIn].some((l) => l.length !== 1 || l[0] === null)) {
    return deny(RULES.UNVERIFIABLE, 'each action must have exactly one artifact with an S3 location', facts);
  }
  const same = (a, b) => a.bucket === b.bucket && a.key === b.key;
  if (!same(sourceOut[0], validationIn[0]) || !same(validationOut[0], brokerIn[0])) {
    return deny(RULES.ARTIFACT_SUBSTITUTED, 'an action read an artifact its predecessor in this execution did not write', facts);
  }
  if ([sourceOut[0], validationOut[0]].some((l) => l.bucket !== artifactBucket)) {
    return deny(RULES.ARTIFACT_SUBSTITUTED, 'artifact is outside the pipeline artifact bucket', facts);
  }
  if (!isRecord(observed?.bucketVersioning) || observed.bucketVersioning.Status !== 'Enabled') {
    return deny(RULES.UNVERIFIABLE, 'artifact bucket versioning is not Enabled', facts);
  }

  const buildId = isRecord(validation.output?.executionResult) ? validation.output.executionResult.externalExecutionId : undefined;
  const builds = list(observed?.validationBuilds?.builds).filter((b) => isRecord(b) && b.id === buildId);
  if (typeof buildId !== 'string' || builds.length !== 1) return deny(RULES.UNVERIFIABLE, 'validation build not found', facts);
  const [build] = builds;
  if (build.projectName !== validationProject || build.buildStatus !== 'SUCCEEDED') {
    return deny(RULES.UNVERIFIABLE, 'validation build is not a succeeded build of the validation project', facts);
  }
  const buildStart = parseTime(build.startTime);
  const buildEnd = parseTime(build.endTime);

  const sourceVersion = singleVersion(observed?.sourceVersions, sourceOut[0].key);
  if (!sourceVersion.ok) return deny(RULES.ARTIFACT_SUBSTITUTED, `source artifact: ${sourceVersion.why}`, facts);
  const sourceStart = parseTime(source.startTime);
  const sourceEnd = parseTime(source.lastUpdateTime);
  if (!within(sourceVersion.lastModified, sourceStart, sourceEnd)) {
    return deny(RULES.ARTIFACT_SUBSTITUTED, 'source artifact was not written while the source action ran', facts);
  }
  if (!(sourceVersion.lastModified <= buildStart + CLOCK_TOLERANCE_MS)) {
    return deny(RULES.ARTIFACT_SUBSTITUTED, 'source artifact was written after validation started', facts);
  }
  const validatedVersion = singleVersion(observed?.validatedVersions, validationOut[0].key);
  if (!validatedVersion.ok) return deny(RULES.ARTIFACT_SUBSTITUTED, `validated artifact: ${validatedVersion.why}`, facts);
  if (!within(validatedVersion.lastModified, buildStart, buildEnd)) {
    return deny(RULES.ARTIFACT_SUBSTITUTED, 'validated artifact was not written while the validation build ran', facts);
  }

  return {
    result: 'allowed',
    rule: null,
    reason: 'artifacts are the single versions written by this execution, which is the newest and fresh',
    facts: {
      ...facts,
      sourceArtifact: { ...sourceOut[0], versionId: sourceVersion.versionId },
      validatedArtifact: { ...validationOut[0], versionId: validatedVersion.versionId },
      validationBuildId: buildId,
    },
  };
}

// --- CLI: gather the evidence with the AWS CLI, then decide -----------------------------------

/**
 * Resolve a tool from the ABSOLUTE entries of PATH only. The broker's working directory is the
 * candidate tree, so an empty or relative PATH entry must never resolve `aws` / `unzip` there.
 */
export function resolveTool(name, pathValue = process.env.PATH ?? '') {
  for (const dir of pathValue.split(':')) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  throw new Error(`${name} not found on an absolute PATH entry`);
}

const awsJson = (args) =>
  JSON.parse(execFileSync(resolveTool('aws'), [...args, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }));

/** Gather `observed` for evaluateProvenance. Throws on any AWS / parse error (the caller denies). */
export function gather(config, runAws = awsJson) {
  const { pipelineName, executionId, stages, artifactBucket } = config;
  const observed = {};
  observed.executions = runAws(['codepipeline', 'list-pipeline-executions', '--pipeline-name', pipelineName, '--max-items', String(RECENT_EXECUTIONS)]);
  observed.actions = runAws(['codepipeline', 'list-action-executions', '--pipeline-name', pipelineName, '--filter', `pipelineExecutionId=${executionId}`]);
  const actions = list(observed.actions?.actionExecutionDetails).filter((a) => isRecord(a) && a.pipelineExecutionId === executionId);
  const one = (which, status) => {
    const found = actions.filter((a) => a.stageName === stages[which].stage && a.actionName === stages[which].action && a.status === status);
    if (found.length !== 1) throw new Error(`expected one ${status} ${which} action, found ${found.length}`);
    return found[0];
  };
  const source = one('source', 'Succeeded');
  const validation = one('validate', 'Succeeded');
  const buildId = validation.output?.executionResult?.externalExecutionId;
  if (typeof buildId !== 'string' || !buildId) throw new Error('validation build id missing');
  observed.validationBuilds = runAws(['codebuild', 'batch-get-builds', '--ids', buildId]);
  // This build's own record (who started it), never mixed with the validation build's.
  observed.brokerBuilds = runAws(['codebuild', 'batch-get-builds', '--ids', config.buildId]);
  observed.bucketVersioning = runAws(['s3api', 'get-bucket-versioning', '--bucket', artifactBucket]);
  const keyOf = (action) => {
    const loc = s3Location(list(action.output?.outputArtifacts)[0]);
    if (!loc || loc.bucket !== artifactBucket) throw new Error('artifact location missing or outside the artifact bucket');
    return loc.key;
  };
  // The CLI paginates list-object-versions itself; a prefix equal to the full key also returns
  // longer keys, which singleVersion filters out.
  observed.sourceVersions = runAws(['s3api', 'list-object-versions', '--bucket', artifactBucket, '--prefix', keyOf(source)]);
  observed.validatedVersions = runAws(['s3api', 'list-object-versions', '--bucket', artifactBucket, '--prefix', keyOf(validation)]);
  return observed;
}

/**
 * Fetch EXACTLY the version the decision bound (not whatever CodeBuild downloaded), extract it
 * into a fresh broker-owned directory and refuse anything but plain files and directories. Every
 * later gate reads only from VALIDATED_DIR. Returns facts to add (content hash, entry count).
 */
export function materialize(decision, config, { runAws = awsJson, unzip = defaultUnzip, workDir = BROKER_WORK_DIR } = {}) {
  const artifact = decision.facts.validatedArtifact;
  fs.mkdirSync(workDir, { mode: 0o700 }); // throws if it already exists
  const zip = path.join(workDir, 'validated.zip');
  const dir = path.join(workDir, 'validated');
  const head = runAws(['s3api', 'get-object', '--bucket', config.artifactBucket, '--key', artifact.key, '--version-id', artifact.versionId, zip]);
  if (!isRecord(head) || head.VersionId !== artifact.versionId) throw new Error('fetched object is not the bound version');
  const sha256 = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  fs.mkdirSync(dir, { mode: 0o700 });
  const listedFiles = unzip(zip, dir);
  const extractedFiles = [];
  let entries = 0;
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const st = fs.lstatSync(full);
      entries += 1;
      if (entries > MAX_ARTIFACT_ENTRIES) throw Object.assign(new Error('artifact has too many entries'), { unsafe: true });
      if (st.isDirectory()) walk(full);
      else if (!st.isFile()) throw Object.assign(new Error(`artifact contains a non-regular entry: ${path.relative(dir, full)}`), { unsafe: true });
      else extractedFiles.push(path.relative(dir, full));
    }
  };
  walk(dir);
  // What the gates will read must be exactly what the archive lists (no dropped or renamed entry).
  if (!Array.isArray(listedFiles) || [...listedFiles].sort().join('\n') !== extractedFiles.sort().join('\n')) {
    throw Object.assign(new Error('extracted files differ from the archive listing'), { unsafe: true });
  }
  return { validatedArtifact: { ...artifact, sha256, entries, extractedTo: dir } };
}

/**
 * Entry names must be plain relative paths: no absolute path, no `..` or empty segment, no
 * backslash or control character, no duplicates (which copy would a gate see?). Checked on the
 * archive's own listing BEFORE extraction; Info-ZIP would silently strip `../` under -q.
 */
export function unsafeEntryName(names) {
  const seen = new Set();
  for (const name of names) {
    const bare = name.endsWith('/') ? name.slice(0, -1) : name;
    // Segment allowlist (the characters the real dev assembly uses, plus route-group parentheses):
    // zipinfo escapes control bytes and extraction drops them, so anything outside it could make
    // the listed name and the extracted name differ.
    if (!bare || bare.split('/').some((seg) => seg === '.' || seg === '..' || !SAFE_SEGMENT.test(seg))) return name || '(empty)';
    if (seen.has(bare)) return `${name} (duplicate)`;
    seen.add(bare);
  }
  return null;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._@+=,~()\[\]-]+$/;

/** Info-ZIP unzip: list, check the names, then extract (any non-zero status fails closed). */
function defaultUnzip(zip, dir) {
  const unzipBin = resolveTool('unzip');
  const names = execFileSync(unzipBin, ['-Z1', zip], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((n) => n.length > 0);
  const bad = unsafeEntryName(names);
  if (bad !== null) throw Object.assign(new Error(`artifact entry name is unsafe: ${bad}`), { unsafe: true });
  execFileSync(unzipBin, ['-q', '-n', zip, '-d', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  return names.filter((n) => !n.endsWith('/'));
}

function parseCli(argv, env = process.env) {
  const out = {};
  const names = { '--pipeline': 'pipelineName', '--validation-project': 'validationProject', '--artifact-bucket-env': 'artifactBucketEnv', '--stages': 'stages' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = names[argv[i]];
    if (!key) throw new Error(`unknown argument: ${argv[i]}`);
    out[key] = argv[++i] ?? '';
  }
  // --stages Source/PromotionBranch,Validate/UnprivilegedValidation,BrokerBoundary/TrustedBrokerUnarmed
  const parts = String(out.stages ?? '').split(',').map((p) => p.split('/'));
  if (parts.length !== 3 || parts.some((p) => p.length !== 2)) throw new Error('--stages must be source,validate,broker as Stage/Action');
  const [source, validate, broker] = parts.map(([stage, action]) => ({ stage, action }));
  if (!/^[A-Z][A-Z0-9_]*$/.test(out.artifactBucketEnv ?? '')) throw new Error('--artifact-bucket-env must name an environment variable');
  return {
    pipelineName: out.pipelineName,
    validationProject: out.validationProject,
    brokerProject: BROKER_PROJECT_NAME,
    artifactBucket: env[out.artifactBucketEnv],
    executionId: env.OR_PIPELINE_EXECUTION_ID,
    revision: env.OR_TRUSTED_SOURCE_REVISION,
    buildId: env.CODEBUILD_BUILD_ID,
    stages: { source, validate, broker },
  };
}

/**
 * Decide, materialize the bound artifact, and write the decision to DECISION_PATH (exclusive
 * create in the broker-owned output dir). Exit 0 only for an allowed, materialized artifact.
 */
export function runCli(argv, { now = new Date(), env = process.env, runAws = awsJson, unzip = defaultUnzip, workDir = BROKER_WORK_DIR, decisionPath = DECISION_PATH } = {}) {
  let decision;
  try {
    const config = parseCli(argv, env);
    const pre = evaluateProvenance({ config, now, observed: null });
    // Refuse malformed configuration before calling AWS at all.
    decision = pre.rule === RULES.INPUT_INVALID ? pre : evaluateProvenance({ config, now, observed: gather(config, runAws) });
    if (decision.result === 'allowed') {
      try {
        decision = { ...decision, facts: { ...decision.facts, ...materialize(decision, config, { runAws, unzip, workDir }) } };
      } catch (error) {
        decision = deny(error?.unsafe ? RULES.ARTIFACT_UNSAFE : RULES.UNVERIFIABLE, `bound artifact could not be materialized safely: ${error instanceof Error ? error.message : String(error)}`, decision.facts);
      }
    }
  } catch (error) {
    decision = deny(RULES.UNVERIFIABLE, `provenance could not be established: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = { ...decision, decidedAt: now.toISOString() };
  let exitCode = decision.result === 'allowed' ? 0 : 43;
  try {
    fs.writeFileSync(decisionPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    exitCode = 43; // the decision could not be recorded where the next gate reads it
  }
  return { exitCode, record };
}

function main() {
  const { exitCode, record } = runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  process.exitCode = exitCode;
}

/** Run as a program even when invoked through a symlinked path (e.g. a symlinked /tmp). */
const invokedDirectly = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main();
}
