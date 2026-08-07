import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SIGNATURE_SECRET = 'TEST-signature-secret';
const PROVIDER_CALL_ID = 'TEST-vonage-uuid-1';

vi.mock('@/lib/call/vonage-signature', () => ({
  resolveVonageSignatureSecret: async () => SIGNATURE_SECRET,
}));

import { getCallCorrelationRepository, __resetCallCorrelationRepository } from '@/lib/routing/call-correlation';
import { POST as answer } from './answer/route';
import { POST as choice } from './choice/route';
import { POST as dtmf } from './dtmf/route';
import { POST as events } from './events/route';

const ROUTES = [
  ['answer', answer],
  ['events', events],
  ['dtmf', dtmf],
  ['choice', choice],
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

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

  // 🔴 **route を跨いで比較する。** 1 route 内の 3 理由しか比べていなかったので、
  // 「/answer だけ本文を変える」「ヘッダで通話 ID の存在を漏らす」変異が素通りしていた。
  it('4 本すべての拒否応答が本文・status・ヘッダまで完全に同一', async () => {
    const responses = await Promise.all(
      ROUTES.map(([, handler]) => handler(signed(body({ uuid: 'TEST-unknown' })))),
    );
    const shapes = await Promise.all(
      responses.map(async (r) => ({
        status: r.status,
        body: await r.text(),
        headers: [...r.headers].sort(),
      })),
    );
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
  });

  // 🔴 理由ごとに応答が違うと、通話 ID の総当たりで在庫と鍵の有無が分かる。
  // **ヘッダまで比べる。** 本文と status だけだと「ヘッダで通話 ID の存在を漏らす」変異が
  // 素通りする（実際に素通りした）。
  it.each(ROUTES)('%s の拒否応答は理由によらず同一（本文・status・ヘッダ）', async (_name, handler) => {
    const shape = async (res: Response) => ({
      status: res.status,
      body: await res.text(),
      headers: [...res.headers].sort(),
    });
    const shapes = await Promise.all([
      handler(new Request('https://reception.test/x', { method: 'POST', body: body() })).then(shape),
      handler(signed(body(), 'TEST-wrong-secret')).then(shape),
      handler(signed(body({ uuid: 'TEST-unknown' }))).then(shape),
      // 既知の通話 ID × 正しい署名でも、本文が壊れていれば拒否される経路。
      handler(signed('not-json')).then(shape),
    ]);
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
  });

  // 拒否応答が持ってよいヘッダを**許可リスト**で固定する。
  // 「全 route に同じ余計なヘッダを足す」変異は横断比較では捕まらない。
  it.each(ROUTES)('%s の拒否応答は Content-Type 以外のヘッダを持たない', async (_name, handler) => {
    const res = await handler(signed(body({ uuid: 'TEST-unknown' })));
    expect([...res.headers.keys()].sort()).toEqual(['content-type']);
  });
});

describe('/answer — 第 1 段しか返さない (#4)', () => {
  it('検証を通ると NCCO を返す', async () => {
    const res = await answer(signed(body()));
    expect(res.status).toBe(200);
    const ncco = (await res.json()) as unknown[];
    expect(ncco.some((a) => (a as { action?: string }).action === 'input')).toBe(true);
  });

  // 🔴 **許可リストで固定する。** 禁止語の羅列だと、別表現（「TEST-商事の TEST-来訪者さんが
  // 受付でお待ちです」等）で来訪者情報を載せる変異がすり抜ける。実際にすり抜けた。
  it('第 1 段の読み上げは既知の定型文だけ（来訪者情報を載せる余地を残さない）', async () => {
    const res = await answer(signed(body()));
    const ncco = (await res.json()) as { action: string; text?: string }[];
    const spoken = ncco.filter((a) => a.action === 'talk').map((a) => a.text);
    expect(spoken).toEqual(['受付からのお電話です。ご対応いただける場合は、1 を押してください。']);
  });
});

describe('/dtmf — 本人確認の後だけ詳細を返す (#4)', () => {
  it('1（応答する）なら第 2 段の NCCO を返す', async () => {
    const res = await dtmf(signed(body({ dtmf: { digits: '1' } })));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('様がお越し');
  });

  it.each(['', '9', '#'])('未定義の入力 %s では詳細を返さない', async (digits) => {
    const res = await dtmf(signed(body({ dtmf: { digits } })));
    expect(res.status).toBe(204);
  });

  // 🔴 **定義済みだが accept でない入力**（2/3/4）が 1 件も無かった。
  // ガードを `choice === undefined` に緩める変異が素通りしていた ── 留守番電話や
  // 第三者が 3 を押すと来訪者情報が読み上げられる、#4 の最重要要件そのものの穴。
  it.each(['2', '3', '4'])('第 1 段で %s を押しても来訪者情報を返さない', async (digits) => {
    const res = await dtmf(signed(body({ dtmf: { digits } })));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
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


describe('/choice — 第 2 段の意思表示 (#4)', () => {
  // 🔴 第 2 段の eventUrl を /dtmf に戻すと、「1」が本人確認として再解釈され
  // 来訪者情報を無限に読み上げる（実際にそうなっていた）。段はエンドポイントで持つ。
  it('第 2 段の案内は /choice を指す（/dtmf へ戻さない）', async () => {
    const res = await dtmf(signed(body({ dtmf: { digits: '1' } })));
    const ncco = JSON.stringify(await res.json());
    expect(ncco).toContain('/api/providers/vonage/choice');
    expect(ncco).not.toContain('/api/providers/vonage/dtmf');
  });

  it.each(['1', '2', '3', '4'])('どの選択 %s でも必ず音声で応答する', async (digits) => {
    const res = await choice(signed(body({ dtmf: { digits } })));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('talk');
  });

  it('誤入力でも黙って切らず選択肢を読み直す', async () => {
    const res = await choice(signed(body({ dtmf: { digits: '9' } })));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('確認できませんでした');
  });

  it('第 2 段の応答に来訪者情報を含めない（受領のみ）', async () => {
    const res = await choice(signed(body({ dtmf: { digits: '2' } })));
    expect(JSON.stringify(await res.json())).not.toContain('様がお越し');
  });
});

describe('拒否は一様だが、理由はログに残る (#4)', () => {
  // 🔴 一様な 403 の対価がこれ。無いと「担当者の電話が鳴らない」通報に対して
  // どの段で落ちたのかを判定する手段が一切なくなる。
  it.each(ROUTES)('%s は拒否理由を構造化ログへ出す', async (_name, handler) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handler(signed(body({ uuid: 'TEST-unknown' })));
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged).toMatchObject({ event: 'vonage_webhook_rejected', reason: 'unknown_call' });
  });

  it('ログにシークレット・本文・トークンを含めない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await dtmf(signed(body({ uuid: 'TEST-unknown' }), 'TEST-wrong-secret'));
    const logged = JSON.stringify(warn.mock.calls);
    for (const forbidden of ['TEST-wrong-secret', SIGNATURE_SECRET]) {
      expect(logged).not.toContain(forbidden);
    }
  });
});

describe('/events — 取次の進行を実際に保存する (#4 Inc D-2)', () => {
  async function stored() {
    const found = await getCallCorrelationRepository().get(PROVIDER_CALL_ID);
    if (found === undefined) throw new Error('correlation missing');
    return found;
  }

  it('通話状態を保存する（毎回 queued から畳み直さない）', async () => {
    // 🔴 Inc D-1 の /events は applyVoiceEvent('queued', …) を毎回畳んで void で捨てて
    // いた。保存されなければ次のイベントも 'queued' から畳まれ、巻き戻し保護が消える。
    await events(signed(body({ status: 'ringing' })));
    expect((await stored()).voiceState).toBe('ringing');
  });

  it('結果が未確定のうちは in_flight のまま（確定扱いにしない）', async () => {
    await events(signed(body({ status: 'ringing' })));
    expect((await stored()).status).toBe('in_flight');
  });

  it('取次結果が確定したら settled にする', async () => {
    // busy は取次語彙で確定。保存済みポリシー（p1）が無いので次の手も無く、確定で終わる。
    await events(signed(body({ status: 'busy' })));
    const s = await stored();
    expect(s.status).toBe('settled');
    expect(s.voiceState).toBe('busy');
  });

  it('確定後に遅れて届いたイベントで状態を書き換えない', async () => {
    // 担当者が向かっているのに、遅延イベントで取次が再開して部門代表まで鳴る事故を防ぐ。
    await getCallCorrelationRepository().put({
      providerCallId: PROVIDER_CALL_ID,
      receptionId: 'TEST-reception-1',
      tenantId: 'internal',
      siteId: 'default-site',
      position: { callUuid: 'TEST-call-1', policyId: 'p1', stepId: 's1', hops: 0, ledger: [] },
      voiceState: 'staff_coming',
      status: 'settled',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await events(signed(body({ status: 'completed' })));
    const s = await stored();
    expect(s.voiceState).toBe('staff_coming');
    expect(s.status).toBe('settled');
  });

  it('未知のステータスでは何も書き換えない', async () => {
    await events(signed(body({ status: 'TEST-unknown-status' })));
    const s = await stored();
    expect(s.voiceState).toBeUndefined();
    expect(s.status).toBe('in_flight');
  });
});

describe('/events — 発信できない間は位置を動かさない (#4 Inc D-2 項目 2 待ち)', () => {
  /**
   * 🔴 次の手を撃つべきと判断されても、provider 選択（実送信の停止境界）が未配線なので
   * **発信していない**。にもかかわらず位置を進めると「撃ったことになっている手が
   * 実際には鳴っていない」不整合になり、担当者を飛ばして取次が終わる。
   *
   * seed 取次（personal → acting → department）の先頭に居る相関を作り、
   * 未応答で「次は acting」と判断される状況を踏ませる。
   */
  const SEED_POLICY = 'seed-personal-acting-department';

  beforeEach(async () => {
    await getCallCorrelationRepository().put({
      providerCallId: PROVIDER_CALL_ID,
      receptionId: 'TEST-reception-1',
      tenantId: 'internal',
      siteId: 'default-site',
      position: { callUuid: 'TEST-call-1', policyId: SEED_POLICY, stepId: 'personal', hops: 0, ledger: [] },
      status: 'in_flight',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('次の手があっても位置を進めない（発信していないため）', async () => {
    await events(signed(body({ status: 'unanswered' })));
    const s = await getCallCorrelationRepository().get(PROVIDER_CALL_ID);
    expect(s?.position.stepId).toBe('personal');
    expect(s?.position.hops).toBe(0);
  });

  it('通話状態は記録し、確定扱いにはしない', async () => {
    await events(signed(body({ status: 'unanswered' })));
    const s = await getCallCorrelationRepository().get(PROVIDER_CALL_ID);
    expect(s?.voiceState).toBe('no_answer');
    expect(s?.status).toBe('in_flight');
  });

  it('保留であることを構造化ログで可観測にする（黙って止まらない）', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await events(signed(body({ status: 'unanswered' })));
    const logged = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('vonage_routing_dial_pending');
    expect(logged).toContain('acting');
  });
});
