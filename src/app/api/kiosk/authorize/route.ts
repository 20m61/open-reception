import { NextResponse } from 'next/server';
import { getSecuritySettings, verifyPin } from '@/lib/security/security-store';
import { isIpAllowed } from '@/domain/security/types';
import { KIOSK_COOKIE, KIOSK_SESSION_TTL_MS, issueKioskSession } from '@/lib/auth/kiosk';
import { readJson } from '@/lib/data-stores/result-http';
import { KIOSK_AUTHORIZE_LAYERS } from '@/domain/security/attempt-budget';
import { clientIdentity } from '@/lib/security/client-identity';
import { recordLayeredSuccess, reserveLayeredSafely } from '@/lib/security/attempt-store';
import { reportAttemptBudgetExceeded, reportAttemptStoreUnavailable } from '@/lib/security/attempt-report';

/**
 * 🔴 **試行予算は層になっている（#1021 AC4 / レビュー B1・B2）。**
 *
 * 一次は**発信元ごと**（`x-forwarded-for` の**末尾** = CloudFront が付ける詐称できない
 * viewer IP。`clientIdentity`）。二次は global cap。
 *
 * 🔴 **当初は global 1 本にしていた。** 「非詐称可能な識別子は無い」と判断したためだが、
 * それは**この route が読んでいる `split(',')[0]`（先頭＝詐称可能）から一般化した誤り**で、
 * `src/lib/admin/audit.ts` が末尾を採っていることと `src/proxy.ts` の origin-verify が
 * CloudFront 迂回を全ルートで拒否していることで反証された（独立レビュー B1）。
 *
 * global 1 本だと、攻撃者が少量のリクエストで**受付の初回認可を無期限に閉じられる**うえ、
 * 復旧経路（admin → エンロール URL 発行）も同じ形で閉じられて**受付が復旧不能**になった
 * （同 B2）。一次を発信元ごとにすると、他人の失敗で閉まらない。
 *
 * 残る代償: global cap を使い切られている間は**初回の PIN 認可**が閉じる。ただし
 * **稼働中の端末は 30 日 cookie で動き続け**、復旧経路は admin 側（global cap 無し）なので開く。
 */
const ATTEMPT_SCOPE = 'kiosk-authorize';

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
  // 🔴 **予約してから照合する（Codex レビュー P1）。** 読み取り専用の判定だと、
  //    並行バーストで**全員が予算内と読んで全員が照合へ進む**（実測: 予算 3 に対して
  //    20 回中 20 回が到達し 0 回しか断られなかった）。入場を CAS で予約することでしか
  //    閉じられない。数えるのは「入場した試行」で、成功したら窓ごと捨てる。
  const identity = await clientIdentity(request);
  const budget = await reserveLayeredSafely(
    identity,
    ATTEMPT_SCOPE,
    KIOSK_AUTHORIZE_LAYERS,
    Date.now(),
  );
  if (budget === 'degraded') {
    // 🔴 **帳簿が落ちているが通す**（この経路は `onStoreFailure: 'open'`）。
    //    沈黙で劣化させない —— ラッチ付きで記録する。
    reportAttemptStoreUnavailable(ATTEMPT_SCOPE);
  } else if (budget === 'unavailable') {
    // 🔴 ストアが読めないときは fail-closed（落とせば制限が消える状態を作らない）。
    //    未捕捉 throw にはしない（未認証経路で 500 を無制限に生ませない）。
    reportAttemptStoreUnavailable(ATTEMPT_SCOPE);
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
  if (budget !== 'degraded' && !budget.allowed) {
    // 🔴 **閉じたことを記録する（レビュー M4）。** 記録が無いと、来訪者に
    //    「担当者へお声がけください」と言われた担当者が**なぜ閉じたのか知る手段が無い**。
    //    値（PIN）は残さない。
    reportAttemptBudgetExceeded(ATTEMPT_SCOPE);
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
    // 予約の時点で数えてあるので、ここで数え直さない（二重計上になる）。
    return NextResponse.json({ error: 'unauthorized', message: 'invalid pin' }, { status: 401 });
  }
  // 🔴 成功したら窓を捨てる（正しく入った直後に予算切れで断られる形を作らない）。
  //    🔴 **ここの失敗でセッション発行を止めない（レビュー M2）。** 捨て損なっても
  //    予算は窓明けで自然に戻る。止めると、帳簿の書き込み失敗だけで**正しい PIN を
  //    入れた来訪者が受付を開始できない**（実測で未捕捉 500 になっていた）。
  if (!(await recordLayeredSuccess(identity, ATTEMPT_SCOPE))) {
    reportAttemptStoreUnavailable(ATTEMPT_SCOPE);
  }

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
