import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RoutingPosition } from '@/domain/routing/resumable';
import {
  DataBackedCallCorrelationRepository,
  type StoredCallCorrelation,
} from './call-correlation';
import { resolveVerifiedWebhook } from './vonage-webhook-context';

const SIGNATURE_SECRET = 'TEST-signature-secret';
const NOW = 1_800_000_000;
const PROVIDER_CALL_ID = 'TEST-vonage-uuid-1';

const POSITION: RoutingPosition = {
  callUuid: 'TEST-call-1',
  policyId: 'p1',
  stepId: 's1',
  hops: 0,
  ledger: [],
};

const CORRELATION: StoredCallCorrelation = {
  providerCallId: PROVIDER_CALL_ID,
  receptionId: 'TEST-reception-1',
  tenantId: 'internal',
  siteId: 'default-site',
  position: POSITION,
  status: 'in_flight',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function body(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ uuid: PROVIDER_CALL_ID, status: 'answered', ...over });
}

function bearer(rawBody: string, secret = SIGNATURE_SECRET, nowSec = NOW): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iat: nowSec,
      jti: 'TEST-jti',
      payload_hash: createHash('sha256').update(rawBody).digest('hex'),
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `Bearer ${header}.${payload}.${sig}`;
}

let repo: DataBackedCallCorrelationRepository;

/**
 * テナントの signature secret を返す注入。
 * **既定引数にしない** ── `deps(undefined as string | undefined)` が既定値へ落ちて「secret 未設定」を検証できない
 * （JS の既定引数は明示的な undefined にも適用される。実際にこれで 1 度素通りした）。
 */
function deps(secret: string | undefined) {
  return {
    correlations: repo,
    loadSignatureSecret: async () => secret,
    nowSec: NOW,
  };
}

/** 正常な secret を持つ依存。 */
function okDeps() {
  return deps(SIGNATURE_SECRET);
}

beforeEach(async () => {
  repo = new DataBackedCallCorrelationRepository();
  await repo.put(CORRELATION);
});

describe('resolveVerifiedWebhook — 正常系 (#4)', () => {
  it('署名が正しく相関が引ければ受付を返す', async () => {
    const raw = body();
    const result = await resolveVerifiedWebhook(
      { rawBody: raw, authorization: bearer(raw) },
      okDeps(),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.correlation.receptionId).toBe('TEST-reception-1');
  });

  it('署名検証はそのテナントの secret で行う（テナントを跨がない）', async () => {
    const raw = body();
    const wrongTenantSecret = await resolveVerifiedWebhook(
      { rawBody: raw, authorization: bearer(raw, 'TEST-another-tenant-secret') },
      okDeps(),
    );
    expect(wrongTenantSecret.ok).toBe(false);
  });
});

describe('拒否は一様であること (#4)', () => {
  // 🔴 webhook は公開エンドポイント。理由ごとに違う応答を返すと、通話 ID の総当たりで
  // 「その通話は存在する」「署名だけ違う」が分かり、受付の在庫と鍵の有無が漏れる。
  it.each([
    ['未知の通話 ID', async () => {
      const raw = body({ uuid: 'TEST-unknown' });
      return resolveVerifiedWebhook({ rawBody: raw, authorization: bearer(raw) }, okDeps());
    }],
    ['署名が違う', async () => {
      const raw = body();
      return resolveVerifiedWebhook({ rawBody: raw, authorization: bearer(raw, 'TEST-bad') }, okDeps());
    }],
    ['本文が改ざんされた', async () => {
      const raw = body();
      const auth = bearer(raw);
      return resolveVerifiedWebhook({ rawBody: body({ status: 'completed' }), authorization: auth }, okDeps());
    }],
    ['secret が未設定', async () => {
      const raw = body();
      return resolveVerifiedWebhook({ rawBody: raw, authorization: bearer(raw) }, deps(undefined as string | undefined));
    }],
    ['Authorization が無い', async () => {
      const raw = body();
      return resolveVerifiedWebhook({ rawBody: raw, authorization: undefined }, okDeps());
    }],
    ['本文が JSON でない', async () => {
      return resolveVerifiedWebhook({ rawBody: 'not-json', authorization: bearer('not-json') }, okDeps());
    }],
    ['本文に通話 ID が無い', async () => {
      const raw = JSON.stringify({ status: 'answered' });
      return resolveVerifiedWebhook({ rawBody: raw, authorization: bearer(raw) }, okDeps());
    }],
  ])('%s は同じ結果になる', async (_label, run) => {
    const result = await run();
    // 失敗はすべて同じ形（理由を持たない）。呼び出し側が理由で応答を分けられないようにする。
    expect(result).toEqual({ ok: false });
  });
});

describe('確定済みの取次を進めない (#4)', () => {
  it('settled の相関でも解決自体は成功する（判断は呼び出し側）', async () => {
    await repo.put({ ...CORRELATION, status: 'settled' });
    const raw = body();
    const result = await resolveVerifiedWebhook({ rawBody: raw, authorization: bearer(raw) }, okDeps());
    expect(result.ok && result.correlation.status).toBe('settled');
  });
});

describe('本文のクエリ相当を権威にしない (#4)', () => {
  // 🔴 URL のクエリは payload_hash の対象外なので、正規の webhook を別の通話へ
  // 付け替えられる。相関は必ず署名済み本文の通話 ID から引く。
  it('本文の通話 ID だけで相関を引く（引数に URL を取らない）', () => {
    expect(resolveVerifiedWebhook.length).toBe(2);
  });
});
