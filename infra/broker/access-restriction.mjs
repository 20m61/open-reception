#!/usr/bin/env node
/**
 * Access-restriction gate for the trusted dev-deploy broker (#1153 / #1146, Foundation
 * safe-dev-deploy S6c, owner decision D-5 of 2026-10-03).
 *
 * The looser sparse-deploy profile (soft ceiling 5, 1 h cooldown, one waiver) applies only while
 * the target is **access-restricted**: every viewer-facing entry point refuses requests without a
 * credential issued to named people. That is a property the broker derives from the synthesized
 * template, never a claim of the candidate (S7). This module derives it:
 *
 * - `absent`: the product declares no restriction check (`PRODUCT_RESTRICTION_CHECK = null`).
 *   open-reception declares none today, so its effective policy stays 1 target / 2 ceiling;
 * - `verified`: a check is declared and proves EVERY possible entry point restricted. Fail closed:
 *   every resource whose type is not on the short NON_VIEWER_FACING_TYPES allowlist is an entry
 *   point (CloudFront distributions count once per behaviour; an S3 bucket only with
 *   `WebsiteConfiguration`, `AccessControl` or non-literal `Properties`, a bucket policy only when
 *   it may Allow anyone, a CDK bucket deployment only when its `SystemMetadata` is not on a
 *   known-safe allowlist (it may set a public object ACL or grant); an ELBv2 load balancer unless its
 *   `Scheme` is the literal `internal`),
 *   so a function URL, API Gateway, AppSync, App Runner, Amplify, a Cognito domain, a public load
 *   balancer, or any type nobody classified must be proven too. No entry point at all is not a
 *   proof;
 * - `unverifiable`: a check is declared but cannot prove one of them. A declared check that is
 *   not `verified` is `ACCESS_RESTRICTION_WEAKENED`: the change removes, bypasses or weakens the
 *   restriction (S5 envelope change), a human gate, not an autonomous deploy.
 *
 * Independently of any check, a best-effort scan looks for the restriction's credential in the
 * template (S6c): any base64 token (standard or URL-safe, also after `%`-decoding, also each part
 * of a run between `/` boundaries, at least MIN_TOKEN_LENGTH characters) that decodes to a
 * printable `user:password` (RFC 7617), a
 * `user:password` literal after `Basic `, passed to `btoa(...)` / `Buffer.from(...)`, or given to
 * `Fn::Base64`, over every string and the recursive literal projection of every `Fn::Join` /
 * `Fn::Sub` / `Fn::Select` / `Fn::Base64` node, under every combination of the values the projection
 * reads as a NUL inside it (the branches of an `Fn::If`, the elements of an `Fn::Select` whose index
 * is not a literal, also when the choice only appears after another is substituted; more than
 * MAX_PROJECTED_COMBINATIONS per outermost node is not fully projected and denies
 * `ACCESS_RESTRICTION_INPUT_INVALID` unless a credential is found anyway); and a CloudFront
 * KeyValueStore seeded from the template (`ImportSource`). Any of these denies
 * `ACCESS_RESTRICTION_CREDENTIAL_IN_TEMPLATE`. A
 * `{{resolve:...}}` dynamic reference is a pointer, not a value. This is a guard, not a guarantee:
 * code outside the template (Lambda@Edge / asset bundles) and credentials built at runtime are not
 * seen. The guarantee is S6c's "only a verifier is deployed, and a human writes it".
 *
 * An assembly that cannot be read, that nests a stack or a cloud assembly (whose templates this
 * module would not scan), whose projections could exceed MAX_PROJECTED_LENGTH, or whose evaluation
 * throws for any other reason, denies `ACCESS_RESTRICTION_INPUT_INVALID`. A process that dies without
 * writing a decision (heap exhaustion) fails the build: the buildspec requires an allowed decision.
 *
 * The decision (`evaluateAccessRestriction`) is pure over the assembly directory. The CLI writes it
 * to DECISION_PATH (exclusive create in the broker-owned output dir) with this execution's id and
 * revision; `ledger-runner.mjs reserve` treats anything but a matching `verified` as `unverifiable`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCESS_RESTRICTION_VERSION = 1;
export const BROKER_OUT_DIR = '/tmp/open-reception-broker-out';
export const DECISION_PATH = `${BROKER_OUT_DIR}/access-restriction.json`;
export const DENIED_EXIT_CODE = 47;

export const RULES = Object.freeze({
  CREDENTIAL_IN_TEMPLATE: 'ACCESS_RESTRICTION_CREDENTIAL_IN_TEMPLATE',
  WEAKENED: 'ACCESS_RESTRICTION_WEAKENED',
  INPUT_INVALID: 'ACCESS_RESTRICTION_INPUT_INVALID',
});

/**
 * The product-declared restriction check: `null`, or `{ name, isRestricted(entryPoint) }` where
 * `isRestricted` returns exactly `true` only for an entry point it proves restricted. open-reception
 * declares none (D-5): its target is not access-restricted.
 */
export const PRODUCT_RESTRICTION_CHECK = null;

/**
 * Resource types that cannot themselves serve a viewer request (S6c). Everything else is a possible
 * entry point that a declared check must prove restricted: an allowlist of the known-internal fails
 * closed on a type nobody classified, which a list of internet-facing types would let through.
 * `AWS::S3::Bucket` and `AWS::ElasticLoadBalancingV2::LoadBalancer` are decided per resource
 * (`isEntryPoint`).
 */
export const NON_VIEWER_FACING_TYPES = Object.freeze(new Set([
  'AWS::CDK::Metadata',
  'AWS::CloudFront::CachePolicy',
  'AWS::CloudFront::Function',
  'AWS::CloudFront::KeyValueStore',
  'AWS::CloudFront::OriginAccessControl',
  'AWS::CloudFront::OriginRequestPolicy',
  'AWS::CloudFront::ResponseHeadersPolicy',
  'AWS::CloudWatch::Alarm',
  'AWS::CloudWatch::Dashboard',
  'AWS::Cognito::UserPool',
  'AWS::Cognito::UserPoolClient',
  'AWS::DynamoDB::Table',
  'AWS::IAM::Policy',
  'AWS::IAM::Role',
  'AWS::Lambda::Function',
  'AWS::Lambda::LayerVersion',
  'AWS::Lambda::Permission',
  'AWS::Logs::LogGroup',
  'AWS::Logs::MetricFilter',
  'AWS::S3::BucketPolicy', // unless it may Allow anyone (isEntryPoint)
  'AWS::SNS::Subscription',
  'AWS::SNS::Topic',
  'AWS::SNS::TopicPolicy',
  'Custom::CDKBucketDeployment', // unless it may set a public object ACL (isEntryPoint)
  'Custom::CrossRegionExportReader',
  'Custom::CrossRegionExportWriter',
  'Custom::S3AutoDeleteObjects',
]));

/**
 * Can this resource serve a viewer request (so a declared check must prove it restricted)? An S3
 * bucket and its policy are decided here, not by relying on the trusted policy's S3 property
 * allowlist and `RESOURCE_POLICY_PRINCIPAL_NOT_REVIEWED`: a bucket with `WebsiteConfiguration` or
 * `AccessControl` (a canned ACL may be public-read), or whose `Properties` are not a literal object,
 * a bucket policy that may Allow anyone (a `*` principal, no literal `Principal` — e.g.
 * `NotPrincipal` — or a statement that is not literal), and a CDK bucket deployment that may give
 * the objects it copies a public ACL are entry points.
 */
function isEntryPoint(type, rawProps) {
  const props = isRecord(rawProps) ? rawProps : {};
  if (type === 'AWS::S3::Bucket') {
    if (rawProps !== undefined && !isRecord(rawProps)) return true;
    return Object.keys(props).some((k) => k.startsWith('Fn::')) || props.WebsiteConfiguration !== undefined || props.AccessControl !== undefined;
  }
  if (type === 'AWS::S3::BucketPolicy') return mayAllowAnyone(props.PolicyDocument);
  if (type === 'Custom::CDKBucketDeployment') return maySetPublicAcl(rawProps);
  if (type === 'AWS::ElasticLoadBalancingV2::LoadBalancer') return props.Scheme !== 'internal';
  return !NON_VIEWER_FACING_TYPES.has(type);
}

/**
 * Could this policy document Allow a public principal? Anything not literal counts as yes. Only the
 * `Arn` or `S3CanonicalUserId` of a resource in the template names one principal; any other
 * `Fn::GetAtt` is not known to.
 */
function mayAllowAnyone(document) {
  if (document === undefined) return false; // grants nothing
  if (!isRecord(document) || !Array.isArray(document.Statement)) return true;
  return document.Statement.some((statement) => {
    if (!isRecord(statement)) return true;
    if (statement.Effect === 'Deny') return false;
    const principal = statement.Principal;
    if (typeof principal === 'string') return principal.includes('*');
    if (!isRecord(principal)) return true;
    return Object.values(principal).some((value) =>
      (Array.isArray(value) ? value : [value]).some((v) => (typeof v === 'string' ? v.includes('*') : !namesOnePrincipal(v))),
    );
  });
}

function namesOnePrincipal(value) {
  const att = isRecord(value) && Object.keys(value).length === 1 ? value['Fn::GetAtt'] : undefined;
  return Array.isArray(att) && att.length === 2 && ['Arn', 'S3CanonicalUserId'].includes(att[1]);
}

/**
 * CDK's `BucketDeployment` handler lower-cases every `SystemMetadata` key and passes it to
 * `aws s3 sync` as `--<key> <value>` (aws-cdk-lib bucket-deployment handler `create_metadata_args`),
 * so any key is a CLI option: `grants` (`read=uri=.../AllUsers`) makes the objects public as surely
 * as `acl`. An allowlist, then: the keys CDK's `mapSystemMetadata` emits that cannot grant access,
 * each with a literal string value, and `acl` only with a canned ACL that grants nobody outside the
 * bucket owner. Anything else — `grants`, an unknown or abbreviated key, a key with `=`, an
 * `Fn::` key, a value that is not a literal string, metadata or `Properties` that are not
 * literal — may make the objects public.
 */
const SAFE_SYSTEM_METADATA_KEYS = new Set([
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-type',
  'expires',
  'sse',
  'sse-kms-key-id',
  'storage-class',
  'website-redirect',
]);
const PRIVATE_OBJECT_ACLS = new Set(['private', 'bucket-owner-read', 'bucket-owner-full-control']);
function maySetPublicAcl(rawProps) {
  if (rawProps === undefined) return false;
  if (!isRecord(rawProps) || Object.keys(rawProps).some((k) => k.startsWith('Fn::'))) return true;
  const metadata = rawProps.SystemMetadata;
  if (metadata === undefined) return false;
  if (!isRecord(metadata)) return true;
  return Object.entries(metadata).some(([k, v]) => {
    if (typeof v !== 'string') return true;
    const key = k.toLowerCase();
    return key === 'acl' ? !PRIVATE_OBJECT_ACLS.has(v) : !SAFE_SYSTEM_METADATA_KEYS.has(key);
  });
}

// --- copied from trusted-policy.mjs (isRecord, parseStrictJson, safeTemplatePath, joinedLiterals,
// literalProjection, literalList) ---------------------------------------------------------------
// Provenance: infra/broker/trusted-policy.mjs at origin/main 9702fb6. Copied, not imported: the
// broker downloads and verifies each module on its own, so one module cannot import another.
// Keep in step with the original (byte identity is tested).

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function safeTemplatePath(assemblyDir, templateFile) {
  if (typeof templateFile !== 'string' || templateFile.length === 0) return null;
  const resolved = path.resolve(assemblyDir, templateFile);
  const root = path.resolve(assemblyDir) + path.sep;
  if (!resolved.startsWith(root)) return null;
  // Lexically inside is not enough: a symlinked directory on the way (`ext/x` with `ext` -> /elsewhere)
  // would read, and let the CLI publish, bytes from outside the assembly. An existing path must also
  // be inside the assembly after resolving every link; a missing one is left to the caller (it fails).
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(fs.realpathSync(assemblyDir) + path.sep)) return null;
  } catch {
    // does not exist (yet): reading it fails closed later
  }
  return resolved;
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

// --- end of copy ----------------------------------------------------------------------------

/** Shortest base64 token considered (6 decoded bytes, e.g. `a:bcde`); keeps random hits rare. */
export const MIN_TOKEN_LENGTH = 8;
/**
 * Standard or URL-safe base64, not part of a longer run of base64 characters; its padding may be
 * followed by `/` (`/auth/<padded token>/x`).
 */
const BASE64_TOKEN = new RegExp(`(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{${MIN_TOKEN_LENGTH},}={0,2}(?![A-Za-z0-9+=_-])`, 'g');
/** A `user:password` literal in a credential position: after `Basic `, or passed to an encoder. */
const PLAIN_IN_CONTEXT = [/\bBasic\s+([^\s'"`]+)/gi, /\b(?:btoa|Buffer\.from)\(\s*(['"`])([^'"`]*)\1/g];

/**
 * RFC 7617 `user-id ":" password` as it would be sent: printable ASCII, a non-empty user without
 * whitespace or colon, then a colon and a password of printable ASCII (spaces included). A
 * `{{resolve:...}}` dynamic reference never qualifies (`{` is not a base64 character, and the
 * reference text is not a user).
 */
export function isCredentialText(text) {
  return typeof text === 'string' && /^[\x20-\x7e]+$/.test(text) && /^[^:\s{}]+:[\x20-\x7e]*$/.test(text);
}

/** For each byte index, the first index at or after it whose byte matches (`bytes.length` if none). */
function nextMatching(bytes, matches) {
  const next = new Int32Array(bytes.length + 1).fill(bytes.length);
  for (let i = bytes.length - 1; i >= 0; i -= 1) next[i] = matches(bytes[i]) ? i : next[i + 1];
  return next;
}

/** The first element of an ascending list that is at least `min`, or undefined. */
function firstAtLeast(list, min) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < min) lo = mid + 1;
    else hi = mid;
  }
  return list[lo];
}

/**
 * Does the run itself, or a part of it between `/` boundaries, decode to a credential? `/` is a
 * base64 character, so a token after a path separator (`/dXNlcjpwYXNz`) would otherwise only be read
 * misaligned inside the run. Every part from the run's start or a `/` to a later `/` or the run's end
 * is tried, in time linear in the run (a run of 60 KB with a thousand `/` is otherwise seconds, and a
 * list of every part does not fit in memory): parts whose starts are equal modulo 4 share their
 * 4-character groups, so the run is decoded once per alignment; and from each start, only the
 * shortest part (of a decodable length) that reaches past the first colon needs checking, since a
 * longer one only adds bytes that must also be printable.
 */
function runCarriesCredential(run) {
  const text = run.replace(/=+$/, '');
  const body = text.replace(/-/g, '+').replace(/_/g, '/');
  const starts = [0];
  const endsByResidue = [[], [], [], []];
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === '/') endsByResidue[i % 4].push(i);
    if (text[i] === '/') starts.push(i + 1);
  }
  const lanes = [];
  const laneOf = (a) => {
    if (lanes[a]) return lanes[a];
    const bytes = Buffer.from(body.slice(a), 'base64');
    return (lanes[a] = {
      nonPrintable: nextMatching(bytes, (b) => b < 0x20 || b > 0x7e),
      colon: nextMatching(bytes, (b) => b === 0x3a),
      notInUser: nextMatching(bytes, (b) => b === 0x20 || b === 0x7b || b === 0x7d), // RFC 7617 user: no space; `{}`: not a dynamic reference
      length: bytes.length,
    });
  };
  return starts.some((start) => {
    const lane = laneOf(start % 4);
    const from = ((start - (start % 4)) / 4) * 3;
    const colon = lane.colon[from];
    if (!(colon < lane.length) || colon === from || lane.notInUser[from] < colon) return false;
    // Characters needed to decode through the colon; a length of 1 modulo 4 decodes nothing more.
    const min = start + Math.max(MIN_TOKEN_LENGTH, Math.ceil(((colon - from + 1) * 4) / 3));
    const ends = [0, 1, 2, 3].filter((r) => (r - (start % 4) + 4) % 4 !== 1).map((r) => firstAtLeast(endsByResidue[r], min)).filter((e) => e !== undefined);
    if (ends.length === 0) return false;
    const end = Math.min(...ends);
    return lane.nonPrintable[from] >= from + Math.floor(((end - start) * 3) / 4);
  });
}

const percentDecoded = (text) => text.replace(/%([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));

/** Does this literal carry an HTTP Basic credential (encoded, or plain in a credential position)? */
export function looksLikeCredential(text) {
  if (typeof text !== 'string') return false;
  for (const variant of new Set([text, percentDecoded(text)])) {
    for (const m of variant.matchAll(BASE64_TOKEN)) if (runCarriesCredential(m[0])) return true;
    for (const re of PLAIN_IN_CONTEXT) {
      for (const m of variant.matchAll(re)) if (isCredentialText(m[m.length - 1])) return true;
    }
  }
  return false;
}

/** Every string of the template (keys and values) and every literal projection of an intrinsic. */
function templateStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) templateStrings(v, out);
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      templateStrings(v, out);
    }
  }
  return out;
}

/** `Fn::Base64` arguments (projected), which deploy as base64 of the argument text. */
function base64Arguments(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((v) => base64Arguments(v, out));
  } else if (isRecord(value)) {
    if (Object.hasOwn(value, 'Fn::Base64')) out.push(literalProjection(value['Fn::Base64']));
    Object.values(value).forEach((v) => base64Arguments(v, out));
  }
  return out;
}

/**
 * At most this many combinations of choices (below) are projected per outermost `Fn::Join` /
 * `Fn::Sub` / `Fn::Select` / `Fn::Base64` node, e.g. six `Fn::If` (2^6). Nodes never combine with
 * one another, so unrelated `Fn::If` across a template do not add up.
 */
export const MAX_PROJECTED_COMBINATIONS = 64;

const PROJECTED_INTRINSICS = ['Fn::Join', 'Fn::Sub', 'Fn::Select', 'Fn::Base64'];
const isIf = (value) => isRecord(value) && Object.keys(value).length === 1 && Array.isArray(value['Fn::If']) && value['Fn::If'].length === 3;

/**
 * The values a node may evaluate to that the projections read as a NUL: the two branches of an
 * `Fn::If`, or every element of the literal list of an `Fn::Select` whose index is not a literal
 * (`Ref`, `Fn::If`, ...). Otherwise null.
 */
function choicesOf(value) {
  if (isIf(value)) return value['Fn::If'].slice(1);
  const sel = isRecord(value) ? value['Fn::Select'] : undefined;
  if (!Array.isArray(sel) || sel.length !== 2 || !literalProjection(sel[0]).includes('\u0000')) return null;
  const list = literalList(sel[1], 1);
  return list && list.length > 0 ? list : null;
}

/** The outermost projected intrinsics (each projected with every node inside it). */
function projectedRoots(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((v) => projectedRoots(v, out));
  } else if (isRecord(value)) {
    if (PROJECTED_INTRINSICS.some((k) => Object.hasOwn(value, k))) out.push(value);
    else Object.values(value).forEach((v) => projectedRoots(v, out));
  }
  return out;
}

/** `value` with the one node `target` (by identity) replaced by `replacement`. */
function withChoice(value, target, replacement) {
  if (value === target) return replacement;
  if (Array.isArray(value)) return value.map((v) => withChoice(v, target, replacement));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withChoice(v, target, replacement)]));
}

const carriesLiteralCredential = (value) =>
  [...templateStrings(value), ...joinedLiterals(value), ...base64Arguments(value)].some(looksLikeCredential) || base64Arguments(value).some(isCredentialText);

/**
 * Scan `value` under every combination of its choices, one choice node at a time: an innermost one
 * (no choice node inside it) is replaced by each of its values in turn and the result is collected
 * again, so a choice that only exists after a substitution (an `Fn::Select` with a non-literal index
 * whose list is an `Fn::If`; an `Fn::Select` over an `Fn::Split` whose text holds an `Fn::If`) is
 * expanded too. Each replacement is a strict part of the node it replaces, so this ends. `budget.left`
 * counts the fully substituted values still allowed; returns 'credential', 'clean' or 'tooComplex'
 * (more than the budget, after scanning as many as it allowed).
 */
function scanChoices(value, budget) {
  const node = innermostChoice(value);
  if (node === null) {
    if (budget.left === 0) return 'tooComplex';
    budget.left -= 1;
    return carriesLiteralCredential(value) ? 'credential' : 'clean';
  }
  for (const option of choicesOf(node)) {
    const r = scanChoices(withChoice(value, node, option), budget);
    if (r !== 'clean') return r;
  }
  return 'clean';
}

/** A node of `value` that offers choices and has no such node inside it, or null (post-order, linear). */
function innermostChoice(value) {
  const children = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  for (const child of children) {
    const found = innermostChoice(child);
    if (found !== null) return found;
  }
  return isRecord(value) && choicesOf(value) ? value : null;
}

/**
 * The longest string the copied projection helpers could build anywhere in `template`, under any
 * choice, without building it: an `Fn::Sub` that names a variable twice per level doubles per level
 * (`literalProjection` recomputes each occurrence), so 32 levels of a short template would exhaust
 * the heap, or the CPU when the strings stay empty, before any decision. Computed once per node
 * (linear), as an upper bound (no depth cut-off, the longer `Fn::If` branch, every `Fn::Select`
 * element counted), and refused above MAX_PROJECTED_LENGTH by a throw, which `evaluateAccessRestriction`
 * turns into a named deny. Lives here so the copied helpers stay byte-identical.
 */
export const MAX_PROJECTED_LENGTH = 8 * 1024 * 1024;
function assertProjectionBounded(template) {
  const memo = new WeakMap();
  const bound = (value) => {
    if (typeof value === 'string') return value.length;
    if (typeof value === 'number') return String(value).length;
    if (Array.isArray(value)) return value.reduce((n, v) => n + bound(v), 1);
    if (!isRecord(value)) return 1;
    if (memo.has(value)) return memo.get(value);
    let n = 1;
    const j = value['Fn::Join'];
    if (Array.isArray(j) && j.length === 2) n += bound(j[1]) * (1 + (typeof j[0] === 'string' ? j[0].length : 0));
    const sub = value['Fn::Sub'];
    if (typeof sub === 'string' || (Array.isArray(sub) && typeof sub[0] === 'string')) {
      const [text, vars] = typeof sub === 'string' ? [sub, {}] : [sub[0], isRecord(sub[1]) ? sub[1] : {}];
      n += text.length;
      for (const [, name] of text.matchAll(/\$\{([^}]*)\}/g)) if (Object.hasOwn(vars, name)) n += bound(vars[name]);
    }
    const sel = value['Fn::Select'];
    if (Array.isArray(sel) && sel.length === 2) n += bound(sel[0]) + bound(sel[1]);
    const split = value['Fn::Split'];
    if (Array.isArray(split) && split.length === 2) n += bound(split[1]);
    if (isIf(value)) n += Math.max(...value['Fn::If'].slice(1).map(bound));
    memo.set(value, n);
    if (n > MAX_PROJECTED_LENGTH) throw new Error(`an Fn::Join / Fn::Sub / Fn::Select projection may exceed ${MAX_PROJECTED_LENGTH} characters (template too large to project)`);
    for (const v of Object.values(value)) bound(v); // every node is projected on its own too
    return n;
  };
  bound(template);
}

/**
 * Scan one template for a credential (S6c). The projections read a choice as a NUL, so each outermost
 * projected intrinsic is also scanned under every combination of the choices inside it (a credential
 * split across the branches of two `Fn::If` is seen). Returns `{ credential, tooComplex }`, where
 * `tooComplex` names the outermost intrinsics with more than MAX_PROJECTED_COMBINATIONS combinations,
 * which were not fully projected. Throws when a projection could exceed MAX_PROJECTED_LENGTH.
 */
export function scanTemplate(template) {
  assertProjectionBounded(template);
  const tooComplex = [];
  if (carriesLiteralCredential(template)) return { credential: true, tooComplex };
  for (const root of projectedRoots(template)) {
    if (innermostChoice(root) === null) continue;
    const r = scanChoices(root, { left: MAX_PROJECTED_COMBINATIONS });
    if (r === 'credential') return { credential: true, tooComplex };
    if (r === 'tooComplex') tooComplex.push(root);
  }
  return { credential: false, tooComplex };
}

/** Viewer-facing entry points of one template; a distribution's behaviours are each one. */
function entryPoints(stackName, template) {
  const out = [];
  const resources = isRecord(template?.Resources) ? template.Resources : {};
  for (const [logicalId, resource] of Object.entries(resources)) {
    const type = isRecord(resource) && typeof resource.Type === 'string' ? resource.Type : '(no type)';
    if (!isEntryPoint(type, isRecord(resource) ? resource.Properties : undefined)) continue;
    const base = { stackName, logicalId, type, resource, template };
    if (type !== 'AWS::CloudFront::Distribution') {
      out.push({ ...base, entry: logicalId });
      continue;
    }
    const config = isRecord(resource.Properties) ? resource.Properties.DistributionConfig : undefined;
    if (!isRecord(config) || !isRecord(config.DefaultCacheBehavior)) {
      // A distribution whose behaviours cannot be read is still an entry point nobody proved.
      out.push({ ...base, entry: `${logicalId}/unreadable`, behavior: null });
      continue;
    }
    out.push({ ...base, entry: `${logicalId}/DefaultCacheBehavior`, behavior: config.DefaultCacheBehavior });
    const extra = config.CacheBehaviors;
    if (extra !== undefined && !Array.isArray(extra)) {
      out.push({ ...base, entry: `${logicalId}/CacheBehaviors`, behavior: null });
    }
    for (const [i, behavior] of (Array.isArray(extra) ? extra : []).entries()) {
      out.push({ ...base, entry: `${logicalId}/CacheBehaviors/${i}`, behavior: isRecord(behavior) ? behavior : null });
    }
  }
  return out;
}

/** Read every stack template of the assembly (strict JSON, inside the assembly). Throws on any failure. */
function readTemplates(assemblyDir) {
  const manifestFile = safeTemplatePath(assemblyDir, 'manifest.json');
  if (!manifestFile) throw new Error('manifest.json escapes the assembly');
  const manifest = parseStrictJson(fs.readFileSync(manifestFile, 'utf8'));
  if (!isRecord(manifest) || !isRecord(manifest.artifacts)) throw new Error('manifest.artifacts must be an object');
  const templates = [];
  for (const [artifactId, artifact] of Object.entries(manifest.artifacts)) {
    // A nested assembly's templates would not be scanned here (the trusted policy also denies it).
    if (isRecord(artifact) && artifact.type === 'cdk:cloud-assembly') throw new Error(`nested cloud assembly ${artifactId} is not evaluated`);
    if (!isRecord(artifact) || artifact.type !== 'aws:cloudformation:stack') continue;
    const props = isRecord(artifact.properties) ? artifact.properties : {};
    const file = safeTemplatePath(assemblyDir, props.templateFile);
    if (!file) throw new Error(`template of ${artifactId} is missing or escapes the assembly`);
    const template = parseStrictJson(fs.readFileSync(file, 'utf8'));
    if (!isRecord(template)) throw new Error(`template of ${artifactId} is not an object`);
    for (const [logicalId, r] of Object.entries(isRecord(template.Resources) ? template.Resources : {})) {
      if (isRecord(r) && r.Type === 'AWS::CloudFormation::Stack') throw new Error(`nested stack ${artifactId}/${logicalId} is not evaluated`);
    }
    templates.push({ stackName: typeof props.stackName === 'string' ? props.stackName : artifactId, template });
  }
  if (templates.length === 0) throw new Error('assembly has no stack template');
  return templates;
}

const decision = (result, rule, reason, accessRestriction, extra = {}) => ({
  version: ACCESS_RESTRICTION_VERSION,
  result,
  rule,
  reason,
  accessRestriction,
  ...extra,
});

/**
 * Pure decision over the assembly. `check` is the product-declared restriction check (or null).
 * Returns `{ result: 'allowed' | 'denied', rule, reason, accessRestriction: { state, reason? }, ... }`.
 */
export function evaluateAccessRestriction({ assemblyDir, check }) {
  try {
    return evaluate(assemblyDir, check);
  } catch (error) {
    // Unreadable, nested, too large to project, or any internal exception: a named deny. (A process
    // that dies before this, e.g. out of heap, writes no decision, and the buildspec fails closed on that.)
    return decision('denied', RULES.INPUT_INVALID, `assembly could not be read or evaluated: ${error instanceof Error ? error.message : String(error)}`, {
      state: 'unverifiable',
      reason: 'assembly not evaluated',
    });
  }
}

function evaluate(assemblyDir, check) {
  const templates = readTemplates(assemblyDir);

  // S6c: the credential never appears in the template, whatever the check (runs unconditionally).
  const findings = [];
  const tooComplex = [];
  for (const { stackName, template } of templates) {
    const scan = scanTemplate(template);
    if (scan.credential) findings.push({ stackName, logicalId: null, why: 'a template string or intrinsic looks like an HTTP Basic credential' });
    if (scan.tooComplex.length > 0) {
      tooComplex.push({ stackName, logicalId: null, why: `${scan.tooComplex.length} Fn::Join / Fn::Sub / Fn::Select / Fn::Base64 node(s) with more than ${MAX_PROJECTED_COMBINATIONS} combinations of Fn::If branches / Fn::Select elements were not projected` });
    }
    const resources = isRecord(template.Resources) ? template.Resources : {};
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (isRecord(resource) && resource.Type === 'AWS::CloudFront::KeyValueStore' && isRecord(resource.Properties) && resource.Properties.ImportSource !== undefined) {
        findings.push({ stackName, logicalId, why: 'a CloudFront KeyValueStore is seeded from the template (ImportSource)' });
      }
    }
  }
  const checkName = check === null || check === undefined ? null : typeof check?.name === 'string' ? check.name : 'unnamed';
  if (findings.length > 0) {
    return decision(
      'denied',
      RULES.CREDENTIAL_IN_TEMPLATE,
      `the access restriction's credential must not appear in the synthesized template: ${findings.map((f) => `${f.stackName}${f.logicalId ? `/${f.logicalId}` : ''}: ${f.why}`).join('; ')}`,
      { state: 'unverifiable', reason: 'credential in template' },
      { check: checkName, findings },
    );
  }
  // Checked after the credential, so a leak is reported as one even in a template too complex to project.
  if (tooComplex.length > 0) {
    return decision(
      'denied',
      RULES.INPUT_INVALID,
      `the credential scan could not project the template (fail closed): ${tooComplex.map((f) => `${f.stackName}: ${f.why}`).join('; ')}`,
      { state: 'unverifiable', reason: 'template too complex to scan' },
      { check: checkName, findings: tooComplex },
    );
  }

  if (check === null || check === undefined) {
    return decision('allowed', null, null, { state: 'absent' }, { check: null, findings: [] });
  }

  const entries = templates.flatMap(({ stackName, template }) => entryPoints(stackName, template));
  const results = entries.map((e) => {
    let restricted = false;
    try {
      restricted = typeof check.isRestricted === 'function' && check.isRestricted(e) === true;
    } catch {
      restricted = false; // a check that throws proved nothing
    }
    return { stackName: e.stackName, logicalId: e.logicalId, type: e.type, entry: e.entry, restricted };
  });
  const unproven = results.filter((r) => !r.restricted);
  if (results.length > 0 && unproven.length === 0) {
    return decision('allowed', null, null, { state: 'verified' }, { check: checkName, entryPoints: results, findings: [] });
  }
  const why = results.length === 0 ? 'no possible entry point was found to prove restricted' : `entry points not proven restricted: ${unproven.map((r) => `${r.stackName}/${r.entry}`).join(', ')}`;
  return decision(
    'denied',
    RULES.WEAKENED,
    `the declared access restriction (${checkName}) cannot be established: ${why}; removing, bypassing or weakening it is an envelope change (S5) and needs a human`,
    { state: 'unverifiable', reason: why },
    { check: checkName, entryPoints: results, findings: [] },
  );
}

// --- CLI ------------------------------------------------------------------------------------

/**
 * Decide and write the decision to DECISION_PATH (exclusive create in the broker-owned output
 * dir). Exit 0 only when the decision allows.
 */
export function runCli(argv, { now = new Date(), env = process.env, check = PRODUCT_RESTRICTION_CHECK, decisionPath = DECISION_PATH } = {}) {
  const i = argv.indexOf('--assembly');
  const assemblyDir = i >= 0 ? argv[i + 1] : undefined;
  const d =
    typeof assemblyDir === 'string' && path.isAbsolute(assemblyDir)
      ? evaluateAccessRestriction({ assemblyDir, check })
      : decision('denied', RULES.INPUT_INVALID, '--assembly must be an absolute path', { state: 'unverifiable', reason: 'no assembly' });
  const record = {
    ...d,
    executionId: env.OR_PIPELINE_EXECUTION_ID ?? null,
    revision: env.OR_TRUSTED_SOURCE_REVISION ?? null,
    decidedAt: now.toISOString(),
  };
  let exitCode = d.result === 'allowed' ? 0 : DENIED_EXIT_CODE;
  try {
    fs.writeFileSync(decisionPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    exitCode = DENIED_EXIT_CODE; // the decision could not be recorded where the next check reads it
  }
  return { exitCode, record };
}

function main() {
  const { exitCode, record } = runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify({ event: exitCode === 0 ? 'access_restriction.allowed' : 'access_restriction.denied', ...record })}\n`);
  process.exitCode = exitCode;
}

/** Run as a program even when invoked through a symlinked path. */
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
