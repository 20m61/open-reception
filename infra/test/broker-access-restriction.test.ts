import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  looksLikeCredential: (s: unknown) => boolean;
  isCredentialText: (s: unknown) => boolean;
  NON_VIEWER_FACING_TYPES: ReadonlySet<string>;
  MIN_TOKEN_LENGTH: number;
  MAX_PROJECTED_COMBINATIONS: number;
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

/** A minimal assembly: one stack per entry of `stacks` (name -> Resources), with `extra` template sections. */
const assembly = (stacks: Record<string, J>, extra: J = {}) => {
  const dir = scratch();
  const artifacts: J = {};
  for (const [name, resources] of Object.entries(stacks)) {
    writeFileSync(join(dir, `${name}.template.json`), JSON.stringify({ ...extra, Resources: resources }));
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

  it.each([
    ['public load balancer', { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Scheme: 'internet-facing' } }],
    ['load balancer with the default scheme', { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: {} }],
    ['AppSync API', { Type: 'AWS::AppSync::GraphQLApi', Properties: {} }],
    ['website bucket', { Type: 'AWS::S3::Bucket', Properties: { WebsiteConfiguration: { IndexDocument: 'index.html' } } }],
    ['App Runner service', { Type: 'AWS::AppRunner::Service', Properties: {} }],
    ['Amplify app', { Type: 'AWS::Amplify::App', Properties: {} }],
    ['Cognito hosted domain', { Type: 'AWS::Cognito::UserPoolDomain', Properties: {} }],
    ['Lightsail instance', { Type: 'AWS::Lightsail::Instance', Properties: {} }],
    ['HTTP API', { Type: 'AWS::ApiGatewayV2::Api', Properties: {} }],
    ['a type nobody classified', { Type: 'AWS::Some::NewThing', Properties: {} }],
    ['a resource without a type', { Properties: {} }],
    // #1214 AC4: decided here, not by relying on the trusted policy's S3 allowlist and principal review.
    ['bucket with a canned ACL', { Type: 'AWS::S3::Bucket', Properties: { AccessControl: 'PublicRead' } }],
    ['bucket whose Properties are an intrinsic', { Type: 'AWS::S3::Bucket', Properties: { 'Fn::If': ['C', { WebsiteConfiguration: { IndexDocument: 'i' } }, {}] } }],
    ['bucket whose Properties are not an object', { Type: 'AWS::S3::Bucket', Properties: ['x'] }],
    ['bucket policy allowing Principal "*"', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject' }] } } }],
    // #1217 AC4: a string principal is public whenever it contains `*`, not only when it is exactly `*`.
    ['bucket policy allowing a string principal with a wildcard', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: 'arn:aws:iam::*:root', Action: 's3:GetObject' }] } } }],
    // #1217 AC4: only the Arn / S3CanonicalUserId of a template resource names one principal.
    ['bucket policy allowing an Fn::GetAtt that is not an Arn', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { AWS: { 'Fn::GetAtt': ['Thing', 'Name'] } }, Action: 's3:GetObject' }] } } }],
    ['bucket policy allowing an Fn::GetAtt without an attribute', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { AWS: { 'Fn::GetAtt': 'Thing.Arn' } }, Action: 's3:GetObject' }] } } }],
    // #1217 AC4: CDK emits BucketDeployment `accessControl` as `SystemMetadata.acl`.
    ['bucket deployment with a public-read object ACL', { Type: 'Custom::CDKBucketDeployment', Properties: { SystemMetadata: { acl: 'public-read' } } }],
    ['bucket deployment with an upper-case ACL key', { Type: 'Custom::CDKBucketDeployment', Properties: { SystemMetadata: { ACL: 'authenticated-read' } } }],
    ['bucket deployment with a non-literal ACL', { Type: 'Custom::CDKBucketDeployment', Properties: { SystemMetadata: { acl: { Ref: 'Acl' } } } }],
    ['bucket deployment with non-literal metadata', { Type: 'Custom::CDKBucketDeployment', Properties: { SystemMetadata: { 'Fn::If': ['C', { acl: 'public-read' }, {}] } } }],
    ['bucket deployment whose metadata is not an object', { Type: 'Custom::CDKBucketDeployment', Properties: { SystemMetadata: ['public-read'] } }],
    ['bucket deployment whose Properties are an intrinsic', { Type: 'Custom::CDKBucketDeployment', Properties: { 'Fn::If': ['C', { SystemMetadata: { acl: 'public-read' } }, {}] } }],
    ['bucket deployment whose Properties are not an object', { Type: 'Custom::CDKBucketDeployment', Properties: 'x' }],
    ['bucket policy allowing {AWS: "*"}', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { AWS: '*' }, Action: 's3:GetObject' }] } } }],
    ['bucket policy allowing {AWS: ["*"]}', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { AWS: ['arn:aws:iam::1:role/r', '*'] }, Action: 's3:GetObject' }] } } }],
    ['bucket policy with an Allow and NotPrincipal', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', NotPrincipal: { AWS: 'arn:aws:iam::1:root' }, Action: 's3:GetObject' }] } } }],
    ['bucket policy with a non-literal Effect', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: [{ Effect: { 'Fn::If': ['C', 'Allow', 'Deny'] }, Principal: '*', Action: 's3:GetObject' }] } } }],
    ['bucket policy with a non-literal statement', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: [{ 'Fn::If': ['C', { Effect: 'Allow', Principal: '*' }, { Ref: 'AWS::NoValue' }] }] } } }],
    ['bucket policy whose statement is not a literal object', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: ['x'] } } }],
    ['bucket policy with a non-literal document', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { 'Fn::If': ['C', { Statement: [] }, {}] } } }],
    ['bucket policy with a non-literal principal', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { AWS: { Ref: 'Who' } }, Action: 's3:GetObject' }] } } }],
    ['bucket policy with a principal that is not an object', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: ['*'], Action: 's3:GetObject' }] } } }],
  ])('a declared check must prove a %s too (fail closed)', (_l, resource) => {
    const proveCdn: Check = { name: 'cdn only', isRestricted: (e) => e.type === 'AWS::CloudFront::Distribution' };
    const d = M.evaluateAccessRestriction({ assemblyDir: assembly({ Web: { Cdn: distribution(0), X: resource } }), check: proveCdn });
    expect(d).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_WEAKENED' });
    expect(String(d.reason)).toContain('Web/X');
    expect(M.evaluateAccessRestriction({ assemblyDir: assembly({ Web: { Cdn: distribution(0), X: resource } }), check: all }).accessRestriction).toEqual({ state: 'verified' });
  });

  it('internal resources are not entry points: an internal load balancer, a plain bucket, the allowlisted types', () => {
    const internal = {
      Lb: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Scheme: 'internal' } },
      Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      // The real assembly's reviewed shape: a Deny to everyone, an Allow to a local role and to a service.
      Policy: {
        Type: 'AWS::S3::BucketPolicy',
        Properties: {
          PolicyDocument: {
            Statement: [
              { Effect: 'Deny', Principal: { AWS: '*' }, Action: 's3:*' },
              { Effect: 'Allow', Principal: { AWS: { 'Fn::GetAtt': ['Role', 'Arn'] } }, Action: 's3:DeleteObject*' },
              { Effect: 'Allow', Principal: { CanonicalUser: { 'Fn::GetAtt': ['Oai', 'S3CanonicalUserId'] } }, Action: 's3:GetObject' },
              { Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject' },
            ],
          },
        },
      },
      ...Object.fromEntries([...M.NON_VIEWER_FACING_TYPES].map((t, i) => [`R${i}`, { Type: t, Properties: {} }])),
      // The real assembly's deployment shape, and the canned ACLs that grant nobody outside the owner.
      Deploy: { Type: 'Custom::CDKBucketDeployment', Properties: { SystemMetadata: { 'cache-control': 'public,max-age=31536000,immutable' } } },
      DeployPrivate: { Type: 'Custom::CDKBucketDeployment', Properties: { SystemMetadata: { acl: 'private' } } },
      DeployOwner: { Type: 'Custom::CDKBucketDeployment', Properties: { SystemMetadata: { acl: 'bucket-owner-full-control' } } },
      DeployNoProps: { Type: 'Custom::CDKBucketDeployment' },
    };
    const seen: string[] = [];
    const d = M.evaluateAccessRestriction({ assemblyDir: assembly({ Web: { Cdn: distribution(0), ...internal } }), check: { name: 'spy', isRestricted: (e) => (seen.push(e.entry), true) } });
    expect(d.accessRestriction).toEqual({ state: 'verified' });
    expect(seen).toEqual(['Cdn/DefaultCacheBehavior']);
    for (const t of ['AWS::S3::Bucket', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::Lambda::Url', 'AWS::CloudFront::Distribution', 'AWS::CloudFormation::Stack']) {
      expect(M.NON_VIEWER_FACING_TYPES.has(t), t).toBe(false);
    }
    expect([...M.NON_VIEWER_FACING_TYPES].some((t) => /ApiGateway|AppSync|AppRunner|Amplify|Lightsail|ElasticLoadBalancing|UserPoolDomain/.test(t))).toBe(false);
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
    ['unpadded token', fnCode(`Basic ${Buffer.from('ab:cdefg').toString('base64').replace(/=+$/, '')}`)],
    ['string concatenation in function code', fnCode(`if (auth !== "Basic " + "${credential}") return deny;`)],
    ['URL-encoded scheme and padding', fnCode(`Basic%20${credential.replace(/=/g, '%3D')}`)],
    ['a token anywhere, without the scheme', fnCode(`const expected = '${credential}';`)],
    ['URL-safe base64', fnCode(`const t = '${Buffer.from('owner:s3cret>>?pass').toString('base64url')}';`)],
    ['Fn::Base64 of a plain user:password literal', { P: { Type: 'AWS::CloudFront::OriginRequestPolicy', Properties: { V: { 'Fn::Base64': 'owner:s3cret-pass' } } } }],
    ['Fn::Base64 of a Join that builds user:password', { P: { Type: 'AWS::CloudFront::OriginRequestPolicy', Properties: { V: { 'Fn::Base64': { 'Fn::Join': [':', ['owner', 's3cret-pass']] } } } } }],
    ['a plain user:password after the scheme', fnCode('if (h !== "Basic owner:s3cret-pass") return deny;')],
    ['a plain user:password passed to btoa', fnCode('var expected = "Basic " + btoa("owner:s3cret-pass");')],
    ['a nested Join', fnCode({ 'Fn::Join': ['', ['Basic ', { 'Fn::Join': ['', [credential.slice(0, 5), { 'Fn::Join': ['', [credential.slice(5, 12), credential.slice(12)]] }]] }]] })],
    ['Fn::Sub with a literal variable', fnCode({ 'Fn::Sub': ['Basic ${A}${B}', { A: credential.slice(0, 9), B: credential.slice(9) }] })],
    ['Fn::Select of a literal list', fnCode({ 'Fn::Join': ['', ['Basic ', { 'Fn::Select': [1, ['x', credential]] }]] })],
    ['Fn::Select over Fn::Split', fnCode({ 'Fn::Select': [1, { 'Fn::Split': ['|', `x|${credential}`] }] })],
    ['split across Fn::Join parts', fnCode({ 'Fn::Join': ['', ['Basic ', credential.slice(0, 6), credential.slice(6)]] })],
    // #1214 AC1: both branches of an Fn::If are projected (the projections read it as a NUL).
    ['Fn::Base64 of an Fn::If whose first branch is user:password', { P: { Type: 'AWS::CloudFront::OriginRequestPolicy', Properties: { V: { 'Fn::Base64': { 'Fn::If': ['C', 'user:pass', 'x'] } } } } }],
    ['Fn::Base64 of an Fn::If whose second branch is user:password', { P: { Type: 'AWS::CloudFront::OriginRequestPolicy', Properties: { V: { 'Fn::Base64': { 'Fn::If': ['C', 'x', 'user:pass'] } } } } }],
    ['Fn::Base64 of a Join through an Fn::If', { P: { Type: 'AWS::CloudFront::OriginRequestPolicy', Properties: { V: { 'Fn::Base64': { 'Fn::Join': [':', ['owner', { 'Fn::If': ['C', 's3cret-pass', 'x'] }]] } } } } }],
    ['a token split across Fn::Join parts, one part through an Fn::If', fnCode({ 'Fn::Join': ['', ['Basic ', credential.slice(0, 6), { 'Fn::If': ['C', credential.slice(6), 'x'] }]] })],
    // Mixed branches: the credential needs the first branch of one Fn::If and the second of another.
    ['a token split across two Fn::If, first branch of one and second of the other', fnCode({ 'Fn::Join': ['', ['Basic ', { 'Fn::If': ['A', credential.slice(0, 6), 'x'] }, { 'Fn::If': ['B', 'y', credential.slice(6)] }]] })],
    ['Fn::Base64 of user:password split across two Fn::If with mixed branches', { P: { Type: 'AWS::CloudFront::OriginRequestPolicy', Properties: { V: { 'Fn::Base64': { 'Fn::Join': [':', [{ 'Fn::If': ['A', 'owner', 'x'] }, { 'Fn::If': ['B', 'y', 's3cret-pass'] }]] } } } } }],
    ['an Fn::If nested in a branch of another', { P: { Type: 'AWS::CloudFront::OriginRequestPolicy', Properties: { V: { 'Fn::Base64': { 'Fn::If': ['A', { 'Fn::If': ['B', 'x', 'user:pass'] }, 'y'] } } } } }],
    // An Fn::If outside any projected intrinsic keeps both branches, so a Join in its second branch is projected too.
    ['mixed-branch Fn::If inside a Join in the second branch of an outer Fn::If', fnCode({ 'Fn::If': ['O', 'plain', { 'Fn::Join': ['', ['Basic ', { 'Fn::If': ['A', credential.slice(0, 6), 'x'] }, { 'Fn::If': ['B', 'y', credential.slice(6)] }]] }] })],
    // A whole literal inside an Fn::If is an ordinary nested string and was always scanned.
    ['a plain string inside an Fn::If', fnCode({ 'Fn::If': ['C', `Basic ${credential}`, 'x'] })],
    // #1214 AC2: RFC 7617 allows spaces in the password.
    ['a password with a space', fnCode(`const t = '${Buffer.from('owner:s3cret pass').toString('base64')}';`)],
    // #1214 AC3: `/` is a base64 character, so a token after a path separator is tried on its own.
    ['a token right after a slash', fnCode(`if (uri === "/${Buffer.from('owner:s3cret-pass').toString('base64')}") return ok;`)],
    ['a token between path separators', fnCode(`fetch("https://h/auth/${Buffer.from('owner:s3cret-pa').toString('base64')}/check")`)],
    // #1217 NIT: padding may be followed by `/` (about 2/3 of credential lengths are padded).
    ['a padded token between path separators', fnCode(`fetch("https://h/auth/${Buffer.from('owner:s3cret-pass').toString('base64')}/check")`)],
    ['a doubly padded token between path separators', fnCode(`fetch("https://h/auth/${Buffer.from('owner:s3cret-pas').toString('base64')}/check")`)],
    // #1217 AC3: an Fn::Select whose index is not a literal may pick any element of its literal list.
    ['Fn::Select with a Ref index, credential completed by the second element', fnCode({ 'Fn::Join': ['', ['Basic ', credential.slice(0, 6), { 'Fn::Select': [{ Ref: 'Index' }, ['x', credential.slice(6)]] }]] })],
    // Any non-literal index, not only `Ref` (an Fn::If index is also covered by its own branches).
    ['Fn::Select with an Fn::FindInMap index', fnCode({ 'Fn::Join': ['', ['Basic ', credential.slice(0, 6), { 'Fn::Select': [{ 'Fn::FindInMap': ['M', 'K', 'V'] }, ['x', credential.slice(6)]] }]] })],
    ['Fn::Select with an Fn::If index', fnCode({ 'Fn::Join': ['', ['Basic ', credential.slice(0, 6), { 'Fn::Select': [{ 'Fn::If': ['C', 0, 1] }, ['x', credential.slice(6)]] }]] })],
    ['Fn::Select with a Ref index over Fn::Split', fnCode({ 'Fn::Join': ['', ['Basic ', credential.slice(0, 6), { 'Fn::Select': [{ Ref: 'Index' }, { 'Fn::Split': ['|', `x|${credential.slice(6)}|y`] }] }]] })],
    ['Fn::Base64 of an Fn::Select with a Ref index', { P: { Type: 'AWS::CloudFront::OriginRequestPolicy', Properties: { V: { 'Fn::Base64': { 'Fn::Select': [{ Ref: 'Index' }, ['x', 'owner:s3cret-pass']] } } } } }],
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

  it('the detector itself: a token that decodes to a printable user:password', () => {
    expect(M.looksLikeCredential(`Basic ${credential}`)).toBe(true);
    expect(M.looksLikeCredential(`x Basic\t${credential}`)).toBe(true);
    expect(M.looksLikeCredential(`Bearer ${credential}`)).toBe(true); // the token, not the scheme, is the secret
    expect(M.looksLikeCredential('Basic YWJj')).toBe(false); // "abc": no colon
    expect(M.looksLikeCredential(Buffer.from(':nouser-pass').toString('base64'))).toBe(false); // RFC 7617: empty user
    expect(M.looksLikeCredential(Buffer.from('us er:pass12').toString('base64'))).toBe(false);
    expect(M.looksLikeCredential(Buffer.from('owner:\u0001\u0002pass').toString('base64'))).toBe(false); // not printable
    expect(M.looksLikeCredential(Buffer.from('a:bcd').toString('base64'))).toBe(false); // below the minimum token length
    expect(M.MIN_TOKEN_LENGTH).toBe(8);
    expect(M.looksLikeCredential(Buffer.from('a:bcde').toString('base64'))).toBe(true); // exactly the minimum
    expect(M.looksLikeCredential(`x${credential}`)).toBe(false); // misaligned inside a longer run is not this token
    expect(M.looksLikeCredential(42)).toBe(false);
    expect(M.isCredentialText('owner:pass')).toBe(true);
    expect(M.isCredentialText('{{resolve:ssm:x}}')).toBe(false);
  });

  it('a password may contain spaces (RFC 7617); the user part still may not, and must not be empty', () => {
    expect(M.isCredentialText('user:pa ss')).toBe(true);
    expect(M.looksLikeCredential(Buffer.from('user:pa ss').toString('base64'))).toBe(true);
    expect(M.looksLikeCredential(Buffer.from('owner: leading space').toString('base64'))).toBe(true);
    expect(M.isCredentialText('us er:pass')).toBe(false);
    expect(M.isCredentialText(':pa ss')).toBe(false);
    expect(M.isCredentialText('user:pa\tss')).toBe(false); // printable ASCII only
  });

  it('a token after `/` is tried on its own; the full run still is too', () => {
    const userPass = Buffer.from('user:pass').toString('base64');
    expect(userPass).toBe('dXNlcjpwYXNz');
    expect(M.looksLikeCredential(`/${userPass}`)).toBe(true);
    expect(M.looksLikeCredential(`a/b/${userPass}`)).toBe(true);
    expect(M.looksLikeCredential(`/x/${userPass}/y`)).toBe(true);
    expect(M.looksLikeCredential(`/x/${userPass}/longer-segment`)).toBe(true);
    // A credential whose own base64 contains `/` is still read as one run.
    const withSlash = Buffer.from('owner:s3cret>>?pass').toString('base64');
    expect(withSlash).toContain('/');
    expect(M.looksLikeCredential(withSlash)).toBe(true);
    // A piece shorter than the minimum token length is not tried.
    expect(M.looksLikeCredential(`/${Buffer.from('a:bcd').toString('base64')}`)).toBe(false);
    // A padded token may be followed by `/`; a padded token followed by any other base64 character is still a miss.
    const padded = Buffer.from('user:passwd').toString('base64');
    expect(padded).toMatch(/[^=]=$/);
    expect(M.looksLikeCredential(`/a/${padded}/b`)).toBe(true);
    expect(M.looksLikeCredential(`${padded}/`)).toBe(true);
    expect(M.looksLikeCredential(`${padded}x`)).toBe(false);
  });

  /** The definition the linear scan must agree with: every part between `/` boundaries, decoded on its own (base64 path only). */
  const naive = (text: string): boolean => {
    for (const m of text.matchAll(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{8,}={0,2}(?![A-Za-z0-9+=_-])/g)) {
      const run = m[0];
      const starts = [0, ...[...run].flatMap((c, i) => (c === '/' ? [i + 1] : []))];
      const ends = [...[...run].flatMap((c, i) => (c === '/' ? [i] : [])), run.length];
      for (const s of starts) {
        for (const e of ends) {
          const body = run.slice(s, e).replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
          if (e - s < M.MIN_TOKEN_LENGTH || body.length < M.MIN_TOKEN_LENGTH || body.length % 4 === 1) continue;
          if (M.isCredentialText(Buffer.from(body, 'base64').toString('latin1'))) return true;
        }
      }
    }
    return false;
  };

  it('#1217 AC1: the linear scan agrees with decoding every part between `/` on its own', () => {
    let seed = 1217;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const pieces = [
      () => Buffer.from(Array.from({ length: 2 + next(10) }, () => 'ab:: {}?>~-_x01'[next(15)]).join('')).toString(next(3) === 0 ? 'base64url' : 'base64'),
      () => '/',
      () => Array.from({ length: 1 + next(5) }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[next(64)]).join(''),
      () => ['=', ' ', 'x', '"', '.'][next(5)], // no `%` or `Basic `: those paths are pinned on their own above
      () => `/${Buffer.from(`u:${'p'.repeat(next(9))}`).toString('base64')}`,
    ];
    let positives = 0;
    for (let i = 0; i < 20000; i += 1) {
      const text = Array.from({ length: 1 + next(8) }, () => pieces[next(pieces.length)]!()).join('');
      const expected = naive(text);
      if (expected) positives += 1;
      expect(M.looksLikeCredential(text), JSON.stringify(text)).toBe(expected);
    }
    expect(positives).toBeGreaterThan(2000); // the comparison is not vacuous
    // Found by that comparison: a part of length 1 modulo 4 after a `/` at an unaligned start decodes nothing.
    // Built at runtime (not a literal) so secret scanners do not flag a fixture: `owner:pass53` in base64.
    expect(M.looksLikeCredential(`aDF9Pn4/${Buffer.from('owner:pass53').toString('base64')}x`)).toBe(false);
    // A long user: the part checked must reach past the colon, so a byte before it that is not printable is seen.
    expect(M.looksLikeCredential(Buffer.from('abcdefghijklmnopqrstu:pass').toString('base64'))).toBe(true);
    expect(M.looksLikeCredential(Buffer.from('abcdefghijklmnopq\u0001stu:pass').toString('base64'))).toBe(false);
    expect(M.looksLikeCredential(`/x/${Buffer.from('abcdefghijklmnopq\u0001stu:pass').toString('base64')}`)).toBe(false);
    // The part ending at the `/` decodes to `abcdefghijklmnopqr` (no colon); the colon is only in a longer part,
    // after bytes that are not printable. Checking the part that ends before the colon would call it a credential.
    expect(M.looksLikeCredential(`${Buffer.from('abcdefghijklmnopqr').toString('base64')}/QEpOtn4Y`)).toBe(false);
  });

  it('#1217 AC1: a long base64 run with many `/` is scanned in bounded time and decides without throwing', () => {
    let seed = 60;
    const bytes = Buffer.from(
      Array.from({ length: 45000 }, () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed >>> 24;
      }),
    );
    const random = bytes.toString('base64'); // 60 KB, about one `/` in 64
    expect(random.length).toBe(60000);
    expect(random.split('/').length).toBeGreaterThan(500);
    const userPass = Buffer.from('user:pass').toString('base64');
    for (const [text, expected] of [
      [random, false],
      ['ab/'.repeat(20000), false], // a list of every part did not fit in memory (RangeError)
      ['Pz8/'.repeat(15000), false], // every part decodes to printable `???...` up to the run's end
      [`${random}/${userPass}`, true], // the fast path still finds the token at the end
    ] as const) {
      const t = Date.now();
      expect(M.looksLikeCredential(text)).toBe(expected);
      expect(Date.now() - t, text.slice(0, 16)).toBeLessThan(2000);
    }
    const d = M.evaluateAccessRestriction({ assemblyDir: assembly({ Web: { ...fnCode('ab/'.repeat(20000)), Cdn: distribution(0) } }), check: null });
    expect(d).toMatchObject({ result: 'allowed', rule: null, accessRestriction: { state: 'absent' } });
  });

  describe('#1217 AC2: the projection bound is counted per outermost projected intrinsic', () => {
    const ifs = (n: number, prefix = 'C'): J[] => Array.from({ length: n }, (_, i) => ({ 'Fn::If': [`${prefix}${i}`, 'a', 'b'] }));
    const join = (parts: unknown[]): J => ({ 'Fn::Join': ['', parts] });
    const run = (resources: J, check: Check = null) => M.evaluateAccessRestriction({ assemblyDir: assembly({ Web: { ...resources, Cdn: distribution(0) } }), check });
    const tooComplex = { result: 'denied', rule: 'ACCESS_RESTRICTION_INPUT_INVALID', accessRestriction: { state: 'unverifiable', reason: 'template too complex to scan' } };

    it('more combinations than the bound in one intrinsic is not projected: a named deny of its own reason, not a credential alarm', () => {
      expect(M.MAX_PROJECTED_COMBINATIONS).toBe(64);
      for (const check of [null, all]) {
        const over = run(fnCode(join(ifs(7))), check);
        expect(over).toMatchObject(tooComplex);
        expect(String(over.reason)).toContain('fail closed');
        expect(String(over.reason)).toContain('Web: 1 ');
      }
      expect(run(fnCode(join(ifs(6))))).toMatchObject({ result: 'allowed' });
      // An Fn::Select with a non-literal index offers one choice per element.
      expect(run(fnCode(join([{ 'Fn::Select': [{ Ref: 'I' }, Array.from({ length: 65 }, (_, i) => `e${i}`)] }])))).toMatchObject(tooComplex);
      expect(run(fnCode(join([{ 'Fn::Select': [{ Ref: 'I' }, Array.from({ length: 64 }, (_, i) => `e${i}`)] }])))).toMatchObject({ result: 'allowed' });
      expect(run(fnCode(join([...ifs(5), { 'Fn::Select': [{ Ref: 'I' }, ['a', 'b', 'c']] }])))).toMatchObject(tooComplex); // 32 x 3
    });

    it('Fn::If nested under an intrinsic inside the outermost one count towards the outermost one', () => {
      expect(run(fnCode(join([...ifs(3), join(ifs(4, 'D'))])))).toMatchObject(tooComplex);
      expect(run(fnCode({ 'Fn::Base64': join([...ifs(3), { 'Fn::Sub': ['${A}', { A: join(ifs(4, 'D')) }] }]) }))).toMatchObject(tooComplex);
    });

    it('seven unrelated resources with one Fn::If each are allowed; Fn::If under different intrinsics never combine', () => {
      const resources = Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [`P${i}`, { Type: 'AWS::CloudFront::OriginRequestPolicy', Properties: { V: join(['x-', { 'Fn::If': [`C${i}`, 'a', 'b'] }]) } }]),
      );
      expect(run(resources)).toMatchObject({ result: 'allowed', rule: null });
      expect(run(fnCode([join(ifs(6)), join(ifs(6, 'D')), join(ifs(6, 'E'))]))).toMatchObject({ result: 'allowed' });
      // Fn::If outside any projected intrinsic cannot split a projection and does not count.
      expect(run(fnCode(ifs(10)))).toMatchObject({ result: 'allowed' });
    });

    it('credential first: a credential anywhere is reported as one even when an intrinsic is too complex to project', () => {
      const credentialInBranches = join(['Basic ', { 'Fn::If': ['A', credential.slice(0, 6), 'x'] }, { 'Fn::If': ['B', 'y', credential.slice(6)] }]);
      const cases: J[] = [
        { ...fnCode(join(ifs(7))), Plain: { Type: 'AWS::CloudFront::OriginRequestPolicy', Properties: { V: `Basic ${credential}` } } },
        // Only visible under one combination of another intrinsic, listed after the complex one.
        { ...fnCode([join(ifs(7)), credentialInBranches]) },
        // Inside the complex intrinsic itself, as a literal.
        { ...fnCode(join([...ifs(7), `Basic ${credential}`])) },
      ];
      for (const resources of cases) {
        for (const check of [null, all]) expect(run(resources, check), JSON.stringify(resources).slice(0, 80)).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_CREDENTIAL_IN_TEMPLATE' });
      }
      // In another stack of the same assembly.
      const d = M.evaluateAccessRestriction({ assemblyDir: assembly({ A: fnCode(join(ifs(7))), B: fnCode(`Basic ${credential}`) }), check: null });
      expect(d).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_CREDENTIAL_IN_TEMPLATE' });
    });

    it('an Fn::Select with a literal index or a non-literal list offers no choice', () => {
      expect(run(fnCode(join([{ 'Fn::Select': [0, Array.from({ length: 100 }, (_, i) => `e${i}`)] }])))).toMatchObject({ result: 'allowed' });
      expect(run(fnCode(join([{ 'Fn::Select': [{ Ref: 'I' }, { 'Fn::GetAZs': '' }] }])))).toMatchObject({ result: 'allowed' });
    });
  });

  it('#1217 AC1: an internal failure is a named deny that escalates, never a crash without a decision', () => {
    const throwingName = {
      get name(): string {
        throw new RangeError('boom');
      },
      isRestricted: () => true,
    } as unknown as Check;
    const dir = assembly({ Web: { Cdn: distribution(0) } });
    expect(M.evaluateAccessRestriction({ assemblyDir: dir, check: throwingName })).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_INPUT_INVALID', accessRestriction: { state: 'unverifiable' } });
    const out = scratch();
    const decisionPath = join(out, 'd.json');
    expect(M.runCli(['--assembly', dir], { env: {}, check: throwingName, decisionPath }).exitCode).toBe(M.DENIED_EXIT_CODE);
    expect(JSON.parse(readFileSync(decisionPath, 'utf8'))).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_INPUT_INVALID' });
  });

  it('a credential used as an object KEY (e.g. under Mappings) is found', () => {
    const extra = { Mappings: { Auth: { [credential]: { Header: 'Authorization' } } } };
    for (const check of [null, all]) {
      const d = M.evaluateAccessRestriction({ assemblyDir: assembly({ Web: { Cdn: distribution(0) } }, extra), check });
      expect(d, String(check?.name)).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_CREDENTIAL_IN_TEMPLATE' });
    }
    // Control: the same template without the key is allowed, so the key is what denies.
    const control = { Mappings: { Auth: { Basic: { Header: 'Authorization' } } } };
    expect(M.evaluateAccessRestriction({ assemblyDir: assembly({ Web: { Cdn: distribution(0) } }, control), check: null })).toMatchObject({ result: 'allowed' });
  });

  it('negative control: ordinary template base64 and hashes are not credentials', () => {
    const hashes = [
      'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=', // Lambda CodeSha256 shape
      'faa95a81ae7d7373f3e1f242268f904eb748d8d0fdd306e8a6fe515a1905a7d6.zip', // asset object key
      'cdk-hnb659fds-assets-822063948773-ap-northeast-1',
      'AWSLambdaBasicExecutionRole',
      'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'dynamodb:ConditionCheckItem',
      'OpenReception-Web-dev/Distribution/Resource',
      Buffer.from('#!/bin/bash\necho a:b\n').toString('base64'), // user data: not a single printable line
    ];
    for (const h of hashes) expect(M.looksLikeCredential(h), h).toBe(false);
    const d = M.evaluateAccessRestriction({ assemblyDir: assembly({ Web: { Fn: { Type: 'AWS::Lambda::Function', Properties: { CodeSha256: hashes[0], Code: { S3Key: hashes[1] }, UserData: { 'Fn::Base64': '#!/bin/bash\nexit 0\n' } } } } }), check: null });
    expect(d).toMatchObject({ result: 'allowed', accessRestriction: { state: 'absent' } });
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
    ['a nested stack (its template is not scanned)', () => assembly({ S: { Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'https://x/child.json' } } } })],
    ['a nested cloud assembly', () => {
      const d = assembly({ S: {} });
      const m = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'));
      m.artifacts.Nested = { type: 'cdk:cloud-assembly', properties: { directoryName: 'nested' } };
      writeFileSync(join(d, 'manifest.json'), JSON.stringify(m));
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

  it('the copied helpers are byte-identical to trusted-policy.mjs', () => {
    for (const name of ['isRecord', 'parseStrictJson', 'safeTemplatePath', 'joinedLiterals', 'literalProjection', 'literalList']) expect(fnText(MODULE, name), name).toBe(fnText(POLICY, name));
  });

  it('names its source in a provenance comment', () => {
    expect(readFileSync(MODULE, 'utf8')).toMatch(/Provenance: infra\/broker\/trusted-policy\.mjs at origin\/main [0-9a-f]{7}/);
  });
});

describe('ordering: a nested stack or assembly never reaches the S6c module unchecked', () => {
  /** The real assembly, modified: the trusted policy (which runs first in the buildspec) and this module must both refuse it. */
  const realWith = (mutate: (dir: string) => void) => {
    const dir = scratch();
    cpSync(REAL, dir, { recursive: true });
    mutate(dir);
    return dir;
  };
  const nestedStack = (dir: string) => {
    const f = join(dir, 'OpenReception-Web-dev.template.json');
    const t = JSON.parse(readFileSync(f, 'utf8'));
    t.Resources.Child = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'https://example.invalid/child.json' } };
    writeFileSync(f, JSON.stringify(t));
  };
  const nestedAssembly = (dir: string) => {
    const f = join(dir, 'manifest.json');
    const m = JSON.parse(readFileSync(f, 'utf8'));
    m.artifacts.Nested = { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Nested' } };
    writeFileSync(f, JSON.stringify(m));
  };

  it.each([
    ['nested stack', nestedStack, 'RESOURCE_TYPE_NOT_APPROVED'],
    ['nested cloud assembly', nestedAssembly, 'NESTED_ASSEMBLY'],
  ])('a %s is denied by the trusted policy and, independently, by this module', async (_l, mutate, policyRule) => {
    const policy = (await import(pathToFileURL(POLICY).href)) as { evaluateAssembly: (i: J) => J };
    const dir = realWith(mutate);
    const p = policy.evaluateAssembly({ assemblyDir: dir, targetAccount: '822063948773' });
    expect(p.result).toBe('denied');
    expect((p.violations as J[]).map((v) => v.rule)).toContain(policyRule);
    for (const check of [null, all]) {
      expect(M.evaluateAccessRestriction({ assemblyDir: dir, check })).toMatchObject({ result: 'denied', rule: 'ACCESS_RESTRICTION_INPUT_INVALID' });
    }
  });

  it('the unmodified real assembly passes the trusted policy, so the denial above is the nesting', async () => {
    const policy = (await import(pathToFileURL(POLICY).href)) as { evaluateAssembly: (i: J) => J };
    const v = (policy.evaluateAssembly({ assemblyDir: realWith(() => {}), targetAccount: '822063948773' }).violations as J[]).map((x) => x.rule);
    expect(v).not.toContain('RESOURCE_TYPE_NOT_APPROVED');
    expect(v).not.toContain('NESTED_ASSEMBLY');
  });
});
