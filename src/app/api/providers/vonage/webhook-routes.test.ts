import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SIGNATURE_SECRET = 'TEST-signature-secret';
const PROVIDER_CALL_ID = 'TEST-vonage-uuid-1';

vi.mock('@/lib/call/vonage-signature', () => ({
  resolveVonageSignatureSecret: async () => SIGNATURE_SECRET,
}));

import { getCallCorrelationRepository, __resetCallCorrelationRepository } from '@/lib/routing/call-correlation';
import { POST as answer } from './answer/route';
import { POST as dtmf } from './dtmf/route';
import { POST as events } from './events/route';

const ROUTES = [
  ['answer', answer],
  ['events', events],
  ['dtmf', dtmf],
] as const;

function signed(rawBody: string, secret = SIGNATURE_SECRET): Request {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      jti: `TEST-jti-${Math.random()}`,
      payload_hash: createHash('sha256').update(rawBody).digest('hex'),
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return new Request('https://reception.test/api/providers/vonage/x', {
    method: 'POST',
    headers: { authorization: `Bearer ${header}.${payload}.${sig}` },
    body: rawBody,
  });
}

function body(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ uuid: PROVIDER_CALL_ID, ...over });
}

beforeEach(async () => {
  __resetCallCorrelationRepository();
  await getCallCorrelationRepository().put({
    providerCallId: PROVIDER_CALL_ID,
    receptionId: 'TEST-reception-1',
    tenantId: 'internal',
    siteId: 'default-site',
    position: { callUuid: 'TEST-call-1', policyId: 'p1', stepId: 's1', hops: 0, ledger: [] },
    status: 'in_flight',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
});

describe('3 本とも同じ拒否をする (#4)', () => {
  it.each(ROUTES)('%s は署名が無いリクエストを 403 で拒否する', async (_name, handler) => {
    const res = await handler(
      new Request('https://reception.test/x', { method: 'POST', body: body() }),
    );
    expect(res.status).toBe(403);
  });

  it.each(ROUTES)('%s は署名が違うリクエストを 403 で拒否する', async (_name, handler) => {
    const res = await handler(signed(body(), 'TEST-wrong-secret'));
    expect(res.status).toBe(403);
  });

  it.each(ROUTES)('%s は未知の通話 ID を 403 で拒否する', async (_name, handler) => {
    const res = await handler(signed(body({ uuid: 'TEST-unknown' })));
    expect(res.status).toBe(403);
  });

  // 🔴 理由ごとに応答が違うと、通話 ID の総当たりで在庫と鍵の有無が分かる。
  it.each(ROUTES)('%s の拒否応答は理由によらず同一（本文・status とも）', async (_name, handler) => {
    const noSig = await handler(new Request('https://reception.test/x', { method: 'POST', body: body() }));
    const badSig = await handler(signed(body(), 'TEST-wrong-secret'));
    const unknown = await handler(signed(body({ uuid: 'TEST-unknown' })));
    const texts = await Promise.all([noSig.text(), badSig.text(), unknown.text()]);
    expect(new Set(texts).size).toBe(1);
    expect(new Set([noSig.status, badSig.status, unknown.status]).size).toBe(1);
  });
});

describe('/answer — 第 1 段しか返さない (#4)', () => {
  it('検証を通ると NCCO を返す', async () => {
    const res = await answer(signed(body()));
    expect(res.status).toBe(200);
    const ncco = (await res.json()) as unknown[];
    expect(ncco.some((a) => (a as { action?: string }).action === 'input')).toBe(true);
  });

  // 🔴 誰が出たか分からない時点で来訪者情報を読み上げると、留守番電話・家族・同僚に伝わる。
  it('来訪者情報を含まない', async () => {
    const res = await answer(signed(body()));
    const text = JSON.stringify(await res.json());
    for (const forbidden of ['様がお越し', 'ご用件']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('/dtmf — 本人確認の後だけ詳細を返す (#4)', () => {
  it('1（応答する）なら第 2 段の NCCO を返す', async () => {
    const res = await dtmf(signed(body({ dtmf: { digits: '1' } })));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('様がお越し');
  });

  it.each(['', '9', '#'])('本人確認でない入力 %s では詳細を返さない', async (digits) => {
    const res = await dtmf(signed(body({ dtmf: { digits } })));
    expect(res.status).toBe(204);
  });

  it('dtmf フィールドが無くても落ちない（詳細も返さない）', async () => {
    const res = await dtmf(signed(body()));
    expect(res.status).toBe(204);
  });
});

describe('/events — 未知のステータスで再送を誘発しない (#4)', () => {
  it.each(['ringing', 'answered', 'completed'])('既知のステータス %s を受け取る', async (status) => {
    const res = await events(signed(body({ status })));
    expect(res.status).toBe(204);
  });

  // 4xx を返すと Vonage が再送し続ける。未知は黙って受け取る。
  it('未知のステータスでも 2xx を返す', async () => {
    const res = await events(signed(body({ status: 'TEST-unknown-status' })));
    expect(res.status).toBeLessThan(300);
  });
});
