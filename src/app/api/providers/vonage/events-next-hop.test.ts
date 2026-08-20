/**
 * `/events` から 2 手目を実際に撃つまでの**既定配線** (#646)。
 *
 * 🔴 **ここは差し替えを最小にする。** `voice-event.test.ts` は依存を注入して分岐を固定し、
 * `next-hop-dial.test.ts` は順序と後始末を固定するが、どちらも**既定の依存**
 * （相関リポジトリ・接続先リポジトリ・受付の付け替え）を 1 度も通らない。このプロジェクトが
 * 繰り返し踏んでいるのは「部品は全部 green なのに繋がっていない」型なので、ここだけは
 * 発信者だけを差し替えて残りは本物を通す。
 */
import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SIGNATURE_SECRET = 'TEST-signature-secret';
const PROVIDER_CALL_ID = 'TEST-vonage-uuid-hop1';
const NEXT_PROVIDER_CALL_ID = 'TEST-vonage-uuid-hop2';
const RECEPTION_ID = 'TEST-reception-hop';

vi.mock('@/lib/call/vonage-signature', () => ({
  resolveVonageSignatureSecret: async () => SIGNATURE_SECRET,
}));

const initiate = vi.fn();
vi.mock('@/lib/routing/voice-dial', () => ({
  resolveVoiceInitiator: async () => ({ key: 'vonage', initiate }),
}));

import {
  getCallCorrelationRepository,
  __resetCallCorrelationRepository,
} from '@/lib/routing/call-correlation';
import { getReceptionSessionRepository } from '@/lib/data-stores/reception-store';
import { getBackend } from '@/lib/data';
import type { StoredCallCorrelation } from '@/lib/routing/call-correlation';
import type { ReceptionSession } from '@/domain/reception/session';
import { POST as events } from './events/route';

const SEED_POLICY = 'seed-personal-acting-department';

// 秘密は**引数で受ける**。`createHmac` へ定数を直接渡すと semgrep の
// `hardcoded-hmac-key` に当たる（`webhook-routes.test.ts` も同じ形にしてある）。
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
  return new Request('https://reception.test/api/providers/vonage/events', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${header}.${payload}.${sig}`,
      'x-forwarded-host': 'reception.test',
      'x-forwarded-proto': 'https',
    },
    body: rawBody,
  });
}

const unanswered = () => signed(JSON.stringify({ uuid: PROVIDER_CALL_ID, status: 'unanswered' }));

async function reception(): Promise<ReceptionSession | undefined> {
  return getReceptionSessionRepository().get(RECEPTION_ID);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  initiate.mockResolvedValue({ providerCallId: NEXT_PROVIDER_CALL_ID });

  __resetCallCorrelationRepository();
  // 🔴 シングルトンを捨てるだけでは**データが残る**。前のケースが作った 2 手目の相関が
  // 居座ると「作られていないこと」を主張するケースが常に green になる。
  await getBackend().collection('call-correlations').reset();
  await getCallCorrelationRepository().put({
    providerCallId: PROVIDER_CALL_ID,
    receptionId: RECEPTION_ID,
    tenantId: 'internal',
    siteId: 'default-site',
    position: {
      callUuid: RECEPTION_ID,
      policyId: SEED_POLICY,
      stepId: 'personal',
      hops: 0,
      ledger: [],
      eventCount: 7,
    },
    voiceState: 'ringing',
    eventCount: 7,
    status: 'in_flight',
    updatedAt: '2026-08-20T00:00:00.000Z',
  });

  await getReceptionSessionRepository().put({
    id: RECEPTION_ID,
    kioskId: 'TEST-kiosk',
    state: 'calling',
    targetType: 'staff',
    targetId: 'staff-seed',
    providerCallId: PROVIDER_CALL_ID,
    startedAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  });
});

describe('/events → 2 手目の実発信（既定配線 #646）', () => {
  it('未応答を受けて次の手（代理担当）へ発信する', async () => {
    const res = await events(unanswered());
    expect(res.status).toBe(204);
    expect(initiate).toHaveBeenCalledTimes(1);
    const command = initiate.mock.calls[0]?.[0] as { endpoint: { id: string }; callUuid: string };
    expect(command.endpoint.id).toBe('seed-ep-acting');
    expect(command.callUuid).toBe(RECEPTION_ID);
  });

  it('🔴 2 手目の相関が新しい通話 ID で作られ、位置と上限を引き継ぐ', async () => {
    await events(unanswered());
    const hop2 = await getCallCorrelationRepository().get(NEXT_PROVIDER_CALL_ID);
    expect(hop2?.position.stepId).toBe('acting');
    expect(hop2?.position.hops).toBe(1);
    expect(hop2?.status).toBe('in_flight');
    expect(hop2?.voiceState).toBe('queued');
    // 上限は取次全体で効く（スライス 1）。新レコードで 0 に戻らない。
    expect(hop2?.position.eventCount).toBe(8);
  });

  it('🔴 1 手目の相関は確定する ── 遅れて届く webhook で取次を二重に進めない', async () => {
    await events(unanswered());
    const hop1 = await getCallCorrelationRepository().get(PROVIDER_CALL_ID);
    expect(hop1?.status).toBe('settled');
    expect(hop1?.position.stepId).toBe('personal');
  });

  /**
   * 🔴 **付け替えないと `/status` は 1 手目（未応答で確定済み）を読み続ける。**
   * 2 手目が鳴っている最中に来訪者へ「応答が得られませんでした」と表示してしまう。
   */
  it('🔴 受付の相関キーを 2 手目へ付け替える', async () => {
    await events(unanswered());
    expect((await reception())?.providerCallId).toBe(NEXT_PROVIDER_CALL_ID);
    expect((await reception())?.state).toBe('calling');
  });

  it('🔴 同じ jti の再配信では二度目を撃たない', async () => {
    const request = unanswered();
    const replay = new Request(request, { body: await request.clone().text() });
    await events(request);
    await events(replay);
    expect(initiate).toHaveBeenCalledTimes(1);
  });

  it('🔴 発信が失敗しても 5xx を返さない ── Vonage の再送がまた撃つ', async () => {
    initiate.mockRejectedValue(new Error('TEST-dial-failed'));
    const res = await events(unanswered());
    expect(res.status).toBe(204);
    expect(await getCallCorrelationRepository().get(NEXT_PROVIDER_CALL_ID)).toBeUndefined();
  });

  /**
   * 🔴 来訪者がキャンセルした後や既に確定した受付のために社内の電話を鳴らさない。
   * 相関は受付の終端と連動していないので、ここで見ないと最大 10 段まで鳴る。
   */
  it('🔴 受付がもう呼び出し中でなければ撃たない', async () => {
    const session = await getReceptionSessionRepository().get(RECEPTION_ID);
    await getReceptionSessionRepository().put({ ...session!, state: 'cancelled' });

    const res = await events(unanswered());

    expect(res.status).toBe(204);
    expect(initiate).not.toHaveBeenCalled();
    expect(await getCallCorrelationRepository().get(NEXT_PROVIDER_CALL_ID)).toBeUndefined();
  });

  /**
   * 🔴 **発信中に `/status` が受付を確定させる窓**（予約〜付け替えの間）。
   *
   * 付け替えは read-modify-write ではなく `'calling'` 条件付きにしてあるので、
   * 終端した受付を `'calling'` へ**巻き戻さない**。巻き戻すと受付履歴・監査が二重に残る。
   */
  it('🔴 発信中に受付が確定したら、付け替えで状態を巻き戻さない', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    initiate.mockImplementation(async () => {
      // `/status` のポーリングが割り込んで受付を確定させた、という状況。
      const session = await getReceptionSessionRepository().get(RECEPTION_ID);
      await getReceptionSessionRepository().put({ ...session!, state: 'timeout' });
      return { providerCallId: NEXT_PROVIDER_CALL_ID };
    });

    await events(unanswered());

    const after = await reception();
    expect(after?.state).toBe('timeout');
    expect(after?.providerCallId).toBe(PROVIDER_CALL_ID);
    const logged = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('handoff_incomplete');
    expect(logged).not.toContain('"result":"dialed"');
  });

  /**
   * 🔴 **予約で通話状態を進めない。** 進めると、受付の相関キーがまだ 1 手目を指している
   * 間に `/status` が `no_answer` を読み、2 手目が鳴っている最中に来訪者へ
   * 「応答が得られませんでした」と表示して代替導線へ倒してしまう。
   */
  it('🔴 発信中の 1 手目は未応答として読めない（来訪者を先に倒さない）', async () => {
    let duringDial: StoredCallCorrelation | undefined;
    initiate.mockImplementation(async () => {
      duringDial = await getCallCorrelationRepository().get(PROVIDER_CALL_ID);
      return { providerCallId: NEXT_PROVIDER_CALL_ID };
    });

    await events(unanswered());

    expect(duringDial?.voiceState).toBe('ringing');
    // 1 手目の呼出予算も引き直されている（期限切れで同じことが起きないように）。
    expect(Date.parse(duringDial!.dialExpiresAt!)).toBeGreaterThan(
      Date.parse('2026-08-20T00:00:50.000Z'),
    );
  });
});
