#!/usr/bin/env tsx
import assert from 'node:assert/strict';

process.env.DATA_BACKEND = 'dynamodb';
process.env.AWS_REGION ??= 'ap-northeast-1';
process.env.AWS_DEFAULT_REGION ??= process.env.AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_EC2_METADATA_DISABLED = 'true';
process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
process.env.TABLE_NAME ??= 'open-reception-local';

type SmokeItem = {
  id: string;
  tenantId: string;
  state: 'new' | 'updated';
  removable?: string;
};

type SmokeLog = {
  id: string;
  at: string;
  correlationId: string;
  message: string;
};

async function main(): Promise<void> {
  const { getBackend } = await import('../src/lib/data');
  const backend = getBackend();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const itemId = `smoke-${suffix}`;
  const tenantId = `tenant-${suffix}`;

  const collection = backend.collection<SmokeItem>('local-aws-smoke', {
    ttlSeconds: 300,
    indexedField: 'tenantId',
  });

  await collection.put({
    id: itemId,
    tenantId,
    state: 'new',
    removable: 'present',
  });

  const loaded = await collection.get(itemId);
  assert.equal(loaded?.state, 'new');
  assert.equal(loaded?.removable, 'present');

  const indexed = await collection.listByIndex(tenantId);
  assert.equal(indexed.some((item) => item.id === itemId), true);

  const insertedAgain = await collection.putIfAbsent({
    id: itemId,
    tenantId,
    state: 'new',
  });
  assert.equal(insertedAgain, false, 'putIfAbsent must reject an existing id');

  const updated = await collection.updateIf(
    itemId,
    { state: 'updated', removable: undefined },
    { state: 'new' },
  );
  assert.equal(updated, true);

  const afterUpdate = await collection.get(itemId);
  assert.equal(afterUpdate?.state, 'updated');
  assert.equal(afterUpdate?.removable, undefined);

  const singleton = backend.singleton<{ value: string }>('local-aws-smoke-singleton');
  await singleton.put({ value: suffix });
  assert.equal((await singleton.get())?.value, suffix);

  const log = backend.log<SmokeLog>('local-aws-smoke-log', {
    timestampField: 'at',
    indexedField: 'correlationId',
  });
  const logEntry: SmokeLog = {
    id: `log-${suffix}`,
    at: new Date().toISOString(),
    correlationId: `corr-${suffix}`,
    message: 'local aws smoke',
  };
  await log.put(logEntry);
  assert.equal((await log.findBy('correlationId', logEntry.correlationId))?.id, logEntry.id);
  assert.equal((await log.listSince(logEntry.at)).some((entry) => entry.id === logEntry.id), true);

  await collection.remove(itemId);
  assert.equal(await collection.get(itemId), undefined);

  console.log(
    `[local-aws-smoke] PASS endpoint=${process.env.AWS_ENDPOINT_URL} table=${process.env.TABLE_NAME}`,
  );
}

main().catch((error) => {
  console.error('[local-aws-smoke] FAIL', error);
  process.exit(1);
});
