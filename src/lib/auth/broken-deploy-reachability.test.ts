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
 * 何も主張していなかった）—— レビュー 6 周目の指摘。
 *
 * 行の導出規則は「**`serverSecret(` の呼び出し元のうち、未認証で到達できる面を持つもの**」。
 * failClosed かどうかでは分けない —— failClosed でない鍵は「偽造が通る」面を、failClosed な鍵は
 * 「未認証で 500 を生ませられる」面を持ち、**どちらもこの表の対象**である。
 *
 * 🔴 **最初はこの規則を「failClosed でないもの」と書いていて、表と食い違っていた**
 * （staff answer の行は failClosed 側）。規則から表が導けないなら、それは規則ではない。
 *
 * 規則から導けて**まだ載っていない**面: `POST /api/kiosk/enroll`（未認証 ×
 * `getEnrollmentSecret()` が failClosed × route に try/catch 無し）。staff の行と同型なので、
 * #1123 が両方を同じ契約で閉じる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signSession } from '@/lib/auth/session';
import { readKioskSession } from '@/lib/auth/kiosk';
import { POST as staffAnswer } from '@/app/api/staff/calls/[id]/answer/route';
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
    'ADMIN_AUTH_PROVIDER',
  ]) {
    vi.stubEnv(name, undefined);
  }
}

beforeEach(brokenDeploy);
afterEach(() => vi.unstubAllEnvs());

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
   * 🔴 **開いている面（#1123）。** 担当者応答は鍵未設定で throw し、route 層に try/catch が
   * 無いので **403 ではなく 500** になる。応答の差が「この環境は鍵を持っていない」の
   * オラクルになり、さらに担当者画面は 5xx を「リンクの有効期限切れ」と**嘘の原因**で伝える。
   *
   * 🔴 **route handler を呼ぶ。** `readAnswerToken` を直に呼ぶと、#1123 が route 層で
   * 403 へ寄せても**この行が緑のまま**になり、「閉じたら赤くなる」という契約を満たさない。
   */
  it('🔴 担当者応答: 未認証の route 呼び出しが 403 にならず throw する（未解決 #1123）', async () => {
    const call = staffAnswer(
      new Request('https://example.test/api/staff/calls/rec-1/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'some.token' }),
      }),
      { params: Promise.resolve({ id: 'rec-1' }) },
    );
    await expect(call).rejects.toThrow(/CALL_ANSWER_SECRET/);
  });

  /**
   * 🔴 **下界であり、同時にこの面の「オラクル」そのもの。**
   *
   * 鍵が**在る**デプロイでは、まったく同じ呼び出しが **403** で返る。壊れたデプロイでは
   * throw（= 500）になるので、**外から応答を 1 回見るだけで「この環境は鍵を持っていない」
   * が読める**。#1123 が閉じるべきはこの差である。
   *
   * この 1 本が無いと、上の主張は**何を渡しても throw する**世界でも満たせてしまう。
   */
  it('担当者応答: 鍵が在れば同じ呼び出しは 403（差が読めることの証拠）', async () => {
    vi.stubEnv('CALL_ANSWER_SECRET', 'TEST-answer-secret');
    const res = await staffAnswer(
      new Request('https://example.test/api/staff/calls/rec-1/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'some.token' }),
      }),
      { params: Promise.resolve({ id: 'rec-1' }) },
    );
    expect(res.status).toBe(403);
  });
});
