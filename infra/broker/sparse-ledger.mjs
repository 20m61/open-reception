/**
 * Sparse dev-deploy attempt ledger (#1153, Foundation safe-dev-deploy S5a / S6 / S6a / S6b).
 *
 * Owner decision recorded on #1153 (2026-09-27):
 * - record every attempt that reaches the mutation boundary AND its outcome (success / failure);
 * - the daily limit counts **attempts**, not successes (target 1, soft ceiling 2);
 * - the accounting window is the calendar day in one declared IANA timezone (Asia/Tokyo);
 * - a further attempt needs an S5a override bound to one revision AND one rule, single-use,
 *   expiring and auditable;
 * - an unavailable, unreadable or inconsistent ledger denies (S6a).
 *
 * This file is dependency-free. DynamoDB access goes through an injected client whose methods
 * take the low-level DynamoDB JSON request (`transactGetItems`, `putItem`, `transactWriteItems`), so the
 * same code runs against the AWS SDK, the AWS CLI or an emulator. Every write is conditional:
 * the broker runs with concurrency 1, and the conditions are the second line of defence.
 *
 * Keys (single table, PK = `PROJECT#open-reception`):
 * - `DAY#<YYYY-MM-DD>`            attemptCount / successCount / failureCount for one Tokyo day
 * - `ATTEMPT#<attemptId>`         one audit record per attempt (reserved, outcome, denial)
 * - `OVERRIDE#<rule>#<revision>#<day>`  one human-issued, single-use override (create-only)
 * - `META#genesis`                written once by a human when the ledger is initialised
 *
 * The genesis item is what distinguishes "a fresh day" from "an empty or replaced table": a
 * missing day counter only means zero when the genesis item exists and carries the ledger id
 * the broker was configured with. It also carries a cumulative `totalAttempts`, the monotonic
 * `lastDay` of the latest reservation and that day's attempt count (`lastDayAttempts`), all
 * compare-and-set in every reservation, so a deleted, overwritten or decremented counter for
 * today, a day count above the total, or a clock that went backwards is detected. Otherwise the ledger's integrity cannot be established (S6a).
 */

export const PROJECT_KEY = 'PROJECT#open-reception';
export const LEDGER_TIMEZONE = 'Asia/Tokyo';
export const TARGET_ATTEMPTS_PER_DAY = 1;
export const SOFT_ATTEMPT_CEILING = 2;

/** The only rule an override can lift. Guards such as IAM or revision binding are not overridable. */
export const DAILY_CEILING_RULE = 'SPARSE_DAILY_ATTEMPT_CEILING';
export const OVERRIDABLE_RULES = Object.freeze([DAILY_CEILING_RULE]);

export const RULES = Object.freeze({
  REVISION_INVALID: 'TRUSTED_REVISION_INVALID',
  ATTEMPT_ID_INVALID: 'ATTEMPT_ID_INVALID',
  LEDGER_UNAVAILABLE: 'SPARSE_LEDGER_UNAVAILABLE',
  LEDGER_CORRUPT: 'SPARSE_LEDGER_CORRUPT',
  LEDGER_CONFLICT: 'SPARSE_LEDGER_CONFLICT',
  CLOCK_INVALID: 'BROKER_CLOCK_INVALID',
  DAILY_CEILING: DAILY_CEILING_RULE,
});

/** Longest override lifetime a human can issue. Keeps a forgotten override from lingering. */
export const MAX_OVERRIDE_TTL_SECONDS = 24 * 60 * 60;

const FULL_SHA = /^[0-9a-f]{40}$/;
/** CodeBuild build ids look like `<project>:<uuid>`; keep the key space printable and bounded. */
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,254}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Ledger instance id pinned in the broker environment (e.g. a UUID chosen at initialisation). */
const LEDGER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

export const isLedgerId = (v) => typeof v === 'string' && LEDGER_ID.test(v);
const isValidDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());

export const isFullSha = (v) => typeof v === 'string' && FULL_SHA.test(v);
export const isAttemptId = (v) => typeof v === 'string' && ATTEMPT_ID.test(v);

/** Calendar day of `now` in the declared ledger timezone (never the caller's timezone). */
export function ledgerDay(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('ledgerDay requires a valid Date');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LEDGER_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

export const dayKey = (day) => `DAY#${day}`;
export const attemptKey = (attemptId) => `ATTEMPT#${attemptId}`;
export const overrideKey = (rule, revision, day) => `OVERRIDE#${rule}#${revision}#${day}`;
export const GENESIS_KEY = 'META#genesis';

const key = (sk) => ({ PK: { S: PROJECT_KEY }, SK: { S: sk } });
const epochSeconds = (now) => Math.floor(now.getTime() / 1000);

/**
 * Every attribute name in an expression is written as `#name` and aliased here. DynamoDB has
 * hundreds of reserved words (`timezone`, `status`, `day`, ...); aliasing all of them removes
 * the guesswork. The alias map is derived from the expression text, so it cannot drift.
 */
function withNames(op) {
  const text = `${op.UpdateExpression ?? ''} ${op.ConditionExpression ?? ''}`;
  const names = {};
  for (const m of text.matchAll(/#([A-Za-z][A-Za-z0-9]*)/g)) names[`#${m[1]}`] = m[1];
  return Object.keys(names).length ? { ...op, ExpressionAttributeNames: names } : op;
}

// --- DynamoDB attribute readers (strict: a present-but-wrong-typed attribute is corruption) ---

const CORRUPT = Symbol('corrupt');

function readInt(item, name) {
  const attr = item[name];
  if (attr === undefined) return undefined;
  const keys = Object.keys(attr ?? {});
  if (keys.length !== 1 || keys[0] !== 'N' || typeof attr.N !== 'string' || !/^\d+$/.test(attr.N)) {
    return CORRUPT;
  }
  const n = Number(attr.N);
  return Number.isSafeInteger(n) ? n : CORRUPT;
}

function readStr(item, name) {
  const attr = item[name];
  if (attr === undefined) return undefined;
  const keys = Object.keys(attr ?? {});
  if (keys.length !== 1 || keys[0] !== 'S' || typeof attr.S !== 'string') return CORRUPT;
  return attr.S;
}

const isItem = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read the day counter. A missing item is a fresh day (count 0). A present item must carry the
 * declared timezone, its own day, and consistent non-negative integer counters; otherwise the
 * integrity of the count cannot be established and S6a denies.
 */
export function readDayCounter(dayItem, day) {
  if (dayItem === undefined || dayItem === null) {
    return { ok: true, exists: false, attemptCount: 0, successCount: 0, failureCount: 0 };
  }
  if (!isItem(dayItem)) return { ok: false, why: 'day item is not an object' };
  if (readStr(dayItem, 'PK') !== PROJECT_KEY || readStr(dayItem, 'SK') !== dayKey(day)) {
    return { ok: false, why: 'day item key does not match the requested day' };
  }
  if (readStr(dayItem, 'timezone') !== LEDGER_TIMEZONE) {
    return { ok: false, why: 'day item timezone is missing or differs from the declared timezone' };
  }
  if (readStr(dayItem, 'day') !== day) {
    return { ok: false, why: 'day item day attribute does not match its key' };
  }
  const attemptCount = readInt(dayItem, 'attemptCount');
  const successCount = readInt(dayItem, 'successCount');
  const failureCount = readInt(dayItem, 'failureCount');
  for (const [name, v] of [
    ['attemptCount', attemptCount],
    ['successCount', successCount],
    ['failureCount', failureCount],
  ]) {
    if (v === undefined || v === CORRUPT) {
      return { ok: false, why: `${name} is missing or not a non-negative integer` };
    }
  }
  if (successCount + failureCount > attemptCount) {
    return { ok: false, why: 'more outcomes than attempts recorded' };
  }
  return { ok: true, exists: true, attemptCount, successCount, failureCount };
}

/** The genesis item must exist and name the ledger id the broker was configured with. */
export function readGenesis(genesisItem, ledgerId) {
  if (!isLedgerId(ledgerId)) return { ok: false, why: 'broker has no valid ledger id configured' };
  if (genesisItem === undefined || genesisItem === null) {
    return { ok: false, why: 'genesis item missing (ledger not initialised, emptied or replaced)' };
  }
  if (!isItem(genesisItem)) return { ok: false, why: 'genesis item is not an object' };
  if (readStr(genesisItem, 'PK') !== PROJECT_KEY || readStr(genesisItem, 'SK') !== GENESIS_KEY) {
    return { ok: false, why: 'genesis item key mismatch' };
  }
  if (readStr(genesisItem, 'ledgerId') !== ledgerId) {
    return { ok: false, why: 'genesis ledger id differs from the configured ledger id' };
  }
  if (readStr(genesisItem, 'timezone') !== LEDGER_TIMEZONE) return { ok: false, why: 'genesis timezone differs' };
  const totalAttempts = readInt(genesisItem, 'totalAttempts');
  if (totalAttempts === undefined || totalAttempts === CORRUPT) {
    return { ok: false, why: 'genesis totalAttempts is missing or not a non-negative integer' };
  }
  const lastDay = readStr(genesisItem, 'lastDay');
  if (lastDay === CORRUPT || (lastDay !== undefined && !DAY.test(lastDay))) {
    return { ok: false, why: 'genesis lastDay is malformed' };
  }
  if ((lastDay === undefined) !== (totalAttempts === 0)) {
    return { ok: false, why: 'genesis lastDay and totalAttempts disagree' };
  }
  const lastDayAttempts = readInt(genesisItem, 'lastDayAttempts');
  if (lastDayAttempts === CORRUPT || (lastDay === undefined) !== (lastDayAttempts === undefined)) {
    return { ok: false, why: 'genesis lastDayAttempts is malformed or disagrees with lastDay' };
  }
  if (lastDayAttempts !== undefined && (lastDayAttempts < 1 || lastDayAttempts > totalAttempts)) {
    return { ok: false, why: 'genesis lastDayAttempts is out of range' };
  }
  return { ok: true, totalAttempts, lastDay, lastDayAttempts };
}

/**
 * Validate an override item against this exact attempt. Returns `{ ok: true, override }` or
 * `{ ok: false, why }`. A structurally present but unusable override is simply absent (S5a:
 * "an override that cannot be verified is absent, and an absent override denies").
 */
export function readOverride(overrideItem, { revision, rule, day, now }) {
  if (overrideItem === undefined || overrideItem === null) return { ok: false, why: 'no override' };
  if (!isItem(overrideItem)) return { ok: false, why: 'override item is not an object' };
  if (readStr(overrideItem, 'PK') !== PROJECT_KEY || readStr(overrideItem, 'SK') !== overrideKey(rule, revision, day)) {
    return { ok: false, why: 'override key does not match this revision, rule and day' };
  }
  if (readStr(overrideItem, 'revision') !== revision) return { ok: false, why: 'override is bound to another revision' };
  if (readStr(overrideItem, 'rule') !== rule) return { ok: false, why: 'override is bound to another rule' };
  if (readStr(overrideItem, 'day') !== day) return { ok: false, why: 'override is bound to another accounting day' };
  if (readStr(overrideItem, 'timezone') !== LEDGER_TIMEZONE) return { ok: false, why: 'override timezone differs' };
  if (overrideItem.consumedAt !== undefined || overrideItem.consumedBy !== undefined) {
    return { ok: false, why: 'override already consumed' };
  }
  const expiresAt = readInt(overrideItem, 'expiresAt');
  if (expiresAt === undefined || expiresAt === CORRUPT) return { ok: false, why: 'override has no valid expiry' };
  if (expiresAt <= epochSeconds(now)) return { ok: false, why: 'override expired' };
  const reason = readStr(overrideItem, 'reason');
  const approver = readStr(overrideItem, 'approver');
  const issuedAt = readStr(overrideItem, 'issuedAt');
  if (typeof reason !== 'string' || !reason.trim()) return { ok: false, why: 'override has no reason' };
  if (typeof approver !== 'string' || !approver.trim()) return { ok: false, why: 'override has no approver' };
  if (typeof issuedAt !== 'string' || !issuedAt) return { ok: false, why: 'override has no issue time' };
  return { ok: true, override: { rule, revision, day, expiresAt, reason, approver, issuedAt } };
}

const deny = (rule, reason, extra = {}) => ({ result: 'denied', rule, reason, retryable: false, ...extra });

/**
 * Pure preflight decision for one attempt, from the two items the broker read with a consistent
 * read. `readError` set means the ledger could not be read at all (S6a: deny).
 *
 * Returns either a denial or `{ result: 'allowed', mode: 'normal' | 'override', ... }` carrying
 * `observedAttemptCount`, which the reservation uses as its compare-and-set value.
 */
export function evaluatePreflight({ revision, attemptId, now, ledgerId, genesisItem, dayItem, overrideItem, readError }) {
  if (!isValidDate(now)) {
    return deny(RULES.CLOCK_INVALID, 'broker clock is not a valid time');
  }
  if (!isFullSha(revision)) {
    return deny(RULES.REVISION_INVALID, 'trusted source revision must be a full lowercase 40-hex commit id');
  }
  if (!isAttemptId(attemptId)) {
    return deny(RULES.ATTEMPT_ID_INVALID, 'attempt id missing or malformed');
  }
  const day = ledgerDay(now);
  const base = { revision, attemptId, day, timezone: LEDGER_TIMEZONE };
  if (readError) {
    return deny(RULES.LEDGER_UNAVAILABLE, 'sparse deploy ledger could not be read; an uncountable attempt is not a free one', base);
  }
  const genesis = readGenesis(genesisItem, ledgerId);
  if (!genesis.ok) {
    return deny(RULES.LEDGER_CORRUPT, `sparse deploy ledger integrity cannot be established: ${genesis.why}`, base);
  }
  const counter = readDayCounter(dayItem, day);
  if (!counter.ok) {
    return deny(RULES.LEDGER_CORRUPT, `sparse deploy ledger integrity cannot be established: ${counter.why}`, base);
  }
  if (genesis.lastDay !== undefined && genesis.lastDay > day) {
    return deny(RULES.LEDGER_CORRUPT, `sparse deploy ledger integrity cannot be established: last reservation (${genesis.lastDay}) is after today (${day}); clock regression or tampering`, base);
  }
  if (genesis.lastDay === day && counter.attemptCount !== genesis.lastDayAttempts) {
    return deny(RULES.LEDGER_CORRUPT, `sparse deploy ledger integrity cannot be established: today's counter (${counter.exists ? counter.attemptCount : 'missing'}) differs from the ${genesis.lastDayAttempts} reservations recorded on genesis`, base);
  }
  if (counter.attemptCount > genesis.totalAttempts) {
    return deny(RULES.LEDGER_CORRUPT, 'sparse deploy ledger integrity cannot be established: day counter exceeds the cumulative total', base);
  }
  const counts = {
    ledgerId,
    observedTotalAttempts: genesis.totalAttempts,
    observedLastDay: genesis.lastDay,
    observedAttemptCount: counter.attemptCount,
    successCount: counter.successCount,
    failureCount: counter.failureCount,
  };
  if (counter.attemptCount < SOFT_ATTEMPT_CEILING) {
    return { result: 'allowed', rule: null, retryable: false, mode: 'normal', ...base, ...counts };
  }
  const ov = readOverride(overrideItem, { revision, rule: DAILY_CEILING_RULE, day, now });
  if (!ov.ok) {
    return deny(
      RULES.DAILY_CEILING,
      `${counter.attemptCount} deploy attempts already reached the mutation boundary on ${day} (${LEDGER_TIMEZONE}); a human override bound to this revision and rule is required (${ov.why})`,
      { ...base, ...counts },
    );
  }
  return { result: 'allowed', rule: null, retryable: false, mode: 'override', ...base, ...counts, override: ov.override };
}

/**
 * Reservation at the mutation boundary: count the attempt BEFORE mutating, in one transaction.
 *
 * - the day counter is compare-and-set on the observed attempt count, so two racers that read the
 *   same count cannot both reserve;
 * - the attempt audit record is create-only (an attempt id is used once);
 * - an override is consumed in the same transaction (kept, marked consumed, for audit) and its
 *   binding (revision, rule, day, expiry, unconsumed) is re-checked by DynamoDB, not only by JS.
 */
export function buildReserveTransaction({ table, decision, now }) {
  if (decision?.result !== 'allowed') throw new Error('only an allowed preflight decision can be reserved');
  const { day, revision, attemptId, mode, observedAttemptCount, observedTotalAttempts, ledgerId } = decision;
  if (!isLedgerId(ledgerId) || !Number.isSafeInteger(observedTotalAttempts) || observedTotalAttempts < observedAttemptCount) {
    throw new Error('reservation requires the verified genesis state of the decision');
  }
  if (mode === 'normal' && !(observedAttemptCount < SOFT_ATTEMPT_CEILING)) {
    throw new Error('normal reservation requires an observed count below the soft ceiling');
  }
  if (mode === 'override' && !(observedAttemptCount >= SOFT_ATTEMPT_CEILING && decision.override)) {
    throw new Error('override reservation requires the ceiling to be reached and a verified override');
  }
  const nowIso = now.toISOString();
  const dayUpdate = {
    TableName: table,
    Key: key(dayKey(day)),
    UpdateExpression:
      'SET #attemptCount = if_not_exists(#attemptCount, :zero) + :one, #successCount = if_not_exists(#successCount, :zero), #failureCount = if_not_exists(#failureCount, :zero), #timezone = :tz, #day = :day, #updatedAt = :now',
    ConditionExpression:
      observedAttemptCount === 0
        ? 'attribute_not_exists(#PK)'
        : '#attemptCount = :observed AND #timezone = :tz AND #day = :day',
    ExpressionAttributeValues: {
      ':zero': { N: '0' },
      ':one': { N: '1' },
      ':tz': { S: LEDGER_TIMEZONE },
      ':day': { S: day },
      ':now': { S: nowIso },
      ...(observedAttemptCount === 0 ? {} : { ':observed': { N: String(observedAttemptCount) } }),
    },
  };
  const attemptItem = {
    ...key(attemptKey(attemptId)),
    attemptId: { S: attemptId },
    revision: { S: revision },
    day: { S: day },
    timezone: { S: LEDGER_TIMEZONE },
    status: { S: 'in_progress' },
    mode: { S: mode },
    attemptNumber: { N: String(observedAttemptCount + 1) },
    reservedAt: { S: nowIso },
  };
  const genesisUpdate = {
    TableName: table,
    Key: key(GENESIS_KEY),
    // Same day: lastDayAttempts moves in lock-step with the day counter's CAS. New day: it restarts.
    UpdateExpression: 'SET #totalAttempts = :newTotal, #lastDay = :day, #lastDayAttempts = :newDayCount',
    ConditionExpression:
      decision.observedLastDay === day
        ? '#ledgerId = :ledgerId AND #timezone = :tz AND #totalAttempts = :observedTotal AND #lastDay = :day AND #lastDayAttempts = :observedDayCount'
        : '#ledgerId = :ledgerId AND #timezone = :tz AND #totalAttempts = :observedTotal AND (attribute_not_exists(#lastDay) OR #lastDay < :day)',
    ExpressionAttributeValues: {
      ':newTotal': { N: String(observedTotalAttempts + 1) },
      ':newDayCount': { N: String(observedAttemptCount + 1) },
      ...(decision.observedLastDay === day ? { ':observedDayCount': { N: String(observedAttemptCount) } } : {}),
      ':observedTotal': { N: String(observedTotalAttempts) },
      ':day': { S: day },
      ':ledgerId': { S: ledgerId },
      ':tz': { S: LEDGER_TIMEZONE },
    },
  };
  const items = [{ Update: withNames(genesisUpdate) }, { Update: withNames(dayUpdate) }];
  if (mode === 'override') {
    const o = decision.override;
    Object.assign(attemptItem, {
      overrideRule: { S: o.rule },
      overrideApprover: { S: o.approver },
      overrideReason: { S: o.reason },
      overrideIssuedAt: { S: o.issuedAt },
      overrideExpiresAt: { N: String(o.expiresAt) },
    });
    items.push({
      Update: withNames({
        TableName: table,
        Key: key(overrideKey(o.rule, revision, day)),
        UpdateExpression: 'SET #consumedAt = :now, #consumedBy = :attempt',
        ConditionExpression:
          'attribute_exists(#PK) AND attribute_not_exists(#consumedAt) AND attribute_not_exists(#consumedBy) AND #revision = :rev AND #rule = :rule AND #day = :day AND #timezone = :tz AND #expiresAt > :epoch AND attribute_exists(#reason) AND attribute_exists(#approver)',
        ExpressionAttributeValues: {
          ':now': { S: nowIso },
          ':attempt': { S: attemptId },
          ':rev': { S: revision },
          ':rule': { S: o.rule },
          ':day': { S: day },
          ':tz': { S: LEDGER_TIMEZONE },
          ':epoch': { N: String(epochSeconds(now)) },
        },
      }),
    });
  }
  items.push({
    Put: withNames({
      TableName: table,
      Item: attemptItem,
      ConditionExpression: 'attribute_not_exists(#PK)',
    }),
  });
  return { TransactItems: items };
}

export const OUTCOMES = Object.freeze(['succeeded', 'failed']);

/**
 * Record the outcome of a reserved attempt. A failed attempt keeps its budget (S6b / S10a); the
 * outcome only moves it from in_progress to a terminal state, once.
 */
export function buildOutcomeTransaction({ table, attemptId, day, outcome, now }) {
  if (!isAttemptId(attemptId)) throw new Error('attempt id missing or malformed');
  if (typeof day !== 'string' || !DAY.test(day)) throw new Error('day must be YYYY-MM-DD');
  if (!OUTCOMES.includes(outcome)) throw new Error('outcome must be succeeded or failed');
  const counter = outcome === 'succeeded' ? 'successCount' : 'failureCount';
  const nowIso = now.toISOString();
  return {
    TransactItems: [
      {
        Update: withNames({
          TableName: table,
          Key: key(attemptKey(attemptId)),
          UpdateExpression: 'SET #status = :outcome, #finishedAt = :now',
          ConditionExpression: 'attribute_exists(#PK) AND #status = :inProgress AND #day = :day',
          ExpressionAttributeValues: {
            ':outcome': { S: outcome },
            ':now': { S: nowIso },
            ':inProgress': { S: 'in_progress' },
            ':day': { S: day },
          },
        }),
      },
      {
        Update: withNames({
          TableName: table,
          Key: key(dayKey(day)),
          UpdateExpression: `SET #${counter} = #${counter} + :one, #updatedAt = :now`,
          // DynamoDB conditions cannot do arithmetic; outcomes <= attempts holds because each
          // attempt record moves out of in_progress exactly once (the first update above).
          ConditionExpression: 'attribute_exists(#attemptCount) AND #timezone = :tz AND #day = :day',
          ExpressionAttributeValues: {
            ':one': { N: '1' },
            ':now': { S: nowIso },
            ':tz': { S: LEDGER_TIMEZONE },
            ':day': { S: day },
          },
        }),
      },
    ],
  };
}

/**
 * Audit record for an attempt denied BEFORE the mutation boundary. It consumes no budget (S6b)
 * and touches no counter.
 */
export function buildDenialPut({ table, attemptId, revision, rule, now }) {
  if (!isAttemptId(attemptId)) throw new Error('attempt id missing or malformed');
  if (!isValidDate(now)) throw new Error('valid clock required');
  if (typeof rule !== 'string' || !rule) throw new Error('denial rule required');
  const item = {
    ...key(attemptKey(attemptId)),
    attemptId: { S: attemptId },
    day: { S: ledgerDay(now) },
    timezone: { S: LEDGER_TIMEZONE },
    status: { S: 'denied_before_mutation' },
    denialRule: { S: rule },
    decidedAt: { S: now.toISOString() },
  };
  if (isFullSha(revision)) item.revision = { S: revision };
  return withNames({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(#PK)' });
}

/**
 * Human-issued override (S5a). This runs with a human's credentials against the trusted account,
 * never from candidate code or the broker. It binds one revision, one overridable rule and one
 * Tokyo day, requires a reason and an approver, and expires. Create-only: an override item is
 * never replaced, so its history (issued, consumed or expired unused) survives for audit. At
 * most one override exists per revision, rule and day.
 */
export function buildIssueOverridePut({ table, revision, rule, day, expiresAt, reason, approver, now }) {
  if (!isFullSha(revision)) throw new Error('override revision must be a full lowercase 40-hex commit id');
  if (!OVERRIDABLE_RULES.includes(rule)) throw new Error(`rule ${String(rule)} cannot be overridden`);
  if (typeof day !== 'string' || !DAY.test(day)) throw new Error('day must be YYYY-MM-DD');
  if (day !== ledgerDay(now)) throw new Error('an override can only be issued for the current accounting day');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('override reason required');
  if (typeof approver !== 'string' || !approver.trim()) throw new Error('override approver required');
  const nowEpoch = epochSeconds(now);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowEpoch) throw new Error('override expiry must be in the future');
  if (expiresAt - nowEpoch > MAX_OVERRIDE_TTL_SECONDS) throw new Error('override expiry exceeds the maximum lifetime');
  return withNames({
    TableName: table,
    Item: {
      ...key(overrideKey(rule, revision, day)),
      revision: { S: revision },
      rule: { S: rule },
      day: { S: day },
      timezone: { S: LEDGER_TIMEZONE },
      expiresAt: { N: String(expiresAt) },
      reason: { S: reason.trim() },
      approver: { S: approver.trim() },
      issuedAt: { S: now.toISOString() },
    },
    ConditionExpression: 'attribute_not_exists(#PK)',
  });
}

/** One-time initialisation by a human: pins the ledger id the broker is configured with. */
export function buildGenesisPut({ table, ledgerId, now }) {
  if (!isLedgerId(ledgerId)) throw new Error('ledger id must be 8-128 chars of [A-Za-z0-9._-]');
  if (!isValidDate(now)) throw new Error('valid clock required');
  return withNames({
    TableName: table,
    Item: {
      ...key(GENESIS_KEY),
      ledgerId: { S: ledgerId },
      timezone: { S: LEDGER_TIMEZONE },
      createdAt: { S: now.toISOString() },
      totalAttempts: { N: '0' },
    },
    ConditionExpression: 'attribute_not_exists(#PK)',
  });
}

// --- Orchestration over an injected client -------------------------------------------------

/** DynamoDB refused a conditional write: another writer won, or the state moved. */
export const isConditionFailure = (error) =>
  error?.name === 'TransactionCanceledException' || error?.name === 'ConditionalCheckFailedException';

/**
 * Preflight + reservation for one attempt. Returns the S11-shaped decision fields. Never
 * retries: a lost race or an unreadable ledger denies, and the caller does not auto-retry.
 *
 * Ordering contract for the wiring (arming work): call this strictly AFTER every other
 * deny-capable gate (static policy, live ChangeSet evaluation) and immediately before the
 * mutation. A reserved attempt has consumed budget; its only terminal outcomes are
 * succeeded / failed.
 *
 * Every denial is audited best-effort (S6b: recorded, no budget consumed). A failed audit write
 * never turns a denial into anything else.
 */
export async function reserveAttempt({ client, table, ledgerId, revision, attemptId, now }) {
  let genesisItem;
  let dayItem;
  let overrideItem;
  let readError = false;
  if (isValidDate(now) && isFullSha(revision) && isAttemptId(attemptId)) {
    try {
      const day = ledgerDay(now);
      // One serializable snapshot of the three items, so a concurrent reservation cannot make
      // genesis and the day counter look inconsistent (which would read as corruption).
      const keys = [GENESIS_KEY, dayKey(day), overrideKey(DAILY_CEILING_RULE, revision, day)];
      const res = await client.transactGetItems({ TransactItems: keys.map((sk) => ({ Get: { TableName: table, Key: key(sk) } })) });
      if (!Array.isArray(res?.Responses) || res.Responses.length !== keys.length) throw new Error('incomplete snapshot');
      [genesisItem, dayItem, overrideItem] = res.Responses.map((r) => r?.Item);
    } catch {
      readError = true;
    }
  }
  let decision = evaluatePreflight({ revision, attemptId, now, ledgerId, genesisItem, dayItem, overrideItem, readError });
  if (decision.result === 'allowed') {
    try {
      await client.transactWriteItems(buildReserveTransaction({ table, decision, now }));
      return { ...decision, attemptNumber: decision.observedAttemptCount + 1 };
    } catch (error) {
      const context = { revision, attemptId, day: decision.day, timezone: LEDGER_TIMEZONE };
      decision = isConditionFailure(error)
        ? deny(RULES.LEDGER_CONFLICT, 'sparse deploy ledger refused the reservation (state changed, attempt id reused, or override no longer valid); not retried automatically', context)
        : deny(RULES.LEDGER_UNAVAILABLE, 'sparse deploy ledger reservation could not be written', context);
    }
  }
  if (isValidDate(now) && isAttemptId(attemptId)) {
    try {
      await client.putItem(buildDenialPut({ table, attemptId, revision, rule: decision.rule, now }));
      decision = { ...decision, audited: true };
    } catch {
      decision = { ...decision, audited: false };
    }
  }
  return decision;
}

/**
 * Audit a denial from a gate that runs before `reserveAttempt` (static policy, live ChangeSet
 * evaluation, BROKER_NOT_ARMED). Best-effort: returns whether the record was written; it never
 * changes the denial.
 */
export async function recordDenial({ client, table, attemptId, revision, rule, now }) {
  try {
    await client.putItem(buildDenialPut({ table, attemptId, revision, rule, now }));
    return true;
  } catch {
    return false;
  }
}

/** Record the terminal outcome of a reserved attempt. Throws when the ledger refuses it. */
export async function recordOutcome({ client, table, attemptId, day, outcome, now }) {
  await client.transactWriteItems(buildOutcomeTransaction({ table, attemptId, day, outcome, now }));
  return { recorded: outcome, attemptId, day };
}
