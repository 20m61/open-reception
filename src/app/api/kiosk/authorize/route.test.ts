/**
 * 受付端末 PIN 許可ルートの単体テスト。#244: pinRequired=false では authorize が公開セッションを
 * 発行しない（403）ことと、pinRequired=true 時の PIN 検証を担保する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSecuritySettings = vi.fn();
const verifyPin = vi.fn();
const issueKioskSession = vi.fn();
const reserveLayeredSafely = vi.fn();
const recordLayeredSuccess = vi.fn();
const reportAttemptBudgetExceeded = vi.fn();
const reportAttemptStoreUnavailable = vi.fn();

vi.mock('@/lib/security/security-store', () => ({
  getSecuritySettings: (...a: unknown[]) => getSecuritySettings(...a),
  verifyPin: (...a: unknown[]) => verifyPin(...a),
}));
vi.mock('@/lib/security/attempt-store', () => ({
  reserveLayeredSafely: (...a: unknown[]) => reserveLayeredSafely(...a),
  recordLayeredSuccess: (...a: unknown[]) => recordLayeredSuccess(...a),
}));
vi.mock('@/lib/security/attempt-report', () => ({
  reportAttemptBudgetExceeded: (...a: unknown[]) => reportAttemptBudgetExceeded(...a),
  reportAttemptStoreUnavailable: (...a: unknown[]) => reportAttemptStoreUnavailable(...a),
}));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  KIOSK_SESSION_TTL_MS: 1000,
  issueKioskSession: (...a: unknown[]) => issueKioskSession(...a),
}));

import { POST } from './route';

function post(body: unknown = { pin: '0000', kioskId: 'kiosk-dev' }) {
  return POST(
    new Request('http://localhost/api/kiosk/authorize', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSecuritySettings.mockResolvedValue({ pinRequired: true, pin: '0000', ipAllowlist: [] });
  verifyPin.mockResolvedValue(true);
  issueKioskSession.mockResolvedValue('signed-kiosk-session');
  reserveLayeredSafely.mockResolvedValue({
    allowed: true,
    nextWindow: { startedAt: 0, failures: 0 },
  });
  // 🔴 既定は「記録が成功する」。`vi.clearAllMocks()` が戻り値も消すので、
  //    ここで置き直さないと `undefined` が返り、通常経路でも
  //    「記録に失敗した」と読まれる（下界のテストがこの取りこぼしを捕まえた）。
  recordLayeredSuccess.mockResolvedValue(true);
});

describe('POST /api/kiosk/authorize (#244)', () => {
  it('pinRequired=false では 403（公開セッションを発行しない・ゲート回避防止）', async () => {
    getSecuritySettings.mockResolvedValue({ pinRequired: false, pin: '0000', ipAllowlist: [] });
    const res = await post();
    expect(res.status).toBe(403);
    expect(issueKioskSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('pinRequired=true かつ PIN 一致でセッションを発行し Set-Cookie', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(issueKioskSession).toHaveBeenCalledTimes(1);
    expect(res.headers.get('set-cookie')).toContain('kiosk_session=');
  });

  it('pinRequired=true でも PIN 不一致は 401', async () => {
    verifyPin.mockResolvedValue(false);
    const res = await post({ pin: 'wrong' });
    expect(res.status).toBe(401);
    expect(issueKioskSession).not.toHaveBeenCalled();
  });

  it('IP allowlist 設定済みでも pinRequired=false は 403（IP 単独では認可しない・詐称対策, #244）', async () => {
    // x-forwarded-for は client 詐称可能なため、IP allowlist 単独ではセッションを発行しない。
    getSecuritySettings.mockResolvedValue({ pinRequired: false, pin: '0000', ipAllowlist: ['1.2.3.4'] });
    const res = await POST(
      new Request('http://localhost/api/kiosk/authorize', {
        method: 'POST',
        headers: { 'x-forwarded-for': '1.2.3.4' },
        body: JSON.stringify({ kioskId: 'kiosk-dev' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(issueKioskSession).not.toHaveBeenCalled();
  });
});

/**
 * 試行回数制限 (#1021 AC4)。
 *
 * ## 何を守るか
 *
 * この route は**未認証の公開経路**で、PIN は事実上 4 桁＝10^4 しかない。通れば
 * **30 日の kiosk セッション**が出る（以降 #1020 の面が全部開く）。
 *
 * 🔴 **鍵はサイト全体（global）である。** `kioskId` は**リクエスト body 由来**で、
 * `x-forwarded-for` は詐称可能（この route 自身が IP allowlist についてそう書いている）。
 * どちらで鍵を切っても**回せば素通り**するので、予算にならない。PIN がサイト共通である以上、
 * 数える側もサイト共通にしかできない。
 *
 * ## 代償（正直に書く）
 *
 * global なので、攻撃者は**安価に PIN 認可の経路を閉じられる**。これは
 * この endpoint に rate limit を掛ける限り**避けられない**（鍵を変えても同じ）。
 * 被害を限るのは次の 2 つで、機構ではなく事実である:
 *
 * - **既に許可済みの端末は影響を受けない**（kiosk セッションは 30 日 cookie なので、
 *   稼働中の受付端末は攻撃中も動き続ける）。閉じるのは**初回の PIN 認可だけ**
 * - 窓は短く取り、攻撃が止まれば**自然に開く**
 */
describe('試行回数制限 (#1021 AC4)', () => {
  it('🔴 予算超過なら 429 と Retry-After を返す', async () => {
    reserveLayeredSafely.mockResolvedValue({ allowed: false, retryAfterMs: 42_000 });
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(issueKioskSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  /**
   * 🔴 **本体。** 予算超過の試行は**照合を走らせない**。
   *
   * AC3 で PIN 照合は PBKDF2（実測 約 5ms/回）になったので、走らせると
   * 叩くだけで Lambda の GB-ms と同時実行を消費させられる。断るついでに
   * **コストを下げる**のがこの配線の要点である（増幅を閉じる側に使う）。
   */
  it('🔴 予算超過なら PIN 照合を走らせない（計算増幅を閉じる）', async () => {
    reserveLayeredSafely.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    await post();
    expect(verifyPin).not.toHaveBeenCalled();
  });

  /** 🔴 下界: 予算内なら従来どおり照合する（全部 429 にして満たしていない）。 */
  it('🔴 予算内なら照合して通す（下界）', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(verifyPin).toHaveBeenCalledTimes(1);
  });

  it('🔴 PIN 不一致は失敗として数える', async () => {
    verifyPin.mockResolvedValue(false);
    const res = await post({ pin: 'wrong' });
    expect(res.status).toBe(401);
    // 🔴 予約の時点で数えているので、ここで数え直さない（二重計上になる）。
    expect(reserveLayeredSafely).toHaveBeenCalledTimes(1);
    expect(recordLayeredSuccess).not.toHaveBeenCalled();
  });

  /** 🔴 成功は失敗数を捨てる（正しく入った直後に予算切れで断られる形を作らない）。 */
  it('🔴 成功したら失敗数をリセットする', async () => {
    await post();
    expect(recordLayeredSuccess).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **PIN 認可が無効なサイトでは数えない。** `pinRequired=false` の 403 は
   * PIN の試行ではないので、数えると**攻撃でもないもので予算を使い切る**
   * （その端末は enroll 経路を使うのが正しい）。
   */
  it('🔴 pinRequired=false の 403 は数えない', async () => {
    getSecuritySettings.mockResolvedValue({ pinRequired: false, pin: '0000', ipAllowlist: [] });
    await post();
    expect(reserveLayeredSafely).not.toHaveBeenCalled();
  });

  /** 🔴 鍵は body の kioskId に依らない（回しても同じ窓を使う＝素通りさせない）。 */
  it('🔴 kioskId を変えても同じ鍵で数える', async () => {
    await post({ pin: '0000', kioskId: 'kiosk-a' });
    await post({ pin: '0000', kioskId: 'kiosk-b' });
    const keys = reserveLayeredSafely.mock.calls.map((c) => c[0]);
    expect(keys[0]).toBe(keys[1]);
  });

  /** 🔴 応答に PIN の値を出さない（未認証経路。`rules/pii-secret-minimization.md`）。 */
  it('🔴 429 の応答本文に入力値を出さない', async () => {
    reserveLayeredSafely.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await post({ pin: '1234', kioskId: 'kiosk-dev' });
    const text = await res.text();
    expect(text).not.toContain('1234');
  });
});

/**
 * ストア障害時の倒れ方（#1021 AC4 / レビュー M2）。
 *
 * 🔴 **この増分は「帳簿」を受付完遂の経路に足した。** その帳簿が落ちたときに
 * どう倒れるかを**明示的に選んでテストで固定する** —— 選ばないと未捕捉 500 になり、
 * 「正しい PIN を入れた来訪者が、DynamoDB の一時障害だけで受付を開始できない」が起きる
 * （実測でそうなっていた）。
 */
describe('帳簿が落ちたとき (#1021 AC4)', () => {
  /** 🔴 判定できないときは fail-closed（落とせば制限が消える状態を作らない）。 */
  it('🔴 予約できないときは 503（未捕捉 500 にしない）', async () => {
    reserveLayeredSafely.mockResolvedValue('unavailable');
    const res = await post();
    expect(res.status).toBe(503);
    expect(verifyPin).not.toHaveBeenCalled();
    expect(issueKioskSession).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **本体（M2）。成功の記録に失敗しても、セッションは発行する。**
   *
   * 捨て損なっても予算は窓明けで自然に戻るので、ここで止める理由が無い。止めると
   * **正しい PIN を入れた来訪者が受付を開始できない**（帳簿の書き込み失敗だけで）。
   */
  it('🔴 成功の記録に失敗してもセッションを発行する', async () => {
    recordLayeredSuccess.mockResolvedValue(false);
    const res = await post();
    expect(res.status).toBe(200);
    expect(issueKioskSession).toHaveBeenCalledTimes(1);
    expect(res.headers.get('set-cookie')).toContain('kiosk_session=');
  });

  /** 🔴 下界: 記録が成功する通常経路でも当然発行する（上を空虚に満たさない）。 */
  it('🔴 記録が成功する通常経路でも発行する（下界）', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(issueKioskSession).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **予算の鍵は発信元ごと（レビュー B1）。** XFF の**末尾**で鍵が決まるので、
   * 攻撃者が先頭へ何を詰めても他人の予算を消費できない。
   */
  it('🔴 鍵は XFF の末尾から決まる（先頭の詐称に引きずられない）', async () => {
    await POST(
      new Request('http://localhost/api/kiosk/authorize', {
        method: 'POST',
        headers: { 'x-forwarded-for': '1.1.1.1, 192.0.2.1' },
        body: JSON.stringify({ pin: '0000' }),
      }),
    );
    expect(reserveLayeredSafely.mock.calls[0]?.[0]).toBe('ip:192.0.2.1');
  });
});

/**
 * 検出信号の配線（#1021 AC4 / レビュー M4。変異検証で生存した穴）。
 *
 * 信号を足しても**呼んでいることを縛らないと**、次に触った人が外しても誰も気づかない。
 */
describe('検出信号の配線 (#1021 AC4)', () => {
  it('🔴 予算超過を記録する', async () => {
    reserveLayeredSafely.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    await post();
    expect(reportAttemptBudgetExceeded).toHaveBeenCalledTimes(1);
  });

  it('🔴 帳簿が読めないことを記録する', async () => {
    reserveLayeredSafely.mockResolvedValue('unavailable');
    await post();
    expect(reportAttemptStoreUnavailable).toHaveBeenCalledTimes(1);
  });

  /** 🔴 成功の記録に失敗したことも記録する（沈黙で飲まない）。 */
  it('🔴 成功の記録に失敗したことを記録する', async () => {
    recordLayeredSuccess.mockResolvedValue(false);
    await post();
    expect(reportAttemptStoreUnavailable).toHaveBeenCalledTimes(1);
  });

  /** 🔴 下界: 通常経路では何も記録しない（常に記録して満たしていない）。 */
  it('🔴 通常経路では記録しない（下界）', async () => {
    await post();
    expect(reportAttemptBudgetExceeded).not.toHaveBeenCalled();
    expect(reportAttemptStoreUnavailable).not.toHaveBeenCalled();
  });
});
