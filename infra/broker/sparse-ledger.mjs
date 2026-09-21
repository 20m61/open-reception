#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const PROJECT_KEY = 'PROJECT#open-reception';
export const SOFT_SUCCESS_CEILING = 2;

export function tokyoDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function readString(item, key) {
  const value = item?.[key]?.S;
  return typeof value === 'string' ? value : undefined;
}

function readNumber(item, key) {
  const raw = item?.[key]?.N;
  if (typeof raw !== 'string') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function evaluatePreflight({
  revision,
  now = new Date(),
  dayItem,
  overrideItem,
}) {
  if (!/^[0-9a-f]{40}$/i.test(revision ?? '')) {
    return {
      result: 'denied',
      rule: 'TRUSTED_REVISION_INVALID',
      retryable: false,
      reason: 'trusted source revision must be a full 40-hex commit id',
    };
  }

  const day = tokyoDay(now);
  const rawCount = readNumber(dayItem, 'successCount');
  const successCount = rawCount ?? 0;
  if (!Number.isInteger(successCount) || successCount < 0) {
    return {
      result: 'denied',
      rule: 'SPARSE_LEDGER_CORRUPT',
      retryable: false,
      day,
      reason: 'successCount is not a non-negative integer',
    };
  }

  if (successCount < SOFT_SUCCESS_CEILING) {
    return {
      result: 'allowed',
      rule: null,
      retryable: false,
      mode: 'normal',
      day,
      successCount,
      remainingAutomaticSuccesses: SOFT_SUCCESS_CEILING - successCount,
    };
  }

  const overrideRevision = readString(overrideItem, 'revision');
  const overrideDay = readString(overrideItem, 'day');
  const expiresAt = readNumber(overrideItem, 'expiresAt');
  const reason = readString(overrideItem, 'reason')?.trim();
  const approver = readString(overrideItem, 'approver')?.trim();
  const nowEpoch = Math.floor(now.getTime() / 1000);

  if (
    overrideRevision !== revision ||
    overrideDay !== day ||
    !Number.isInteger(expiresAt) ||
    expiresAt <= nowEpoch ||
    !reason ||
    !approver
  ) {
    return {
      result: 'denied',
      rule: 'SPARSE_DEPLOY_OVERRIDE_REQUIRED',
      retryable: false,
      day,
      successCount,
      reason:
        'two successful dev deploys already exist for this Tokyo day; a valid one-shot override bound to this revision is required',
    };
  }

  return {
    result: 'allowed',
    rule: null,
    retryable: false,
    mode: 'override',
    day,
    successCount,
    override: {
      revision,
      expiresAt,
      reason,
      approver,
    },
  };
}

function awsJson(args) {
  const stdout = execFileSync('aws', [...args, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return stdout.trim() ? JSON.parse(stdout) : {};
}

function key(pk, sk) {
  return JSON.stringify({ PK: { S: pk }, SK: { S: sk } });
}

function getItem(table, sk) {
  const result = awsJson([
    'dynamodb',
    'get-item',
    '--table-name',
    table,
    '--consistent-read',
    '--key',
    key(PROJECT_KEY, sk),
  ]);
  return result.Item ?? {};
}

function recordNormalSuccess({ table, day, now }) {
  awsJson([
    'dynamodb',
    'update-item',
    '--table-name',
    table,
    '--key',
    key(PROJECT_KEY, `DAY#${day}`),
    '--update-expression',
    'SET successCount = if_not_exists(successCount, :zero) + :one, updatedAt = :updatedAt',
    '--condition-expression',
    'attribute_not_exists(successCount) OR successCount < :soft',
    '--expression-attribute-values',
    JSON.stringify({
      ':zero': { N: '0' },
      ':one': { N: '1' },
      ':soft': { N: String(SOFT_SUCCESS_CEILING) },
      ':updatedAt': { S: now.toISOString() },
    }),
  ]);
}

function recordOverrideSuccess({ table, day, revision, now }) {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const transaction = [
    {
      Update: {
        TableName: table,
        Key: { PK: { S: PROJECT_KEY }, SK: { S: `DAY#${day}` } },
        UpdateExpression:
          'SET successCount = if_not_exists(successCount, :zero) + :one, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':zero': { N: '0' },
          ':one': { N: '1' },
          ':updatedAt': { S: now.toISOString() },
        },
      },
    },
    {
      Delete: {
        TableName: table,
        Key: { PK: { S: PROJECT_KEY }, SK: { S: `OVERRIDE#${revision}` } },
        ConditionExpression:
          'revision = :revision AND #day = :day AND expiresAt > :now AND attribute_exists(reason) AND attribute_exists(approver)',
        ExpressionAttributeNames: { '#day': 'day' },
        ExpressionAttributeValues: {
          ':revision': { S: revision },
          ':day': { S: day },
          ':now': { N: String(nowEpoch) },
        },
      },
    },
  ];
  awsJson(['dynamodb', 'transact-write-items', '--transact-items', JSON.stringify(transaction)]);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, table: '', revision: '', day: '', mode: '', now: '' };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    const value = rest[++i] ?? '';
    if (key === '--table') args.table = value;
    else if (key === '--revision') args.revision = value;
    else if (key === '--day') args.day = value;
    else if (key === '--mode') args.mode = value;
    else if (key === '--now') args.now = value;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!['preflight', 'record-success'].includes(command ?? '')) {
    throw new Error('command must be preflight or record-success');
  }
  if (!args.table) throw new Error('--table is required');
  if (!/^[0-9a-f]{40}$/i.test(args.revision)) throw new Error('--revision must be a 40-hex commit id');
  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const now = args.now ? new Date(args.now) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error('--now must be an ISO timestamp');

    if (args.command === 'preflight') {
      const day = tokyoDay(now);
      const dayItem = getItem(args.table, `DAY#${day}`);
      const overrideItem = getItem(args.table, `OVERRIDE#${args.revision}`);
      const result = evaluatePreflight({
        revision: args.revision,
        now,
        dayItem,
        overrideItem,
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exitCode = result.result === 'allowed' ? 0 : 43;
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.day)) throw new Error('--day is required');
    if (!['normal', 'override'].includes(args.mode)) {
      throw new Error('--mode must be normal or override');
    }

    if (args.mode === 'normal') {
      recordNormalSuccess({ table: args.table, day: args.day, now });
    } else {
      recordOverrideSuccess({
        table: args.table,
        day: args.day,
        revision: args.revision,
        now,
      });
    }
    process.stdout.write(
      JSON.stringify({
        result: 'recorded',
        mode: args.mode,
        day: args.day,
        revision: args.revision,
      }) + '\n',
    );
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : error) + '\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
