/**
 * 代表ジャーニー 1: 個人携帯 → 代理担当 → 部門代表（**実発信経路の通し**） (#736 Lane V)。
 *
 * ## なぜ要るのか
 *
 * mock 経路（1 リクエストで取次を回し切る `runRoutedCall`）の 3 段通しは
 * `call-execution.test.ts` に在る。だが**実発信経路にはこれが無かった** ── 1 手目
 * （`runVoiceRoutedCall`）・2 手目以降（`dialNextHop`）・webhook の適用
 * （`applyVoiceEventToCorrelation`）は各々厚くテストされているのに、
 * **hop1 → webhook → hop2 → webhook → hop3 を繋げた試験が 1 本も無い**。
 *
 * このリポジトリが繰り返し踏んでいるのは「部品は全部 green なのに繋がっていない」型で、
 * 実際 #748（QR が `/call` を呼ばない）も #750（配線が縛られていない）もその形だった。
 *
 * ## 何を固定するか
 *
 * - 未応答が届くたびに**次の手へ進む**（personal → acting → department）
 * - 各手で**相関が入れ替わり**、受付の相関キーが追随する
 * - 上限（hops / events）が**取次全体で**効き続ける
 * - 応答が届いたら**そこで止まる**（以降の手を撃たない）
 */
import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SIGNATURE_SECRET = 'TEST-signature-secret';
const RECEPTION_ID = 'TEST-reception-3hop';

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
import type { ReceptionSession } from '@/domain/reception/session';
import { POST as events } from './events/route';

const SEED_POLICY = 'seed-personal-acting-department';
const HOP1 = 'TEST-call-hop1';

function signed(rawBody: string): Request {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      jti: `TEST-jti-${Math.random()}`,
      payload_hash: createHash('sha256').update(rawBody).digest('hex'),
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', SIGNATURE_SECRET).update(`${header}.${payload}`).digest('base64url');
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

/** 現在の相関キー（受付が指している通話）へ webhook を届ける。 */
async function deliver(status: string): Promise<void> {
  const reception = await getReceptionSessionRepository().get(RECEPTION_ID);
  const uuid = reception?.providerCallId;
  expect(uuid, '受付が相関キーを持っていない').toBeDefined();
  await events(signed(JSON.stringify({ uuid, status })));
}

const dialedEndpoints = () =>
  initiate.mock.calls.map((c) => (c[0] as { endpoint: { id: string } }).endpoint.id);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  let hop = 1;
  initiate.mockImplementation(async () => ({ providerCallId: `TEST-call-hop${++hop}` }));

  __resetCallCorrelationRepository();
  await getBackend().collection('call-correlations').reset();

  // 1 手目は既に撃たれている状態から始める（`runVoiceRoutedCall` が書く形）。
  await getCallCorrelationRepository().put({
    providerCallId: HOP1,
    receptionId: RECEPTION_ID,
    tenantId: 'internal',
    siteId: 'default-site',
    position: { callUuid: RECEPTION_ID, policyId: SEED_POLICY, stepId: 'personal', hops: 0, ledger: [] },
    voiceState: 'ringing',
    eventCount: 0,
    status: 'in_flight',
    updatedAt: '2026-08-21T00:00:00.000Z',
  });
  await getReceptionSessionRepository().put({
    id: RECEPTION_ID,
    kioskId: 'TEST-kiosk',
    state: 'calling',
    targetType: 'staff',
    targetId: 'staff-seed',
    providerCallId: HOP1,
    startedAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  } satisfies ReceptionSession);
});

describe('個人携帯 → 代理担当 → 部門代表（実発信経路の通し・#736）', () => {
  it('🔴 未応答が続くと順に次の手へ進む', async () => {
    await deliver('unanswered'); // personal → acting
    await deliver('unanswered'); // acting → department

    expect(dialedEndpoints()).toEqual(['seed-ep-acting', 'seed-ep-department']);
  });

  it('🔴 各手で相関が入れ替わり、受付の相関キーが追随する', async () => {
    await deliver('unanswered');
    expect((await getReceptionSessionRepository().get(RECEPTION_ID))?.providerCallId).toBe(
      'TEST-call-hop2',
    );

    await deliver('unanswered');
    expect((await getReceptionSessionRepository().get(RECEPTION_ID))?.providerCallId).toBe(
      'TEST-call-hop3',
    );
  });

  /**
   * 🔴 **上限は取次全体で効き続ける。** 手ごとに新しい相関になるので、位置ごと引き継がないと
   * hops も eventCount も 0 に戻り、上限が hop 数だけ緩む。
   */
  it('🔴 hops とイベント数が取次全体で積み上がる', async () => {
    await deliver('unanswered');
    await deliver('unanswered');

    const hop3 = await getCallCorrelationRepository().get('TEST-call-hop3');
    expect(hop3?.position.hops).toBe(2);
    expect(hop3?.position.eventCount).toBe(2);
    expect(hop3?.position.stepId).toBe('department');
  });

  /**
   * **電話に出ただけでは承諾ではない**（`voice-call-state.ts` の意図的な設計）。
   *
   * `answered` は `awaiting_acceptance`（非 terminal）で、通話終了の `completed` は一律
   * `no_answer` へ畳まれる ── 「誰も向かうと言っていない」ので次の手へ進む。
   * 終端成功にすると、誰も来ないまま取次が止まって**来訪者が放置される**。
   *
   * 🔴 この期待は最初**逆に書いて赤くなった**。設計の理由が実コードに書いてあるのに、
   * 「繋がったら止まる」という思い込みでテストを書いていた。ここに残しておく。
   */
  it('出ただけで切られたら次の手へ進む（承諾ではないため）', async () => {
    await deliver('unanswered'); // → acting を撃つ
    initiate.mockClear();

    await deliver('answered');
    await deliver('completed');

    expect(dialedEndpoints()).toEqual(['seed-ep-department']);
  });

  /**
   * 🔴 **承諾したら止まる。** 担当者が「まもなく向かう」を押したあとに電話を切っても、
   * 次の担当者を鳴らさない（#742 の B1 が塞いだ事故そのもの）。
   */
  it('🔴 DTMF で承諾したらそれ以上撃たない', async () => {
    const { POST: choice } = await import('./choice/route');
    await deliver('unanswered'); // → acting を撃つ
    initiate.mockClear();

    await deliver('answered');
    const uuid = (await getReceptionSessionRepository().get(RECEPTION_ID))?.providerCallId;
    // 「2 まもなく向かう」。
    await choice(signed(JSON.stringify({ uuid, dtmf: { digits: '2' } })));
    await deliver('completed');

    expect(initiate, '承諾後に次の手を撃っている').not.toHaveBeenCalled();
  });

  /**
   * 🔴 1 手目の相関は確定し、遅れて届く webhook で取次が二重に進まない。
   */
  it('🔴 撃ち終えた手の相関は確定し、遅延 webhook で再開しない', async () => {
    await deliver('unanswered');
    expect((await getCallCorrelationRepository().get(HOP1))?.status).toBe('settled');

    initiate.mockClear();
    // 1 手目へ遅れて届いた webhook。
    await events(signed(JSON.stringify({ uuid: HOP1, status: 'completed' })));
    expect(initiate).not.toHaveBeenCalled();
  });
});
