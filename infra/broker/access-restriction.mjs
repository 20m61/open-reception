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
 * - `verified`: a check is declared and proves EVERY viewer-facing entry point restricted
 *   (CloudFront distributions and each of their behaviours, `AWS::Lambda::Url`, every
 *   `AWS::ApiGateway*` / `AWS::ApiGatewayV2*` resource). No entry point at all is not a proof;
 * - `unverifiable`: a check is declared but cannot prove one of them. A declared check that is
 *   not `verified` is `ACCESS_RESTRICTION_WEAKENED`: the change removes, bypasses or weakens the
 *   restriction (S5 envelope change), a human gate, not an autonomous deploy.
 *
 * Independently of any check, the restriction's credential must never be in the template (S6c):
 * a string that looks like an HTTP Basic credential (`Basic <base64 of user:password>`), or a
 * CloudFront KeyValueStore seeded from the template (`ImportSource`), denies
 * `ACCESS_RESTRICTION_CREDENTIAL_IN_TEMPLATE`. A `{{resolve:...}}` dynamic reference is a pointer,
 * not a value. An assembly that cannot be read denies `ACCESS_RESTRICTION_INPUT_INVALID`.
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

/** Viewer-facing entry point resource types (S6c: CDN distribution, function URL, API endpoint). */
const isEntryPointType = (type) =>
  type === 'AWS::CloudFront::Distribution' || type === 'AWS::Lambda::Url' || /^AWS::ApiGateway(?:V2)?::/.test(type);

// --- copied from trusted-policy.mjs (parseStrictJson, safeTemplatePath) ------------------------
// Provenance: infra/broker/trusted-policy.mjs at origin/main 9702fb6. Copied, not imported: the
// broker downloads and verifies each module on its own, so one module cannot import another.
// Keep in step with the original.

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

// --- end of copy ----------------------------------------------------------------------------

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * RFC 7617: the scheme is case-insensitive; the token is base64 of `user-id ":" password`. A
 * `{{resolve:...}}` dynamic reference (resolved by CloudFormation at deploy time) is a pointer, not
 * a value, and cannot match: `{` is not a base64 character.
 */
const BASIC_CREDENTIAL = /\bBasic\s+([A-Za-z0-9+/]+={0,2})/gi;

/** Does this literal carry something that decodes as an HTTP Basic `user:password` pair? */
export function looksLikeBasicCredential(text) {
  if (typeof text !== 'string') return false;
  for (const m of text.matchAll(BASIC_CREDENTIAL)) {
    const token = m[1];
    const body = token.replace(/=+$/, '');
    if (body.length < 2 || body.length % 4 === 1) continue;
    const decoded = Buffer.from(body, 'base64').toString('latin1');
    if (decoded.includes(':')) return true;
  }
  return false;
}

/**
 * Every literal a template can resolve to without deploy-time input: each string, plus each
 * `Fn::Join` of literals (a credential split across join parts is still in the template). Non-
 * literal join parts become a separator that cannot complete a token.
 */
function templateLiterals(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) templateLiterals(v, out);
  } else if (isRecord(value)) {
    const join = value['Fn::Join'];
    if (Array.isArray(join) && join.length === 2 && typeof join[0] === 'string' && Array.isArray(join[1])) {
      out.push(join[1].map((p) => (typeof p === 'string' ? p : '\u0000')).join(join[0]));
    }
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      templateLiterals(v, out);
    }
  }
  return out;
}

/** Viewer-facing entry points of one template; a distribution's behaviours are each one. */
function entryPoints(stackName, template) {
  const out = [];
  const resources = isRecord(template?.Resources) ? template.Resources : {};
  for (const [logicalId, resource] of Object.entries(resources)) {
    const type = isRecord(resource) && typeof resource.Type === 'string' ? resource.Type : null;
    if (!type || !isEntryPointType(type)) continue;
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
    if (!isRecord(artifact) || artifact.type !== 'aws:cloudformation:stack') continue;
    const props = isRecord(artifact.properties) ? artifact.properties : {};
    const file = safeTemplatePath(assemblyDir, props.templateFile);
    if (!file) throw new Error(`template of ${artifactId} is missing or escapes the assembly`);
    const template = parseStrictJson(fs.readFileSync(file, 'utf8'));
    if (!isRecord(template)) throw new Error(`template of ${artifactId} is not an object`);
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
  let templates;
  try {
    templates = readTemplates(assemblyDir);
  } catch (error) {
    return decision('denied', RULES.INPUT_INVALID, `assembly could not be read: ${error instanceof Error ? error.message : String(error)}`, {
      state: 'unverifiable',
      reason: 'assembly unreadable',
    });
  }

  // S6c: the credential never appears in the template, whatever the check (runs unconditionally).
  const findings = [];
  for (const { stackName, template } of templates) {
    if (templateLiterals(template).some(looksLikeBasicCredential)) {
      findings.push({ stackName, logicalId: null, why: 'a template string looks like an HTTP Basic credential' });
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
  const why = results.length === 0 ? 'no viewer-facing entry point was found to prove restricted' : `entry points not proven restricted: ${unproven.map((r) => `${r.stackName}/${r.entry}`).join(', ')}`;
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
