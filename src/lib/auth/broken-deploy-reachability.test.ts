/**
 * 🔴 **秘密を入れ忘れたデプロイで、未認証の攻撃者が到達できる面の表** (#1021)。
 *
 * ## なぜ鍵ごとではなく「面」ごとに見るのか
 *
 * #1021 増分 1 は `ADMIN_PASSWORD` を fail-closed 化し、「入れ忘れたデプロイで
 * `tenant_admin` が取れる」という脅威を**閉じたと書いた**。実際に閉じたのは
 * **扉が 1 枚**だけで、同じデプロイでは `ADMIN_SESSION_SECRET` も未設定なのが普通、
 * `getAdminSecret()` は warn-only、したがって**公開既定値で署名した cookie が通る**。
 * 攻撃者はログイン API を叩く必要すらなかった。
 *
 * 鍵ごとに分かれたテストでは、この型は**原理的に検出できない** —— どの鍵のテストも
 * 自分の扉については正しいからである。ここでは鍵ではなく、
 * **「壊れたデプロイに未認証で触れる面」を 1 枚の表**にして、観測される結果を固定する。
 *
 * 🔴 **この表は「望ましい状態」ではなく「現状」を固定している。** 開いている行は
 * issue を持っており、閉じたときにこのテストが**赤くなるのが正しい**（行を反転させるのが
 * その issue の完了条件になる）。散文の「まだ閉じていない」を、実行可能な形にしたもの。
 *
 * 🔴 **この表は面の網羅ではない。** 行は手で書いたものであり、**「全部の行が閉じた」は
 * 「どの扉からも入れない」を意味しない**。実際、最初に書いたときは `KIOSK_SESSION_SECRET`
 * の面が抜けていた（`brokenDeploy()` がその鍵を unset して舞台を作っていながら、
 * 何も主張していなかった）—— **#1021 の**レビュー 6 周目の指摘。
 *
 * 行の導出規則は「**`serverSecret(` の呼び出し元のうち、未認証で到達できる面を持つもの**」。
 * failClosed かどうかでは分けない —— failClosed でない鍵は「偽造が通る」面を、failClosed な鍵は
 * 「未認証で 500 を生ませられる」面を持ち、**どちらもこの表の対象**である。
 *
 * 🔴 **最初はこの規則を「failClosed でないもの」と書いていて、表と食い違っていた**
 * （staff answer の行は failClosed 側）。規則から表が導けないなら、それは規則ではない。
 *
 * 🔴 **規則から導けてまだ載っていない面**: `POST /api/kiosk/voice-transport/token`
 * （`VOICE_TRANSPORT_TOKEN_SECRET` が failClosed）。kiosk セッションを要求するが、
 * **この表が下で認めているとおり公開既定値でセッションを鋳造できる**ので未認証で到達しうる。
 * 既に 503 へ写像済み（`route.ts` の inline try/catch）なので実害は無いが、**規則から
 * 導ける行が欠けている**＝この表の網羅性の主張がその分だけ弱い。
 *
 * failClosed の呼び出し元は実測 **5 件**（`answer-token` / `kiosk-enrollment` /
 * `voice-transport/token` / `admin`(ADMIN_PASSWORD) / `platform/elevation`）。
 * このうち `elevation` は platform 認証済み経路のみなので、この表の対象外。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signSession } from '@/lib/auth/session';
import { readKioskSession } from '@/lib/auth/kiosk';
import { POST as staffAnswer } from '@/app/api/staff/calls/[id]/answer/route';
import { GET as staffRespond, POST as staffRespondPost } from '@/app/api/staff/calls/[id]/respond/route';
import { POST as kioskEnroll } from '@/app/api/kiosk/enroll/route';
import { __resetSecretUnavailableLog } from '@/lib/auth/secret-unavailable';
import { POST as adminLogin } from '@/app/api/admin/login/route';
import { proxy } from '@/proxy';

/** 公開リポジトリに平文で載っている dev フォールバック。攻撃者はこれを知っている。 */
const PUBLIC_ADMIN_SESSION_SECRET = 'dev-insecure-admin-secret';
const PUBLIC_ADMIN_PASSWORD = 'open-reception';
const PUBLIC_KIOSK_SESSION_SECRET = 'dev-insecure-kiosk-secret';

/** 秘密を 1 つも入れずに Lambda へ配ったデプロイ。 */
function brokenDeploy(): void {
  vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'open-reception-server');
  for (const name of [
    'ADMIN_PASSWORD',
    'ADMIN_SESSION_SECRET',
    'KIOSK_SESSION_SECRET',
    'CALL_ANSWER_SECRET',
    // 🔴 enroll の行の前提。舞台を作らずに「環境に元から無いこと」へ寄りかからない
    // （この表が **#1021 の** 6 周目に「舞台を作りながら何も主張していない」と指摘された裏返し）。
    'KIOSK_ENROLLMENT_SECRET',
    'ADMIN_AUTH_PROVIDER',
  ]) {
    vi.stubEnv(name, undefined);
  }
}

/**
 * 🔴 **トークンの形を可変にする（#1123 AC1 の後半「**内容・有無に関わらず揃う**」）。**
 *
 * これは飾りの網羅ではない。#1021 は「403/500 の差を塞ぐ」として `readAnswerToken` の先頭に
 * 「トークンが無ければ早期 return」を入れ、**トークンを 1 文字付ければ素通りする**ので撤回した。
 * #1123 の issue 本文はその機構を名指しして「**同じ半端を繰り返さない**」と書いている。
 *
 * ところが固定の `'some.token'` しか踏んでいないと、鍵 guard の**直前**に同じ早期 return を
 * 挿し戻す変異が**全部素通りする** —— **#1123 の**レビュー 5 周目の実測で、3 route へ同時に挿しても
 * unit 8768 本が全部緑のままだった。**散文が名指しした反パターンを、機械が見張っていなかった。**
 */
type MaybeToken = string | undefined;

/** `undefined` はキー自体を載せない（型で弾かれる経路と、鍵で落ちる経路を取り違えないため）。 */
const jsonBody = (token: MaybeToken, extra: Record<string, unknown> = {}): string =>
  JSON.stringify(token === undefined ? extra : { token, ...extra });

const answerRequest = (token: MaybeToken = 'some.token'): Request =>
  new Request('https://example.test/api/staff/calls/rec-1/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody(token),
  });

const enrollRequest = (token: MaybeToken = 'some.token'): Request =>
  new Request('https://example.test/api/kiosk/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody(token),
  });

const respondGetRequest = (token: MaybeToken = 'a'): Request =>
  new Request(
    token === undefined
      ? 'https://example.test/api/staff/calls/rec-1/respond'
      : `https://example.test/api/staff/calls/rec-1/respond?token=${encodeURIComponent(token)}`,
  );

const respondPostRequest = (token: MaybeToken = 'some.token'): Request =>
  new Request('https://example.test/api/staff/calls/rec-1/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody(token, { action: 'coming' }),
  });

const ctx = () => ({ params: Promise.resolve({ id: 'rec-1' }) });

/**
 * 未認証で到達する **4 入口**（commit 本文が名指ししているのと同じ 4 つ）。
 *
 * 🔴 **表にして 1 度だけ書く。** 4 入口 × 2 主張（503 / 下界）を手で 8 本書いていたときは、
 * `respond` GET の下界だけが**抜けていた**（**#1123 の**レビュー 5 周目）。数え上げをやめれば、
 * 入口を足したときに主張の側を書き忘れることが原理的に起きない。
 */
const UNAUTHENTICATED_ENTRIES: ReadonlyArray<{
  name: string;
  /** 鍵が在るときの応答。壊れたデプロイの 503 との差がそのままオラクル（#1127）。 */
  env: string;
  value: string;
  withKey: number;
  call: (token: MaybeToken) => Promise<Response>;
}> = [
  {
    name: 'POST /api/staff/calls/:id/answer',
    env: 'CALL_ANSWER_SECRET',
    value: 'TEST-answer-secret',
    withKey: 403,
    call: (t) => staffAnswer(answerRequest(t), ctx()),
  },
  {
    name: 'GET /api/staff/calls/:id/respond',
    env: 'CALL_ANSWER_SECRET',
    value: 'TEST-answer-secret',
    withKey: 403,
    call: (t) => staffRespond(respondGetRequest(t), ctx()),
  },
  {
    name: 'POST /api/staff/calls/:id/respond',
    env: 'CALL_ANSWER_SECRET',
    value: 'TEST-answer-secret',
    withKey: 403,
    call: (t) => staffRespondPost(respondPostRequest(t), ctx()),
  },
  {
    name: 'POST /api/kiosk/enroll',
    env: 'KIOSK_ENROLLMENT_SECRET',
    value: 'TEST-enrollment-secret',
    withKey: 400,
    call: (t) => kioskEnroll(enrollRequest(t)),
  },
];

const TOKEN_SHAPES: ReadonlyArray<[label: string, token: MaybeToken]> = [
  ['キー自体が無い', undefined],
  ['空文字', ''],
  ['でっち上げ', 'some.token'],
];

beforeEach(() => {
  brokenDeploy();
  __resetSecretUnavailableLog();
});
afterEach(() => {
  vi.unstubAllEnvs();
  __resetSecretUnavailableLog();
});

describe('秘密を入れ忘れたデプロイの攻撃面 (#1021)', () => {
  /** ✅ 閉じた面（AC1）。 */
  it('✅ 管理ログイン: 公開既定値では入れず、セッションも出ない', async () => {
    const res = await adminLogin(
      new Request('https://example.test/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PUBLIC_ADMIN_PASSWORD }),
      }),
    );
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('admin_session='))).toBe(false);
  });

  /**
   * 🔴 **開いている面（#1124）。** 管理**セッション**の鍵は warn-only のままなので、
   * 公開既定値で署名した cookie が middleware を通過する。ログイン API を塞いでも、
   * 隣の窓が開いている。**これが閉じたら、この it は赤くなる**（そのときに反転させる）。
   */
  it('🔴 管理セッション: 公開既定値で署名した cookie が middleware を通過する（未解決 #1124）', async () => {
    const forged = await signSession(
      { role: 'admin', exp: Date.now() + 3600_000 },
      PUBLIC_ADMIN_SESSION_SECRET,
    );
    const req = new NextRequest('http://127.0.0.1:3000/api/admin/receptions');
    req.cookies.set('admin_session', forged);
    const res = await proxy(req);

    // 🔴 「401 でない」ではなく**通過そのもの**を見る（403 / redirect へ倒す変異に
    // slack を残さない）。middleware の pass-through は 200 ＋ x-middleware-next: 1。
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  /**
   * 🔴 **下界。** 上が「何を付けても 401 にならない」だけなら空虚。
   * 出鱈目な署名は確かに 401 になることまで見る（＝検証自体は生きている）。
   */
  it('管理セッション: 署名が違う cookie は 401（検証自体は生きている）', async () => {
    const wrong = await signSession({ role: 'admin', exp: Date.now() + 3600_000 }, 'not-the-key');
    const req = new NextRequest('http://127.0.0.1:3000/api/admin/receptions');
    req.cookies.set('admin_session', wrong);
    expect((await proxy(req)).status).toBe(401);
  });

  /**
   * 🔴 **開いている面（#1124）。** 受付端末**セッション**の鍵も warn-only なので、
   * 公開既定値で署名した cookie が `readKioskSession` を通る。`KIOSK_ENROLLMENT_SECRET`
   * を failClosed にした意味が、ここで迂回される —— **enroll ゲートを通らずに
   * セッションを鋳造できる**。到達先は `/api/kiosk/*`（flow / config / receptions /
   * heartbeat / voice）で、来訪者導線の作成と音声系（AWS 費用）まで開く。
   */
  it('🔴 受付端末セッション: 公開既定値で署名した cookie が通る（未解決 #1124）', async () => {
    const forged = await signSession(
      { role: 'kiosk', kioskId: 'attacker-kiosk', exp: Date.now() + 3600_000 },
      PUBLIC_KIOSK_SESSION_SECRET,
    );
    await expect(readKioskSession(forged)).resolves.toEqual({ kioskId: 'attacker-kiosk' });
  });

  /** 下界。署名が違えば通らない（検証自体は生きている）。 */
  it('受付端末セッション: 署名が違う cookie は通らない', async () => {
    const wrong = await signSession(
      { role: 'kiosk', kioskId: 'attacker-kiosk', exp: Date.now() + 3600_000 },
      'not-the-key',
    );
    await expect(readKioskSession(wrong)).resolves.toBeNull();
  });

  /**
   * ✅ **部分的に閉じた面（#1123）。** 担当者応答と受付端末エンロールは、鍵未設定でも
   * **uncaught 例外を出さず 503** を返すようになった。未認証でスタックトレースを量産させられる
   * 状態は解消した。
   *
   * 🔴 **route handler を呼ぶ。** `readAnswerToken` を直に呼ぶと、route 層の修正で**この行が
   * 緑のまま**になり、「閉じたら赤くなる」という契約を満たさない。実際 `respond` POST は
   * route 単体テスト（`readAnswerToken` を mock する＝**mock は throw しないので順序を
   * 観測できない**）しか持っておらず、guard を `readAnswerToken` の後ろへ動かす変異が
   * **unit 114 本を素通り**した（**#1123 の**レビュー 4 周目の実測）。
   *
   * 🔴 **`GET /api/staff/calls/x/respond?token=a` は commit 本文が名指しした攻撃形そのもの。**
   * 投げるだけで到達する（発行済みリンクも認証も要らない）。
   */
  for (const entry of UNAUTHENTICATED_ENTRIES) {
    for (const [label, token] of TOKEN_SHAPES) {
      it(`✅ ${entry.name}: token が${label}でも uncaught にならず 503（#1123 AC1）`, async () => {
        expect((await entry.call(token)).status).toBe(503);
      });
    }
  }

  /**
   * 🔴 **残っているオラクルを、残っているまま固定する。**
   *
   * 鍵が**在る**デプロイでは同じ呼び出しが 403（enroll は 400）。壊れたデプロイの 503 との差が
   * そのまま「この環境は鍵を持っていない」を教える。**#1127 が揃えたらこの行が赤くなる**のが正しい。
   *
   * この一群は**下界も兼ねる** —— 上の主張は**何を渡しても 503** の世界でも満たせてしまう。
   */
  for (const entry of UNAUTHENTICATED_ENTRIES) {
    it(`🔴 ${entry.name}: 鍵が在れば ${entry.withKey} で、503 と区別できる（未解決 #1127）`, async () => {
      vi.stubEnv(entry.env, entry.value);
      expect((await entry.call('some.token')).status).toBe(entry.withKey);
    });
  }
});
