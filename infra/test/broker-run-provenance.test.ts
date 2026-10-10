import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

/**
 * Pre-arming blockers 2 (artifact substitution) and 4 (stale retry): the broker's execution
 * provenance check (`infra/broker/run-provenance.mjs`). The decision is tested offline over the
 * JSON shapes the AWS CLI returns; the CLI is tested end-to-end with a fake `aws` on PATH.
 */

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const MODULE = resolve(__dirname, '../broker/run-provenance.mjs');
type Provenance = {
  evaluateProvenance: (a: { config: J; now: Date; observed: J | null }) => J;
  runCli: (argv: string[], o: J) => { exitCode: number; record: J };
  unsafeEntryName: (names: string[]) => string | null;
  resolveTool: (name: string, pathValue?: string) => string;
  BROKER_WORK_DIR: string;
  BROKER_OUT_DIR: string;
  VALIDATED_DIR: string;
  DECISION_PATH: string;
  gather: (config: J, runAws: (args: string[]) => J) => J;
  parseTime: (v: unknown) => number;
  RULES: Record<string, string>;
  MAX_EXECUTION_AGE_MS: number;
  CLOCK_TOLERANCE_MS: number;
  BROKER_PROJECT_NAME: string;
};
let mod: Provenance;
beforeAll(async () => {
  mod = (await import(pathToFileURL(MODULE).href)) as Provenance;
});

const REV = '0123456789abcdef0123456789abcdef01234567';
const OTHER_REV = 'f'.repeat(40);
const EXEC = '11111111-2222-4333-8444-555555555555';
const BUCKET = 'openreception-devdeploybroker-pipelineartifacts-abc';
const SOURCE_KEY = 'OpenReceptionSparseD/Source/AbC1234';
const VALIDATED_KEY = 'OpenReceptionSparseD/Validated/XyZ9876';
const BUILD_ID = 'OpenReceptionDevDeployValidation:6f1c7c1e-0000-4000-8000-000000000001';
const BROKER_BUILD_ID = 'OpenReceptionTrustedDevDeployBroker:7a2d8d2f-0000-4000-8000-000000000002';
const PIPELINE_INITIATOR = 'codepipeline/OpenReceptionSparseDevDeploy';
const STAGES = {
  source: { stage: 'Source', action: 'PromotionBranch' },
  validate: { stage: 'Validate', action: 'UnprivilegedValidation' },
  broker: { stage: 'BrokerBoundary', action: 'TrustedBrokerUnarmed' },
};
const config = (): J => ({
  pipelineName: 'OpenReceptionSparseDevDeploy',
  executionId: EXEC,
  revision: REV,
  stages: STAGES,
  validationProject: 'OpenReceptionDevDeployValidation',
  brokerProject: 'OpenReceptionTrustedDevDeployBroker',
  artifactBucket: BUCKET,
  buildId: BROKER_BUILD_ID,
});

const T0 = Date.parse('2026-09-28T00:00:00Z');
const at = (seconds: number, style: 'micro' | 'z' = 'micro') => {
  const iso = new Date(T0 + seconds * 1000).toISOString();
  return style === 'z' ? iso : iso.replace(/\.(\d{3})Z$/, '.$1000+00:00');
};
const NOW = new Date(T0 + 30 * 60 * 1000);

/**
 * A consistent, honest execution: source 1-10 s, validation build 20-1200 s, broker running.
 * The in-progress broker action carries NO `output` (observed on real AWS, 5th run of #1146
 * runbook 7.5: the build id was not there while the action ran). Its own build is read from
 * CodeBuild (`brokerBuilds`), started by this pipeline.
 */
const observed = (): J => ({
  executions: {
    pipelineExecutionSummaries: [
      { pipelineExecutionId: EXEC, status: 'InProgress', startTime: at(0), sourceRevisions: [{ actionName: 'PromotionBranch', revisionId: REV }] },
      { pipelineExecutionId: '00000000-0000-4000-8000-000000000000', status: 'Failed', startTime: at(-3600), sourceRevisions: [{ revisionId: OTHER_REV }] },
    ],
  },
  actions: {
    actionExecutionDetails: [
      {
        pipelineExecutionId: EXEC, stageName: 'BrokerBoundary', actionName: 'TrustedBrokerUnarmed', status: 'InProgress', startTime: at(1210), lastUpdateTime: at(1215),
        input: { inputArtifacts: [{ name: 'Validated', s3location: { bucket: BUCKET, key: VALIDATED_KEY } }] },
      },
      {
        pipelineExecutionId: EXEC, stageName: 'Validate', actionName: 'UnprivilegedValidation', status: 'Succeeded', startTime: at(15), lastUpdateTime: at(1205),
        input: { inputArtifacts: [{ name: 'Source', s3location: { bucket: BUCKET, key: SOURCE_KEY } }] },
        output: { outputArtifacts: [{ name: 'Validated', s3location: { bucket: BUCKET, key: VALIDATED_KEY } }], executionResult: { externalExecutionId: BUILD_ID } },
      },
      {
        pipelineExecutionId: EXEC, stageName: 'Source', actionName: 'PromotionBranch', status: 'Succeeded', startTime: at(1), lastUpdateTime: at(10),
        input: {}, output: { outputArtifacts: [{ name: 'Source', s3location: { bucket: BUCKET, key: SOURCE_KEY } }], outputVariables: { CommitId: REV, BranchName: 'dev-deploy' } },
      },
    ],
  },
  validationBuilds: { builds: [{ id: BUILD_ID, projectName: 'OpenReceptionDevDeployValidation', buildStatus: 'SUCCEEDED', startTime: at(20), endTime: at(1200) }] },
  brokerBuilds: { builds: [{ id: BROKER_BUILD_ID, projectName: 'OpenReceptionTrustedDevDeployBroker', initiator: PIPELINE_INITIATOR, buildStatus: 'IN_PROGRESS', currentPhase: 'BUILD', startTime: at(1211) }], buildsNotFound: [] },
  bucketVersioning: { Status: 'Enabled' },
  sourceVersions: { Versions: [{ Key: SOURCE_KEY, VersionId: 'sv1', IsLatest: true, LastModified: at(9, 'z') }], DeleteMarkers: [] },
  validatedVersions: { Versions: [{ Key: VALIDATED_KEY, VersionId: 'vv1', IsLatest: true, LastModified: at(1190, 'z') }] },
});

const decide = (mutate: (o: J, c: J) => void = () => {}, now = NOW) => {
  const o = observed();
  const c = config();
  mutate(o, c);
  return mod.evaluateProvenance({ config: c, now, observed: o });
};
const action = (o: J, stage: string) => o.actions.actionExecutionDetails.find((a: J) => a.stageName === stage);

describe('execution provenance: honest execution', () => {
  it('allows, and records the exact artifact versions it bound', () => {
    const d = decide();
    expect(d.result).toBe('allowed');
    expect(d.facts).toMatchObject({
      executionId: EXEC,
      revision: REV,
      sourceArtifact: { bucket: BUCKET, key: SOURCE_KEY, versionId: 'sv1' },
      validatedArtifact: { bucket: BUCKET, key: VALIDATED_KEY, versionId: 'vv1' },
      validationBuildId: BUILD_ID,
    });
  });

  it('allows a retry of the broker stage while the execution is still the newest and fresh', () => {
    const d = decide((o) => {
      o.actions.actionExecutionDetails.push({ ...action(o, 'BrokerBoundary'), status: 'Failed', output: { executionResult: { externalExecutionId: 'OpenReceptionTrustedDevDeployBroker:earlier' } } });
    });
    expect(d.result).toBe('allowed');
  });

  it('ignores longer keys returned by the prefix listing', () => {
    const d = decide((o) => o.validatedVersions.Versions.push({ Key: `${VALIDATED_KEY}x`, VersionId: 'other', LastModified: at(5000, 'z') }));
    expect(d.result).toBe('allowed');
  });
});

describe('self-binding: this build is the pipeline-started build of the in-progress broker action', () => {
  const broker = (o: J) => action(o, 'BrokerBoundary');
  const build = (o: J) => o.brokerBuilds.builds[0];
  const TOL = () => mod.CLOCK_TOLERANCE_MS;
  const ACTION_START = T0 + 1210 * 1000;

  it.each([
    ['no output at all (the shape seen on real AWS while the action ran)', (_o: J) => {}],
    ['an empty output', (o: J) => (broker(o).output = {})],
    ['an output with an external execution id (even another one: it is not used for the decision)', (o: J) => (broker(o).output = { executionResult: { externalExecutionId: 'OpenReceptionTrustedDevDeployBroker:other' } })],
  ])('lower bound: allows an honest pipeline build whatever the in-progress action shows as output: %s', (_label, mutate) => {
    expect(decide(mutate).result).toBe('allowed');
  });

  it('records the broker action output shape (presence and keys only) and the initiator class', () => {
    expect(decide().facts).toMatchObject({ brokerInitiator: 'pipeline', observedBrokerActionShape: { output: false, executionResult: false } });
    expect(decide((o) => (broker(o).output = {})).facts.observedBrokerActionShape).toEqual({ output: true, outputKeys: [], executionResult: false });
    expect(decide((o) => (broker(o).output = { executionResult: { externalExecutionId: 'x', summary: 's' } })).facts.observedBrokerActionShape).toEqual({
      output: true, outputKeys: ['executionResult'], executionResult: true, executionResultKeys: ['externalExecutionId', 'summary'],
    });
    // Recorded on a denial too (it is what the next real run must fill in).
    expect(decide((o) => (build(o).initiator = 'someone')).facts.observedBrokerActionShape).toEqual({ output: false, executionResult: false });
  });

  it.each([
    'alice@example.com',
    'arn:aws:sts::822063948773:assumed-role/AWSReservedSSO_Admin/alice@example.com',
    'codepipeline/OpenReceptionSparseDevDeploy2',
  ])('never records a non-pipeline initiator verbatim (it can be a person: %s)', (who) => {
    const d = decide((o) => (build(o).initiator = who));
    expect(d.result).toBe('denied');
    expect(d.facts.brokerInitiator).toBe('other');
    expect(JSON.stringify(d)).not.toContain(who);
  });

  // Invariant (allow ==> every condition) and its lower bound (every condition ==> allow), swept.
  const INITIATORS: [unknown, boolean][] = [
    [PIPELINE_INITIATOR, true],
    ['codepipeline/OpenReceptionSparseDevDeploy2', false],
    ['codepipeline/OpenReceptionSparseDevDeploy/x', false],
    ['xcodepipeline/OpenReceptionSparseDevDeploy', false],
    ['CODEPIPELINE/OpenReceptionSparseDevDeploy', false],
    ['codepipeline/openreceptionsparsedevdeploy', false],
    [`${PIPELINE_INITIATOR} `, false],
    ['codepipeline/OtherPipeline', false],
    ['OpenReceptionSparseDevDeploy', false],
    ['codepipeline/', false],
    ['alice', false],
    [undefined, false],
    [null, false],
    [42, false],
    [[PIPELINE_INITIATOR], false],
  ];
  const PROJECTS_: [unknown, boolean][] = [
    ['OpenReceptionTrustedDevDeployBroker', true],
    ['OpenReceptionDevDeployValidation', false],
    ['openreceptiontrusteddevdeploybroker', false],
    [undefined, false],
  ];
  const STATUSES: [unknown, boolean][] = [
    ['IN_PROGRESS', true],
    ['SUCCEEDED', false],
    ['FAILED', false],
    ['STOPPED', false],
    ['in_progress', false],
    [undefined, false],
  ];
  const IDS: [unknown, boolean][] = [
    [BROKER_BUILD_ID, true],
    [BUILD_ID, false],
    ['OpenReceptionTrustedDevDeployBroker:7a2d8d2f-0000-4000-8000-000000000003', false],
    [undefined, false],
  ];
  // Build start relative to the broker action start (ms); the tolerance boundary is pinned exactly.
  const STARTS: [unknown, boolean][] = [
    [-60_000, false],
    ['-tol-1', false],
    ['-tol', true],
    [-1, true],
    [0, true],
    [616, true],
    [600_000, true],
    ['garbage', false],
    [undefined, false],
  ];
  const startValue = (v: unknown) => {
    if (v === undefined || v === 'garbage') return v;
    const ms = v === '-tol' ? -TOL() : v === '-tol-1' ? -TOL() - 1 : (v as number);
    return new Date(ACTION_START + ms).toISOString();
  };

  it('allows exactly when initiator, project, status, id and start time all hold (exhaustive)', () => {
    const wrong: string[] = [];
    let n = 0;
    for (const [initiator, i] of INITIATORS)
      for (const [projectName, p] of PROJECTS_)
        for (const [buildStatus, st] of STATUSES)
          for (const [id, d] of IDS)
            for (const [start, t] of STARTS) {
              n += 1;
              const decision = decide((o) => {
                o.brokerBuilds.builds[0] = { ...build(o), initiator, projectName, buildStatus, id, startTime: startValue(start) };
              });
              const expected = i && p && st && d && t;
              if ((decision.result === 'allowed') !== expected) wrong.push(JSON.stringify({ initiator, projectName, buildStatus, id, start, got: decision.result }));
              if (!expected && decision.rule !== mod.RULES.UNVERIFIABLE) wrong.push(`rule ${decision.rule} for ${JSON.stringify({ initiator, projectName, buildStatus, id, start })}`);
            }
    expect(n).toBe(INITIATORS.length * PROJECTS_.length * STATUSES.length * IDS.length * STARTS.length);
    expect(wrong).toEqual([]);
  });

  it.each([
    ['CodeBuild returned no build', (o: J) => (o.brokerBuilds = { builds: [], buildsNotFound: [BROKER_BUILD_ID] })],
    ['CodeBuild returned the build twice', (o: J) => o.brokerBuilds.builds.push({ ...build(o) })],
    ['CodeBuild returned this build and another', (o: J) => o.brokerBuilds.builds.push({ ...build(o), id: 'OpenReceptionTrustedDevDeployBroker:other' })],
    ['CodeBuild returned this build and a non-record', (o: J) => o.brokerBuilds.builds.push('x')],
    ['the build record is missing', (o: J) => delete o.brokerBuilds],
    ['the build list is not a list', (o: J) => (o.brokerBuilds = { builds: build(o) })],
    ['the broker action has no start time', (o: J) => delete broker(o).startTime],
    ['the broker action start time is malformed', (o: J) => (broker(o).startTime = 'soon')],
    ['the env build id names another (finished) build that the pipeline started', (o: J) => {
      build(o).buildStatus = 'FAILED';
    }],
  ])('denies (unverifiable) when %s', (_label, mutate) => {
    expect(decide(mutate).rule).toBe(mod.RULES.UNVERIFIABLE);
  });

  it('a build started outside the pipeline is denied even with the right execution id and an in-progress action', () => {
    const d = decide((o) => (build(o).initiator = 'owner'));
    expect(d).toMatchObject({ result: 'denied', rule: mod.RULES.UNVERIFIABLE });
    expect(d.reason).toMatch(/not started by this pipeline/);
  });
});

describe('real AWS shapes (5th run of #1146 runbook 7.5, execution 1c5eacea, CLI v2 timestamps)', () => {
  const R_EXEC = '1c5eacea-2c35-4d0a-9e6c-4f9f20c56760';
  const R_REV = 'f34f382d442cde719fd22a9603bb7b4b4f1b2634';
  const R_BUCKET = 'openreceptiondevdeploybr-pipelineartifacts4a9b262-0123456789ab';
  const R_SOURCE_KEY = 'OpenReceptionSparseD/Source/iMHAvP3';
  const R_VALIDATED_KEY = 'OpenReceptionSparseD/Validated/uJS2Iw7';
  const R_VALIDATION_BUILD = 'OpenReceptionDevDeployValidation:5bf7e4a7-ceac-4f14-a819-481e19c552a4';
  const R_BROKER_BUILD = 'OpenReceptionTrustedDevDeployBroker:3f0b01a9-4cc8-4870-a4c9-4dcec8533c5f';
  const jst = (iso: string) => {
    const t = new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString();
    return t.replace(/\.(\d{3})Z$/, '.$1000+09:00');
  };
  const realConfig = (): J => ({ ...config(), executionId: R_EXEC, revision: R_REV, artifactBucket: R_BUCKET, buildId: R_BROKER_BUILD });
  const realObserved = (): J => ({
    executions: {
      pipelineExecutionSummaries: [
        { pipelineExecutionId: R_EXEC, status: 'InProgress', startTime: jst('2026-10-10T05:16:53.264Z'), sourceRevisions: [{ actionName: 'PromotionBranch', revisionId: R_REV }] },
      ],
    },
    actions: {
      actionExecutionDetails: [
        {
          pipelineExecutionId: R_EXEC, stageName: 'BrokerBoundary', actionName: 'TrustedBrokerUnarmed', status: 'InProgress', startTime: jst('2026-10-10T05:25:14.626Z'), lastUpdateTime: jst('2026-10-10T05:25:14.626Z'),
          input: { inputArtifacts: [{ name: 'Validated', s3location: { bucket: R_BUCKET, key: R_VALIDATED_KEY } }] },
        },
        {
          pipelineExecutionId: R_EXEC, stageName: 'Validate', actionName: 'UnprivilegedValidation', status: 'Succeeded', startTime: jst('2026-10-10T05:17:00.451Z'), lastUpdateTime: jst('2026-10-10T05:25:13.964Z'),
          input: { inputArtifacts: [{ name: 'Source', s3location: { bucket: R_BUCKET, key: R_SOURCE_KEY } }] },
          output: { outputArtifacts: [{ name: 'Validated', s3location: { bucket: R_BUCKET, key: R_VALIDATED_KEY } }], executionResult: { externalExecutionId: R_VALIDATION_BUILD } },
        },
        {
          pipelineExecutionId: R_EXEC, stageName: 'Source', actionName: 'PromotionBranch', status: 'Succeeded', startTime: jst('2026-10-10T05:16:53.471Z'), lastUpdateTime: jst('2026-10-10T05:16:59.700Z'),
          input: {}, output: { outputArtifacts: [{ name: 'Source', s3location: { bucket: R_BUCKET, key: R_SOURCE_KEY } }], outputVariables: { CommitId: R_REV, BranchName: 'dev-deploy' } },
        },
      ],
    },
    validationBuilds: {
      builds: [{
        id: R_VALIDATION_BUILD, projectName: 'OpenReceptionDevDeployValidation', initiator: PIPELINE_INITIATOR, buildStatus: 'SUCCEEDED', resolvedSourceVersion: R_REV,
        startTime: jst('2026-10-10T05:17:01.033Z'), endTime: jst('2026-10-10T05:24:53.047Z'),
        phases: [{ phaseType: 'UPLOAD_ARTIFACTS', startTime: jst('2026-10-10T05:24:48.945Z'), endTime: jst('2026-10-10T05:24:52.747Z') }],
      }],
    },
    brokerBuilds: {
      builds: [{ id: R_BROKER_BUILD, projectName: 'OpenReceptionTrustedDevDeployBroker', initiator: PIPELINE_INITIATOR, buildStatus: 'IN_PROGRESS', currentPhase: 'BUILD', startTime: jst('2026-10-10T05:25:15.242Z') }],
      buildsNotFound: [],
    },
    bucketVersioning: { Status: 'Enabled' },
    sourceVersions: { Versions: [{ Key: R_SOURCE_KEY, VersionId: 'srcVersion1', IsLatest: true, LastModified: '2026-10-10T05:16:58+00:00' }] },
    validatedVersions: { Versions: [{ Key: R_VALIDATED_KEY, VersionId: 'valVersion1', IsLatest: true, LastModified: '2026-10-10T05:24:52+00:00' }] },
  });
  const realNow = new Date('2026-10-10T05:25:46.602Z');

  it('allows the run that the 5th attempt denied (no build id on the in-progress action)', () => {
    const d = mod.evaluateProvenance({ config: realConfig(), now: realNow, observed: realObserved() });
    expect(d).toMatchObject({ result: 'allowed', facts: { brokerInitiator: 'pipeline', observedBrokerActionShape: { output: false }, validatedArtifact: { key: R_VALIDATED_KEY, versionId: 'valVersion1' } } });
  });

  it('allows it with the shape seen after completion (build id present), too', () => {
    const o = realObserved();
    o.actions.actionExecutionDetails[0].output = { executionResult: { externalExecutionId: R_BROKER_BUILD } };
    expect(mod.evaluateProvenance({ config: realConfig(), now: realNow, observed: o }).result).toBe('allowed');
  });

  it('denies the same run if this build had been started by a person', () => {
    const o = realObserved();
    o.brokerBuilds.builds[0].initiator = 'owner';
    expect(mod.evaluateProvenance({ config: realConfig(), now: realNow, observed: o }).rule).toBe(mod.RULES.UNVERIFIABLE);
  });

  it('the real Validated entry names are within the allowlist (sample of the real shape)', () => {
    expect(mod.unsafeEntryName(['broker-evidence.json', 'infra/cdk.out/manifest.json', 'infra/cdk.out/asset.0f1e/index.js', 'apps/web/.open-next/server-functions/default/app/(kiosk)/kiosk/[tenant]/page.js'])).toBeNull();
  });
});

describe('blocker 4: stale retry', () => {
  it.each([
    ['a newer execution exists (promotion moved on)', (o: J) => o.executions.pipelineExecutionSummaries.push({ pipelineExecutionId: '22222222-2222-4222-8222-222222222222', status: 'InProgress', startTime: at(600) })],
    ['a newer execution for the same revision', (o: J) => o.executions.pipelineExecutionSummaries.unshift({ pipelineExecutionId: '33333333-3333-4333-8333-333333333333', status: 'Superseded', startTime: at(1), sourceRevisions: [{ revisionId: REV }] })],
    ['an execution with an unparseable start time', (o: J) => (o.executions.pipelineExecutionSummaries[1].startTime = 'yesterday')],
    ['the execution is not among the recent executions', (o: J) => o.executions.pipelineExecutionSummaries.shift()],
    ['the execution is no longer in progress', (o: J) => (o.executions.pipelineExecutionSummaries[0].status = 'Stopped')],
  ])('denies when %s', (_label, mutate) => {
    expect(decide(mutate).rule).toBe(mod.RULES.STALE);
  });

  it('denies an execution older than the age limit, and allows one just inside it', () => {
    const limit = mod.MAX_EXECUTION_AGE_MS;
    expect(decide(() => {}, new Date(T0 + limit + 1000)).rule).toBe(mod.RULES.STALE);
    expect(decide(() => {}, new Date(T0 + limit - 1000)).result).toBe('allowed');
  });

  it('denies an execution that started in the future (clock skew)', () => {
    expect(decide(() => {}, new Date(T0 - 60 * 1000)).rule).toBe(mod.RULES.UNVERIFIABLE);
  });
});

describe('revision binding (trusted CommitId cross-checked against CodePipeline)', () => {
  it.each([
    ['the execution records another revision', (o: J) => (o.executions.pipelineExecutionSummaries[0].sourceRevisions = [{ revisionId: OTHER_REV }])],
    ['the execution records two revisions', (o: J) => o.executions.pipelineExecutionSummaries[0].sourceRevisions.push({ revisionId: OTHER_REV })],
    ['the source action recorded another CommitId', (o: J) => (action(o, 'Source').output.outputVariables.CommitId = OTHER_REV)],
    ['the source action recorded no CommitId', (o: J) => delete action(o, 'Source').output.outputVariables],
  ])('denies when %s', (_label, mutate) => {
    expect(decide(mutate).rule).toBe(mod.RULES.REVISION_MISMATCH);
  });

  it('denies a trusted revision that CodePipeline did not record (env substituted)', () => {
    expect(decide((_o, c) => (c.revision = OTHER_REV)).rule).toBe(mod.RULES.REVISION_MISMATCH);
  });
});

describe('blocker 2: artifact substitution', () => {
  it.each([
    ['a second version of the validated artifact (overwritten)', (o: J) => o.validatedVersions.Versions.push({ Key: VALIDATED_KEY, VersionId: 'vv2', LastModified: at(1195, 'z') })],
    ['a second version of the source artifact', (o: J) => o.sourceVersions.Versions.push({ Key: SOURCE_KEY, VersionId: 'sv2', LastModified: at(9, 'z') })],
    ['a delete marker on the validated artifact', (o: J) => (o.validatedVersions.DeleteMarkers = [{ Key: VALIDATED_KEY, VersionId: 'dm' }])],
    ['no version of the validated artifact', (o: J) => (o.validatedVersions.Versions = [])],
    ['a validated version written after the validation build ended', (o: J) => (o.validatedVersions.Versions[0].LastModified = at(1300, 'z'))],
    ['a validated version written before the validation build started', (o: J) => (o.validatedVersions.Versions[0].LastModified = at(5, 'z'))],
    ['a source version written outside the source action', (o: J) => (o.sourceVersions.Versions[0].LastModified = at(-100, 'z'))],
    ['a source version written after validation started', (o: J) => {
      action(o, 'Source').lastUpdateTime = at(400);
      o.sourceVersions.Versions[0].LastModified = at(300, 'z');
    }],
    ['a "null" version (written while versioning was off)', (o: J) => (o.validatedVersions.Versions[0].VersionId = 'null')],
    ['a truncated version listing', (o: J) => (o.validatedVersions.IsTruncated = true)],
    ['validation read another source artifact', (o: J) => (action(o, 'Validate').input.inputArtifacts[0].s3location.key = 'OpenReceptionSparseD/Source/Other')],
    ['the broker reads another validated artifact', (o: J) => (action(o, 'BrokerBoundary').input.inputArtifacts[0].s3location.key = 'OpenReceptionSparseD/Validated/Other')],
    ['the artifacts live in another bucket', (o: J) => {
      for (const a of o.actions.actionExecutionDetails) for (const x of [...(a.input.inputArtifacts ?? []), ...(a.output?.outputArtifacts ?? [])]) x.s3location.bucket = 'attacker';
    }],
  ])('denies %s', (_label, mutate) => {
    expect(decide(mutate).rule).toBe(mod.RULES.ARTIFACT_SUBSTITUTED);
  });

  it.each([
    ['bucket versioning is suspended', (o: J) => (o.bucketVersioning = { Status: 'Suspended' })],
    ['bucket versioning was never enabled', (o: J) => (o.bucketVersioning = {})],
    ['the validation build failed', (o: J) => (o.validationBuilds.builds[0].buildStatus = 'FAILED')],
    ['the build belongs to another project', (o: J) => (o.validationBuilds.builds[0].projectName = 'Other')],
    ['the build is missing', (o: J) => (o.validationBuilds.builds = [])],
    ['two validations succeeded in one execution', (o: J) => o.actions.actionExecutionDetails.push({ ...action(o, 'Validate') })],
    ['no broker action is in progress', (o: J) => (action(o, 'BrokerBoundary').status = 'Failed')],
    ['two broker actions are in progress', (o: J) => o.actions.actionExecutionDetails.push({ ...action(o, 'BrokerBoundary') })],
    ['an action has two artifacts', (o: J) => action(o, 'Validate').output.outputArtifacts.push({ name: 'X', s3location: { bucket: BUCKET, key: 'k' } })],
    ['an artifact has no S3 location', (o: J) => delete action(o, 'Source').output.outputArtifacts[0].s3location],
    ['nothing was observed', (o: J) => Object.keys(o).forEach((k) => delete o[k])],
  ])('denies (unverifiable) when %s', (_label, mutate) => {
    expect(decide(mutate).result).toBe('denied');
  });
});

describe('inputs', () => {
  it.each([
    ['a malformed execution id', (c: J) => (c.executionId = 'x')],
    ['a short revision', (c: J) => (c.revision = 'abc123')],
    ['a missing artifact bucket', (c: J) => (c.artifactBucket = undefined)],
    ['a malformed stage map', (c: J) => (c.stages = { source: STAGES.source })],
    ['a missing broker build id', (c: J) => (c.buildId = undefined)],
    ['a missing broker project', (c: J) => (c.brokerProject = undefined)],
  ])('refuses %s before looking at any evidence', (_label, mutate) => {
    expect(decide((_o, c) => mutate(c)).rule).toBe(mod.RULES.INPUT_INVALID);
  });

  it('refuses an invalid clock', () => {
    expect(decide(() => {}, new Date(Number.NaN)).rule).toBe(mod.RULES.INPUT_INVALID);
  });

  it.each([
    ['2026-09-28T00:00:00.123456+00:00', Date.parse('2026-09-28T00:00:00.123Z')],
    ['2026-09-28T09:00:00+09:00', Date.parse('2026-09-28T00:00:00Z')],
    ['2026-09-28T00:00:00Z', Date.parse('2026-09-28T00:00:00Z')],
    ['2026-09-28T00:00:00.5-0100', Date.parse('2026-09-28T01:00:00.500Z')],
    [1790553600, 1790553600000],
  ])('parses the CLI timestamp %s', (value, expected) => {
    expect(mod.parseTime(value)).toBe(expected);
  });

  it.each(['yesterday', '2026-09-28', '2026-09-28T00:00:00', null, undefined, Number.NaN])('rejects the timestamp %s', (value) => {
    expect(Number.isNaN(mod.parseTime(value))).toBe(true);
  });
});

describe('gather: the exact AWS calls (no shell, read-only)', () => {
  it('lists executions, this execution\'s actions, the validation build, this build, versioning and both artifacts\' versions', () => {
    const calls: string[][] = [];
    const o = observed();
    const responses: Record<string, J> = {
      'list-pipeline-executions': o.executions,
      'list-action-executions': o.actions,
      'get-bucket-versioning': o.bucketVersioning,
    };
    const gathered = mod.gather(config(), (args) => {
      calls.push(args);
      if (args[1] === 'list-object-versions') return args.includes(SOURCE_KEY) ? o.sourceVersions : o.validatedVersions;
      if (args[1] === 'batch-get-builds') return args[3] === BROKER_BUILD_ID ? o.brokerBuilds : o.validationBuilds;
      return responses[args[1]!]!;
    });
    expect(calls).toEqual([
      ['codepipeline', 'list-pipeline-executions', '--pipeline-name', 'OpenReceptionSparseDevDeploy', '--max-items', '10'],
      ['codepipeline', 'list-action-executions', '--pipeline-name', 'OpenReceptionSparseDevDeploy', '--filter', `pipelineExecutionId=${EXEC}`],
      ['codebuild', 'batch-get-builds', '--ids', BUILD_ID],
      // This build's own record, in a separate call (never mixed with the validation build's).
      ['codebuild', 'batch-get-builds', '--ids', BROKER_BUILD_ID],
      ['s3api', 'get-bucket-versioning', '--bucket', BUCKET],
      ['s3api', 'list-object-versions', '--bucket', BUCKET, '--prefix', SOURCE_KEY],
      ['s3api', 'list-object-versions', '--bucket', BUCKET, '--prefix', VALIDATED_KEY],
    ]);
    expect(mod.evaluateProvenance({ config: config(), now: NOW, observed: gathered }).result).toBe('allowed');
  });

  it('refuses to list an artifact outside the artifact bucket', () => {
    const o = observed();
    action(o, 'Source').output.outputArtifacts[0].s3location.bucket = 'attacker';
    expect(() =>
      mod.gather(config(), (args) => (args[1] === 'list-pipeline-executions' ? o.executions : args[1] === 'list-action-executions' ? o.actions : {})),
    ).toThrow(/outside the artifact bucket/);
  });
});

describe('runCli: bind, fetch the exact version, extract safely, record the decision', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'or-provenance-run-'));
    dirs.push(d);
    return d;
  };
  const ARGS = ['--pipeline', 'OpenReceptionSparseDevDeploy', '--validation-project', 'OpenReceptionDevDeployValidation', '--artifact-bucket-env', 'OR_PIPELINE_ARTIFACT_BUCKET', '--stages', 'Source/PromotionBranch,Validate/UnprivilegedValidation,BrokerBoundary/TrustedBrokerUnarmed'];
  const ENV = { OR_PIPELINE_ARTIFACT_BUCKET: BUCKET, OR_PIPELINE_EXECUTION_ID: EXEC, OR_TRUSTED_SOURCE_REVISION: REV, CODEBUILD_BUILD_ID: BROKER_BUILD_ID };

  /** A zip built from `files` (path -> content); `link` adds a symlink entry. */
  const makeZip = (root: string, files: Record<string, string>, link?: [string, string]) => {
    const src = join(root, 'zipsrc');
    for (const [name, content] of Object.entries(files)) {
      execFileSync('mkdir', ['-p', join(src, name, '..')]);
      writeFileSync(join(src, name), content);
    }
    if (link) execFileSync('ln', ['-s', link[1], join(src, link[0])]);
    const zip = join(root, 'artifact.zip');
    execFileSync('zip', ['-q', '-r', '-y', zip, '.'], { cwd: src });
    return zip;
  };

  /** Fake CLI: serves the honest execution; `get-object` copies `zip` to the requested file. */
  const fakeRunAws = (zip: string, versionId = 'vv1', calls: string[][] = []) => (args: string[]): J => {
    calls.push(args);
    const o = observed();
    if (args[1] === 'get-object') {
      writeFileSync(args.at(-1)!, readFileSync(zip));
      return { VersionId: versionId, ContentLength: 1 };
    }
    if (args[1] === 'list-object-versions') return args.includes(SOURCE_KEY) ? o.sourceVersions : o.validatedVersions;
    if (args[1] === 'batch-get-builds') return args[3] === BROKER_BUILD_ID ? o.brokerBuilds : o.validationBuilds;
    return ({ 'list-pipeline-executions': o.executions, 'list-action-executions': o.actions, 'get-bucket-versioning': o.bucketVersioning } as J)[args[1]!];
  };

  const runIn = (root: string, runAws: (a: string[]) => J, extra: J = {}) =>
    mod.runCli(ARGS, { now: NOW, env: ENV, runAws, workDir: join(root, 'work'), decisionPath: join(root, 'provenance.json'), ...extra });

  it('binds the broker project from the pinned module, never from the environment', () => {
    expect(mod.BROKER_PROJECT_NAME).toBe('OpenReceptionTrustedDevDeployBroker');
    const calls: string[][] = [];
    const root = scratch();
    expect(runIn(root, fakeRunAws(makeZip(root, { a: 'x' }), 'vv1', calls)).exitCode).toBe(0);
    expect(calls).toContainEqual(['codebuild', 'batch-get-builds', '--ids', BROKER_BUILD_ID]);
  });

  it('mirrors the stack\'s broker-owned paths', () => {
    expect(mod.BROKER_WORK_DIR).toBe('/tmp/open-reception-broker-work');
    expect(mod.VALIDATED_DIR).toBe('/tmp/open-reception-broker-work/validated');
    expect(mod.DECISION_PATH).toBe('/tmp/open-reception-broker-out/provenance.json');
  });

  it('fetches exactly the bound version, extracts it and records its content hash', () => {
    const root = scratch();
    const zip = makeZip(root, { 'broker-evidence.json': '{}', 'infra/cdk.out/manifest.json': '{}' });
    const calls: string[][] = [];
    const r = runIn(root, fakeRunAws(zip, 'vv1', calls));
    expect(r.exitCode).toBe(0);
    expect(calls.find((c) => c[1] === 'get-object')).toEqual(['s3api', 'get-object', '--bucket', BUCKET, '--key', VALIDATED_KEY, '--version-id', 'vv1', join(root, 'work', 'validated.zip')]);
    expect(readFileSync(join(root, 'work', 'validated', 'infra', 'cdk.out', 'manifest.json'), 'utf8')).toBe('{}');
    const recorded = JSON.parse(readFileSync(join(root, 'provenance.json'), 'utf8')) as J;
    expect(recorded.result).toBe('allowed');
    expect(recorded.facts.validatedArtifact.sha256).toBe(createHash('sha256').update(readFileSync(zip)).digest('hex'));
  });

  it('denies when S3 returns another version than the one bound', () => {
    const root = scratch();
    const r = runIn(root, fakeRunAws(makeZip(root, { a: 'x' }), 'vv2'));
    expect(r.exitCode).toBe(43);
    expect(r.record.rule).toBe(mod.RULES.UNVERIFIABLE);
  });

  it('refuses a symlink in the artifact (it could redirect a broker write onto a verified module)', () => {
    const root = scratch();
    const zip = makeZip(root, { 'broker-evidence.json': '{}' }, ['broker-provenance.json', '/tmp/open-reception-run-provenance.mjs']);
    const r = runIn(root, fakeRunAws(zip));
    expect(r.exitCode).toBe(43);
    expect(r.record.rule).toBe(mod.RULES.ARTIFACT_UNSAFE);
  });

  it('refuses a zip with a path-traversal entry (unzip reports it; any warning fails closed)', () => {
    const root = scratch();
    const zip = makeZip(root, { 'aa/evil.txt': 'x', 'ok.txt': 'y' });
    // Rename the entry to "../evil.txt" in place (same length; the CRC does not cover the name).
    const bytes = readFileSync(zip);
    let at = bytes.indexOf('aa/evil.txt');
    expect(at).toBeGreaterThan(0);
    while (at >= 0) {
      bytes.write('..', at, 'latin1');
      at = bytes.indexOf('aa/evil.txt', at + 1);
    }
    writeFileSync(zip, bytes);
    const r = runIn(root, fakeRunAws(zip));
    expect(r.exitCode).toBe(43);
    expect(r.record.rule).toBe(mod.RULES.ARTIFACT_UNSAFE);
  });

  it.each([
    [['a/b.json', 'c'], null],
    [['dir/', 'dir/x'], null],
    [['/abs'], '/abs'],
    [['../x'], '../x'],
    [['a/../x'], 'a/../x'],
    [['a//x'], 'a//x'],
    [['./x'], './x'],
    [['a\\x'], 'a\\x'],
    [['infra/cdk.out/manifest.json\u0001'], 'infra/cdk.out/manifest.json\u0001'],
    [['x\u007f'], 'x\u007f'],
    [['caf\u00e9'], 'caf\u00e9'],
    [['a^Ab'], 'a^Ab'],
    [['server_app_api_[id]_route.js', '(group)/page.js', 'asset.0f/x@1.js'], null],
    [['x', 'x'], 'x (duplicate)'],
    [['x/', 'x'], 'x (duplicate)'],
  ])('entry names %j -> %s', (names, expected) => {
    expect(mod.unsafeEntryName(names)).toBe(expected);
  });

  it('refuses an archive whose listed names and extracted files differ (control byte dropped on extraction)', () => {
    const root = scratch();
    const zip = makeZip(root, { 'infra/cdk.out/manifest.json': 'GOOD' });
    const r = runIn(root, fakeRunAws(zip), { unzip: (z: string, d: string) => {
      // Simulate the divergence directly: listing says two files, extraction yields one.
      execFileSync('unzip', ['-q', '-o', z, '-d', d]);
      return ['infra/cdk.out/manifest.json', 'infra/cdk.out/manifest.json\u0001'];
    } });
    expect(r.exitCode).toBe(43);
    expect(r.record.rule).toBe(mod.RULES.ARTIFACT_UNSAFE);
  });

  it('refuses to reuse an existing work directory or overwrite an existing decision', () => {
    const root = scratch();
    const zip = makeZip(root, { a: 'x' });
    execFileSync('mkdir', ['-p', join(root, 'work')]);
    expect(runIn(root, fakeRunAws(zip)).exitCode).toBe(43);
    const other = scratch();
    writeFileSync(join(other, 'provenance.json'), '{"result":"allowed"}');
    const r = runIn(other, fakeRunAws(makeZip(other, { a: 'x' })));
    expect(r.exitCode).toBe(43);
    expect(readFileSync(join(other, 'provenance.json'), 'utf8')).toBe('{"result":"allowed"}');
  });

  it('records a denial and never fetches when AWS cannot be read', () => {
    const root = scratch();
    const calls: string[][] = [];
    const r = runIn(root, (args) => {
      calls.push(args);
      throw new Error('AccessDenied');
    });
    expect(r.exitCode).toBe(43);
    expect(JSON.parse(readFileSync(join(root, 'provenance.json'), 'utf8')) as J).toMatchObject({ result: 'denied', rule: mod.RULES.UNVERIFIABLE });
    expect(calls.some((c) => c[1] === 'get-object')).toBe(false);
  });

  it('resolves tools only from absolute PATH entries (never the candidate working directory)', () => {
    const root = scratch();
    const bin = join(root, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(join(root, 'aws'), '#!/bin/sh\n');
    execFileSync('chmod', ['+x', join(root, 'aws')]);
    writeFileSync(join(bin, 'aws'), '#!/bin/sh\n');
    execFileSync('chmod', ['+x', join(bin, 'aws')]);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(mod.resolveTool('aws', `:.:bin:${bin}`)).toBe(join(bin, 'aws'));
      expect(() => mod.resolveTool('aws', ':.:bin')).toThrow(/absolute PATH/);
    } finally {
      process.chdir(cwd);
    }
  });

  it('runs as a program when invoked through a symlinked path', () => {
    const root = scratch();
    execFileSync('ln', ['-s', resolve(__dirname, '../broker'), join(root, 'linked')]);
    let status = 0;
    try {
      execFileSync(process.execPath, [join(root, 'linked', 'run-provenance.mjs'), ...ARGS], { env: { PATH: '/nonexistent', ...ENV } as Record<string, string> as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      status = (error as { status: number }).status;
    }
    // Not a silent exit 0: it runs and fails closed (no AWS CLI, no output dir).
    expect(status).toBe(43);
  });

  it('as a process, exits non-zero when its output directory is missing (fail closed)', () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [MODULE, ...ARGS], { env: { PATH: '/nonexistent', ...ENV } as Record<string, string> as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).toBe(43);
  });
});
