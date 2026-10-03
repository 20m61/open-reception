import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Access-restriction gate (#1153 D-5, Foundation safe-dev-deploy S6c). The looser sparse-deploy
 * profile is earned only by a restriction the broker derives from the template; an unverifiable
 * restriction is an absent one, and the restriction's credential never appears in the template.
 */

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Check = { name: string; isRestricted: (entry: J) => unknown } | null;
type Mod = {
  RULES: Record<string, string>;
  PRODUCT_RESTRICTION_CHECK: unknown;
  DECISION_PATH: string;
  BROKER_OUT_DIR: string;
  DENIED_EXIT_CODE: number;
  evaluateAccessRestriction: (i: { assemblyDir: string; check: Check }) => J;
  looksLikeBasicCredential: (s: unknown) => boolean;
  parseStrictJson: (s: string) => unknown;
  runCli: (argv: string[], o?: J) => { exitCode: number; record: J };
};

const MODULE = resolve(__dirname, '../broker/access-restriction.mjs');
const POLICY = resolve(__dirname, '../broker/trusted-policy.mjs');
const REAL = resolve(__dirname, 'fixtures/real-dev-assembly');
let M: Mod;
beforeAll(async () => {
  M = (await import(pathToFileURL(MODULE).href)) as Mod;
});

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'or-access-restriction-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A minimal assembly: one stack per entry of `stacks` (name -> Resources). */
const assembly = (stacks: Record<string, J>) => {
  const dir = scratch();
  const artifacts: J = {};
  for (const [name, resources] of Object.entries(stacks)) {
    writeFileSync(join(dir, `${name}.template.json`), JSON.stringify({ Resources: resources }));
    artifacts[name] = { type: 'aws:cloudformation:stack', properties: { templateFile: `${name}.template.json`, stackName: name } };
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: '1', artifacts }));
  return dir;
};

const distribution = (behaviors = 2): J => ({
  Type: 'AWS::CloudFront::Distribution',
  Properties: {
    DistributionConfig: {
      DefaultCacheBehavior: { TargetOriginId: 'o', FunctionAssociations: [{ EventType: 'viewer-request', FunctionARN: 'arn' }] },
      CacheBehaviors: Array.from({ length: behaviors }, (_, i) => ({ PathPattern: `/p${i}/*`, TargetOriginId: 'o' })),
    },
  },
});
const all: Check = { name: 'all', isRestricted: () => true };

describe('negative control: the real dev assembly', () => {
  it('declares no check today: absent, allowed, nothing found', () => {
    expect(M.PRODUCT_RESTRICTION_CHECK).toBeNull();
    const d = M.evaluateAccessRestriction({ assemblyDir: REAL, check: null });
    expect(d).toMatchObject({ result: 'allowed', rule: null, accessRestriction: { state: 'absent' }, findings: [] });
  });

  it('enumerates its viewer-facing entry points (distribution behaviours and function URLs)', () => {
    const d = M.evaluateAccessRestriction({ assemblyDir: REAL, check: all });
    expect(d).toMatchObject({ result: 'allowed', accessRestriction: { state: 'verified' } });
    const types = (d.entryPoints as J[]).map((e) => e.type);
    expect(types.filter((t) => t === 'AWS::Lambda::Url')).toHaveLength(2);
    expect(types.filter((t) => t === 'AWS::CloudFront::Distribution').length).toBeGreaterThanOrEqual(1);
  });

  it('a check that proves only the CDN does not verify it: the function URLs are entry points too', () => {
    const cdnOnly: Check = { name: 'cdn-only', isRestricted: (e) => e.type === 'AWS::CloudFront::Distribution' };
    const d = M.evaluateAccessRestriction({ assemblyDir: REAL, check: cdnOnly });
    expect(d).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_WEAKENED', accessRestriction: { state: 'unverifiable' } });
    expect(String(d.reason)).toContain('OpenReception-Web-dev/');
    expect((d.entryPoints as J[]).filter((e) => !e.restricted).every((e) => e.type === 'AWS::Lambda::Url')).toBe(true);
  });

  it('the CLI over the real assembly writes an absent decision for this execution and exits 0', () => {
    const out = scratch();
    const decisionPath = join(out, 'access-restriction.json');
    const r = M.runCli(['--assembly', REAL], { env: { OR_PIPELINE_EXECUTION_ID: 'e-1', OR_TRUSTED_SOURCE_REVISION: 'a'.repeat(40) }, decisionPath, now: new Date('2026-10-03T00:00:00Z') });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(decisionPath, 'utf8'))).toMatchObject({ result: 'allowed', rule: null, accessRestriction: { state: 'absent' }, executionId: 'e-1', revision: 'a'.repeat(40), decidedAt: '2026-10-03T00:00:00.000Z' });
  });

  it('runs as a program and exits 0 with one JSON line', () => {
    const out = scratch();
    // The default decision path is in /tmp; run with a copy whose DECISION_PATH points at scratch.
    const copy = join(out, 'access-restriction.mjs');
    writeFileSync(copy, readFileSync(MODULE, 'utf8').replace("export const BROKER_OUT_DIR = '/tmp/open-reception-broker-out';", `export const BROKER_OUT_DIR = ${JSON.stringify(out)};`));
    const stdout = execFileSync(process.execPath, [copy, '--assembly', REAL], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', OR_PIPELINE_EXECUTION_ID: 'e-1', OR_TRUSTED_SOURCE_REVISION: 'a'.repeat(40) } as Record<string, string> as NodeJS.ProcessEnv });
    expect(JSON.parse(stdout.trim())).toMatchObject({ event: 'access_restriction.allowed', accessRestriction: { state: 'absent' } });
  });
});

describe('a declared check verifies only when it proves every entry point', () => {
  const stacks = () => ({
    Web: {
      Cdn: distribution(2),
      Url: { Type: 'AWS::Lambda::Url', Properties: { AuthType: 'AWS_IAM' } },
      Rest: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Http: { Type: 'AWS::ApiGatewayV2::Api', Properties: {} },
      Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    },
  });

  it('enumerates each behaviour, the function URL and every API Gateway resource (and nothing else)', () => {
    const seen: string[] = [];
    const d = M.evaluateAccessRestriction({ assemblyDir: assembly(stacks()), check: { name: 'spy', isRestricted: (e) => (seen.push(e.entry), true) } });
    expect(d.accessRestriction).toEqual({ state: 'verified' });
    expect(seen.sort()).toEqual(['Cdn/CacheBehaviors/0', 'Cdn/CacheBehaviors/1', 'Cdn/DefaultCacheBehavior', 'Http', 'Rest', 'Url'].sort());
  });

  it.each(['Cdn/CacheBehaviors/1', 'Cdn/DefaultCacheBehavior', 'Url', 'Rest', 'Http'])('one unproven entry point (%s) is a weakened restriction, not verified', (miss) => {
    const d = M.evaluateAccessRestriction({ assemblyDir: assembly(stacks()), check: { name: 'all-but-one', isRestricted: (e) => e.entry !== miss } });
    expect(d).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_WEAKENED', accessRestriction: { state: 'unverifiable' } });
    expect(String(d.reason)).toContain(`Web/${miss}`);
  });

  it('only exactly `true` proves; a throwing or truthy-but-not-true check proves nothing', () => {
    for (const isRestricted of [() => 'yes', () => 1, () => undefined, () => { throw new Error('x'); }]) {
      expect(M.evaluateAccessRestriction({ assemblyDir: assembly(stacks()), check: { name: 'odd', isRestricted } }).rule).toBe('ACCESS_RESTRICTION_WEAKENED');
    }
    expect(M.evaluateAccessRestriction({ assemblyDir: assembly(stacks()), check: { name: 'no fn' } as unknown as Check }).rule).toBe('ACCESS_RESTRICTION_WEAKENED');
  });

  it('a distribution whose behaviours cannot be read is an unproven entry point', () => {
    for (const cdn of [
      { Type: 'AWS::CloudFront::Distribution', Properties: {} },
      { Type: 'AWS::CloudFront::Distribution', Properties: { DistributionConfig: { DefaultCacheBehavior: {}, CacheBehaviors: { not: 'a list' } } } },
    ]) {
      // Next to a proven entry point, so "no entry point at all" cannot be what denies.
      const d = M.evaluateAccessRestriction({
        assemblyDir: assembly({ Web: { Cdn: cdn, Url: { Type: 'AWS::Lambda::Url' } } }),
        check: { name: 'behaviours and URLs', isRestricted: (e) => e.type === 'AWS::Lambda::Url' || e.behavior != null },
      });
      expect(d.rule, JSON.stringify(cdn)).toBe('ACCESS_RESTRICTION_WEAKENED');
      expect(String(d.reason)).toMatch(/Web\/Cdn\/(unreadable|CacheBehaviors)/);
    }
  });

  it('no entry point at all is not a proof', () => {
    expect(M.evaluateAccessRestriction({ assemblyDir: assembly({ Web: { Bucket: { Type: 'AWS::S3::Bucket' } } }), check: all })).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_WEAKENED' });
  });

  it('entry points in every stack count', () => {
    const d = M.evaluateAccessRestriction({ assemblyDir: assembly({ A: { Cdn: distribution(0) }, B: { Url: { Type: 'AWS::Lambda::Url' } } }), check: { name: 'A only', isRestricted: (e) => e.stackName === 'A' } });
    expect(d.rule).toBe('ACCESS_RESTRICTION_WEAKENED');
    expect(String(d.reason)).toContain('B/Url');
  });
});

describe('the credential never appears in the template (scan runs with or without a check)', () => {
  const fnCode = (code: unknown): J => ({ Fn: { Type: 'AWS::CloudFront::Function', Properties: { FunctionCode: code } } });
  const credential = Buffer.from('owner:s3cret-pass').toString('base64');

  it.each([
    ['in function code', fnCode(`if (h.authorization.value !== "Basic ${credential}") return deny;`)],
    ['lower-case scheme', fnCode(`basic ${credential}`)],
    ['unpadded token', fnCode(`Basic ${Buffer.from('a:bc').toString('base64').replace(/=+$/, '')}`)],
    ['split across Fn::Join parts', fnCode({ 'Fn::Join': ['', ['Basic ', credential.slice(0, 6), credential.slice(6)]] })],
    ['as a header value elsewhere', { P: { Type: 'AWS::CloudFront::OriginRequestPolicy', Properties: { Headers: [{ Name: 'Authorization', Value: `Basic ${credential}` }] } } }],
    ['a KeyValueStore seeded from the template', { Kvs: { Type: 'AWS::CloudFront::KeyValueStore', Properties: { Name: 'auth', ImportSource: { SourceType: 'S3', SourceArn: 'arn:aws:s3:::b/k' } } } }],
  ])('denies: %s', (_l, resources) => {
    for (const check of [null, all]) {
      const d = M.evaluateAccessRestriction({ assemblyDir: assembly({ Web: { ...resources, Cdn: distribution(0) } }), check });
      expect(d, String(check?.name)).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_CREDENTIAL_IN_TEMPLATE' });
      expect(d.accessRestriction.state).not.toBe('verified');
    }
  });

  it.each([
    ['a dynamic reference is a pointer, not a value', fnCode('Basic {{resolve:secretsmanager:or/basic:SecretString:token}}')],
    ['a dynamic reference joined after the scheme', fnCode({ 'Fn::Join': ['', ['Basic ', '{{resolve:ssm:/or/basic-token}}']] })],
    // Read as a token, this reference would decode to `owner:s3cret-pass`; it is a pointer, not a value.
    ['a dynamic reference whose name looks like a token', fnCode(`Basic {{resolve:ssm:xx${Buffer.from('owner:s3cret-pass').toString('base64')}}}`)],
    ['the managed policy name', fnCode('arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')],
    ['prose about basic auth', fnCode('// Basic auth is checked at the edge against a KeyValueStore hash')],
    ['a KeyValueStore a human fills', { Kvs: { Type: 'AWS::CloudFront::KeyValueStore', Properties: { Name: 'auth' } } }],
  ])('allows: %s', (_l, resources) => {
    const d = M.evaluateAccessRestriction({ assemblyDir: assembly({ Web: { ...resources, Cdn: distribution(0) } }), check: null });
    expect(d).toMatchObject({ result: 'allowed', accessRestriction: { state: 'absent' } });
  });

  it('the detector itself: a Basic token that decodes to user:password', () => {
    expect(M.looksLikeBasicCredential(`Basic ${credential}`)).toBe(true);
    expect(M.looksLikeBasicCredential(`x Basic\t${credential}==`)).toBe(true);
    expect(M.looksLikeBasicCredential('Basic YWJj')).toBe(false); // "abc": no colon
    expect(M.looksLikeBasicCredential('Bearer ' + credential)).toBe(false);
    expect(M.looksLikeBasicCredential(42)).toBe(false);
  });
});

describe('fail closed on an assembly that cannot be read', () => {
  it.each([
    ['no manifest', () => scratch()],
    ['manifest with duplicate keys', () => {
      const d = scratch();
      writeFileSync(join(d, 'manifest.json'), '{"artifacts":{},"artifacts":{}}');
      return d;
    }],
    ['no stack', () => assembly({})],
    ['template escapes the assembly', () => {
      const d = scratch();
      writeFileSync(join(d, 'manifest.json'), JSON.stringify({ artifacts: { S: { type: 'aws:cloudformation:stack', properties: { templateFile: '../outside.json' } } } }));
      return d;
    }],
    ['template missing', () => {
      const d = scratch();
      writeFileSync(join(d, 'manifest.json'), JSON.stringify({ artifacts: { S: { type: 'aws:cloudformation:stack', properties: { templateFile: 'S.template.json' } } } }));
      return d;
    }],
    ['template with duplicate keys', () => {
      const d = assembly({ S: {} });
      writeFileSync(join(d, 'S.template.json'), '{"Resources":{},"Resources":{"X":{"Type":"AWS::Lambda::Url"}}}');
      return d;
    }],
  ])('%s', (_l, make) => {
    for (const check of [null, all]) {
      expect(M.evaluateAccessRestriction({ assemblyDir: make(), check })).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_INPUT_INVALID', accessRestriction: { state: 'unverifiable' } });
    }
  });

  it('the CLI denies without an absolute assembly path, and never overwrites a decision', () => {
    const out = scratch();
    const p1 = join(out, 'a.json');
    expect(M.runCli(['--assembly', 'cdk.out'], { env: {}, decisionPath: p1 })).toMatchObject({ exitCode: M.DENIED_EXIT_CODE, record: { rule: 'ACCESS_RESTRICTION_INPUT_INVALID' } });
    expect(M.runCli([], { env: {}, decisionPath: join(out, 'b.json') }).exitCode).toBe(M.DENIED_EXIT_CODE);
    const p2 = join(out, 'c.json');
    writeFileSync(p2, 'pre-existing');
    expect(M.runCli(['--assembly', REAL], { env: {}, decisionPath: p2 }).exitCode).toBe(M.DENIED_EXIT_CODE);
    expect(readFileSync(p2, 'utf8')).toBe('pre-existing');
  });

  it('a symlinked template directory pointing outside the assembly is not read', () => {
    const outside = scratch();
    writeFileSync(join(outside, 'S.template.json'), JSON.stringify({ Resources: {} }));
    const d = scratch();
    mkdirSync(join(d, 'sub'));
    execFileSync('ln', ['-s', outside, join(d, 'ext')]);
    writeFileSync(join(d, 'manifest.json'), JSON.stringify({ artifacts: { S: { type: 'aws:cloudformation:stack', properties: { templateFile: 'ext/S.template.json' } } } }));
    expect(M.evaluateAccessRestriction({ assemblyDir: d, check: null }).rule).toBe('ACCESS_RESTRICTION_INPUT_INVALID');
  });
});

describe('provenance of the copied helpers', () => {
  const fnText = (file: string, name: string) => {
    const text = readFileSync(file, 'utf8');
    const start = text.search(new RegExp(`^(export )?function ${name}\\(`, 'm'));
    expect(start, `${name} in ${file}`).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n}\n', start);
    return text.slice(start, end + 2).replace(/^export /, '');
  };

  it('parseStrictJson and safeTemplatePath are byte-identical to trusted-policy.mjs', () => {
    for (const name of ['parseStrictJson', 'safeTemplatePath']) expect(fnText(MODULE, name)).toBe(fnText(POLICY, name));
  });

  it('names its source in a provenance comment', () => {
    expect(readFileSync(MODULE, 'utf8')).toMatch(/Provenance: infra\/broker\/trusted-policy\.mjs at origin\/main [0-9a-f]{7}/);
  });
});
