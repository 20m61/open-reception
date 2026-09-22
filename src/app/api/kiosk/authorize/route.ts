import { NextResponse } from 'next/server';
import { getSecuritySettings, verifyPin } from '@/lib/security/security-store';
import { isIpAllowed } from '@/domain/security/types';
import { KIOSK_COOKIE, KIOSK_SESSION_TTL_MS, issueKioskSession } from '@/lib/auth/kiosk';
import { readJson } from '@/lib/data-stores/result-http';
import { KIOSK_AUTHORIZE_POLICY } from '@/domain/security/attempt-budget';
import { checkAttempt, recordFailure, recordSuccess } from '@/lib/security/attempt-store';

/**
 * 🔴 **試行予算の鍵はサイト全体（#1021 AC4）。**
 *
 * `kioskId` は**リクエスト body 由来**で、`x-forwarded-for` は詐称可能
 * （この route 自身が IP allowlist についてそう書いている）。どちらで鍵を切っても
 * **回せば素通り**するので予算にならない。PIN がサイト共通である以上、
 * 数える側もサイト共通にしかできない。
 *
 * 代償は正直に書く: global なので攻撃者は**安価に PIN 認可の経路を閉じられる**。
 * この endpoint に rate limit を掛ける限り**避けられない**（鍵を変えても同じ）。
 * 被害を限るのは機構ではなく次の 2 つの事実である:
 *
 * - **既に許可済みの端末は影響を受けない**（kiosk セッションは 30 日 cookie なので、
 *   稼働中の受付端末は攻撃中も動き続ける）。閉じるのは**初回の PIN 認可だけ**
 * - 窓が短いので、攻撃が止まれば**自然に開く**
 */
const ATTEMPT_KEY = 'kiosk-authorize';

/**
 * POST /api/kiosk/authorize — PIN / IP による受付端末の初回許可 (issue #23)。
 * 許可後は長期 kiosk session cookie を発行し、リロード/再起動後も受付画面に復帰できる。
 *
 * PIN 必須設定時のみ有効 (issue #244)。`pinRequired=false` では PIN による自己許可を認めず 403 を返す。
 * さもないと `verifyPin` が任意 PIN で true を返し、誰でも authorize でセッションを取得できてしまい、
 * `/kiosk` セッションゲート (#239) を回避できる。IP allowlist は単独では認可根拠にしない（client 提供の
 * `x-forwarded-for` は詐称可能なため）。PIN 不要運用の端末は管理発行 URL/QR でエンロールする。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as { pin?: unknown; kioskId?: unknown } | null;
  const settings = await getSecuritySettings();
  const clientIp = (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? '';

  if (!isIpAllowed(clientIp, settings.ipAllowlist)) {
    return NextResponse.json({ error: 'forbidden', message: 'ip not allowed' }, { status: 403 });
  }
  // PIN 必須運用のときのみ有効 (issue #244)。`pinRequired=false` では authorize でセッションを発行
  // しない（403）。さもないと verifyPin が任意 PIN で true を返し、誰でも authorize でセッションを
  // 取得して /kiosk ゲート(#239)を回避できる。IP allowlist は単独では認可根拠にしない（client 提供の
  // x-forwarded-for は詐称可能なため／security review）。PIN 不要運用の端末は管理発行 URL/QR で
  // エンロールする。IP allowlist は PIN の上に重ねるアクセス制限として引き続き機能する（上の isIpAllowed）。
  if (!settings.pinRequired) {
    return NextResponse.json(
      { error: 'forbidden', message: 'pin authorization disabled; enroll via issued URL/QR' },
      { status: 403 },
    );
  }
  // 🔴 **照合の前に予算を見る（#1021 AC4）。** 予算超過の試行は `verifyPin` を
  //    **走らせない** —— AC3 で照合は PBKDF2（実測 約 5ms/回）になったので、走らせると
  //    叩くだけで Lambda の GB-ms と同時実行を消費させられる。断るついでに
  //    **コストを下げる**のがこの順序の要点である（増幅を閉じる側に使う）。
  // 🔴 数えるのは**PIN の試行だけ**。上の 403（PIN 認可が無効なサイト）は試行ではないので
  //    数えない —— 数えると攻撃でもないもので予算を使い切る。
  const budget = await checkAttempt(ATTEMPT_KEY, KIOSK_AUTHORIZE_POLICY, Date.now());
  if (!budget.allowed) {
    // 🔴 **待たせるために応答を保留しない。** Lambda では待ち時間に課金されるので、
    //    sleep は増幅を悪化させる。即座に断り、いつ再試行できるかだけ伝える。
    //    値（入力された PIN）は応答に出さない（未認証経路）。
    return NextResponse.json(
      { error: 'too_many_attempts', message: 'too many attempts; try again later' },
      { status: 429, headers: { 'retry-after': String(Math.ceil(budget.retryAfterMs / 1000)) } },
    );
  }
  const pin = typeof body?.pin === 'string' ? body.pin : '';
  if (!(await verifyPin(pin))) {
    await recordFailure(ATTEMPT_KEY, KIOSK_AUTHORIZE_POLICY, Date.now());
    return NextResponse.json({ error: 'unauthorized', message: 'invalid pin' }, { status: 401 });
  }
  // 🔴 成功したら失敗数を捨てる（正しく入った直後に予算切れで断られる形を作らない）。
  await recordSuccess(ATTEMPT_KEY);

  const kioskId = typeof body?.kioskId === 'string' && body.kioskId ? body.kioskId : 'kiosk-dev';
  const token = await issueKioskSession(kioskId);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(KIOSK_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: new URL(request.url).protocol === 'https:',
    maxAge: Math.floor(KIOSK_SESSION_TTL_MS / 1000),
  });
  return res;
}
