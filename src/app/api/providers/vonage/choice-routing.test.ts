/**
 * 担当者の意思表示が取次を止めること (#646 / レビュー B1)。
 *
 * 🔴 **これが無いと成功経路で escalation が誤爆する。** `applyVoiceEvent` は `answered` を
 * `awaiting_acceptance`（非 terminal）にし、通話終了の `completed` を一律 `no_answer` へ
 * 畳む。選択が相関に残っていないと、担当者が「まもなく向かう」を押して切った瞬間に
 * 次の担当者が鳴る ── 2 手目以降が実発信になった今、実際の電話連鎖になる。
 */
import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SIGNATURE_SECRET = 'TEST-signature-secret';
const PROVIDER_CALL_ID = 'TEST-vonage-uuid-choice';
const RECEPTION_ID = 'TEST-reception-choice';

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
import { POST as choice } from './choice/route';
import { POST as events } from './events/route';

const SEED_POLICY = 'seed-personal-acting-department';

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
    headers: {
      authorization: `Bearer ${header}.${payload}.${sig}`,
      'x-forwarded-host': 'reception.test',
      'x-forwarded-proto': 'https',
    },
    body: rawBody,
  });
}

const pressed = (digits: string) =>
  signed(JSON.stringify({ uuid: PROVIDER_CALL_ID, dtmf: { digits } }));
const status = (s: string) => signed(JSON.stringify({ uuid: PROVIDER_CALL_ID, status: s }));

const stored = () => getCallCorrelationRepository().get(PROVIDER_CALL_ID);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  initiate.mockResolvedValue({ providerCallId: 'TEST-vonage-uuid-next' });

  __resetCallCorrelationRepository();
  await getBackend().collection('call-correlations').reset();
  await getCallCorrelationRepository().put({
    providerCallId: PROVIDER_CALL_ID,
    receptionId: RECEPTION_ID,
    tenantId: 'internal',
    siteId: 'default-site',
    position: { callUuid: RECEPTION_ID, policyId: SEED_POLICY, stepId: 'personal', hops: 0, ledger: [] },
    // 担当者が応答した直後の状態。
    voiceState: 'awaiting_acceptance',
    eventCount: 1,
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
  } as ReceptionSession);
});

describe('担当者の承諾が取次を止める (#646)', () => {
  it('🔴 「2 まもなく向かう」で取次が確定する', async () => {
    await choice(pressed('2'));
    const s = await stored();
    expect(s?.voiceState).toBe('staff_coming');
    expect(s?.status).toBe('settled');
  });

  /**
   * 🔴 **ここが本体。** 承諾を書いていないと、この `completed` が `no_answer` へ畳まれて
   * 次の担当者へ実際に発信される。
   */
  it('🔴 承諾したあとに電話を切っても、次の担当者を鳴らさない', async () => {
    await choice(pressed('2'));
    await events(status('completed'));

    expect(initiate).not.toHaveBeenCalled();
    const s = await stored();
    expect(s?.voiceState).toBe('staff_coming');
  });

  /**
   * 「3 対応できない」「4 代理担当へ」は逆に**次の手へ進めたい**選択。
   * 止めてしまうと来訪者が放置される。
   */
  it('🔴 「3 対応できない」は次の手へ進める（止めない）', async () => {
    await choice(pressed('3'));
    expect(initiate).toHaveBeenCalledTimes(1);
    const command = initiate.mock.calls[0]?.[0] as { endpoint: { id: string } };
    expect(command.endpoint.id).toBe('seed-ep-acting');
  });

  it('担当者へは必ず音声で応答する（承諾の保存に失敗しても）', async () => {
    const res = await choice(pressed('2'));
    expect(res.status).toBe(200);
    const ncco = (await res.json()) as { action: string; text: string }[];
    expect(ncco[0]?.action).toBe('talk');
    expect(ncco[0]?.text).toContain('まもなく向かう');
  });

  it('🔴 誤入力では取次を触らない', async () => {
    await choice(pressed('9'));
    const s = await stored();
    expect(s?.voiceState).toBe('awaiting_acceptance');
    expect(s?.status).toBe('in_flight');
  });
});

/**
 * 第 2 段で「できないこと」を案内しない (#646 レビュー (b))。
 *
 * 来訪者⇔担当者の音声経路は MVP 1 の範囲外。`accept`（1）を第 2 段で受け付けると
 * `answered`＝終端成功になり、来訪者の端末には「担当者がまいりますので、そのまま
 * お待ちください」と出る ── 担当者は話せず、来訪者は「来る」と案内される。
 */
describe('第 2 段は「来訪者と話す」を案内も受付もしない (#646)', () => {
  it('🔴 1 を押しても取次を触らない（案内していない数字）', async () => {
    await choice(pressed('1'));
    const s = await stored();
    expect(s?.voiceState).toBe('awaiting_acceptance');
    expect(s?.status).toBe('in_flight');
  });

  it('🔴 1 を押したら選択肢を読み直す（黙って切らない）', async () => {
    const res = await choice(pressed('1'));
    const ncco = (await res.json()) as { text: string }[];
    expect(ncco[0]?.text).toContain('入力を確認できませんでした');
  });

  it('🔴 案内文に「来訪者と話す」が出ない', async () => {
    const res = await choice(pressed('9'));
    const ncco = (await res.json()) as { text: string }[];
    expect(ncco[0]?.text).not.toContain('来訪者と話す');
    // 残る選択は案内し続ける（消しすぎない）。
    expect(ncco[0]?.text).toContain('まもなく向かう');
    expect(ncco[0]?.text).toContain('代理担当へ');
  });

  /** 🔴 第 1 段の本人確認（1）は温存する。壊すと来訪者情報が一切返らなくなる。 */
  it('🔴 第 1 段の本人確認は 1 のまま', async () => {
    const { POST: dtmf } = await import('./dtmf/route');
    const res = await dtmf(pressed('1'));
    expect(res.status).toBe(200);
    const ncco = (await res.json()) as { action: string }[];
    expect(ncco.some((a) => a.action === 'input')).toBe(true);
  });
});
