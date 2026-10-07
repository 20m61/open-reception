import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';
import { resolveDeviceBinding } from '@/lib/product-context/device-binding';
import { getKioskRepository } from '@/lib/kiosk/kiosk-store';
import { getReception } from '@/lib/data-stores/reception-store';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { ReceptionSession } from '@/domain/reception/session';

/**
 * 認証済み kiosk セッション。kioskId は署名済み cookie、tenantId/siteId は端末台帳が権威。
 * クライアント送信値（body/query の kioskId・tenantId 等）は一切信用しない (issue #348)。
 */
export type KioskSession = {
  kioskId: string;
  tenantId: TenantId;
  siteId: SiteId;
};

/**
 * 署名検証済みの kioskId を、**現在も有効な端末**へ解決する。
 *
 * 署名と有効期限だけでは、失効させた端末の cookie（30 日）が使い続けられる。ここで端末台帳を
 * 引き、次のいずれかなら null（fail-closed）:
 *   - 端末台帳（Device）に居ない・`active` でない・読み取りに失敗した
 *   - 旧 kiosk レジストリ（#18）で無効化されている（`/admin/kiosks` の失効は Device への写像が
 *     best-effort なので、旧レジストリ側の失効を Device より強いものとして扱う。
 *     `summarizeFleet` と同じ規則）
 *
 * 🔴 解決できない端末を既定テナント/サイトへ写像しない。スコープは台帳からしか取らない。
 */
async function resolveActiveKiosk(kioskId: string): Promise<KioskSession | null> {
  const binding = await resolveDeviceBinding(kioskId);
  if (!binding) return null;
  try {
    const legacy = await getKioskRepository().getKiosk(binding.kioskId);
    if (legacy && !legacy.enabled) return null;
  } catch {
    return null;
  }
  return { kioskId: binding.kioskId, tenantId: binding.tenantId, siteId: binding.siteId };
}

/** cookie 値（kiosk session token）から有効な kiosk セッションを解決する。無効なら null。 */
export async function resolveKioskSessionToken(
  token: string | undefined,
): Promise<KioskSession | null> {
  const claims = await readKioskSession(token);
  if (!claims) return null;
  return resolveActiveKiosk(claims.kioskId);
}

/**
 * 有効な kiosk セッション（cookie）を返す。無ければ null。
 *
 * **kiosk の API はすべてここを通す**（端末の失効を 1 箇所で効かせるため。route ごとに
 * 失効確認を複製しない）。網羅は `src/app/api/kiosk/session-guard-coverage.test.ts` が
 * route の棚卸しから機械的に縛る。
 *
 * kioskId はこの戻り値（認証済みセッション）を権威とする。クライアント送信値（リクエスト
 * body/query の kioskId）は信用しない (issue #348) — 受付作成 (`/api/kiosk/receptions`)
 * はこの kioskId で `reception.kioskId` を確定し、以後の所有権チェック（status/stay 等）が
 * 同一端末からの要求で一致するようにする。
 */
export async function requireKioskSession(): Promise<KioskSession | null> {
  const cookie = (await cookies()).get(KIOSK_COOKIE)?.value;
  return resolveKioskSessionToken(cookie);
}

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: 'forbidden', message: 'kiosk session required' },
    { status: 403 },
  );
}

/**
 * 受付端末（kiosk）セッションを要求する共通サーバガード (issue #239)。
 *
 * `/kiosk` の受付フロー（受付セッションの作成・状態遷移）は端末からの操作であり、有効な
 * kiosk セッション必須にする。クライアント側ゲート（`resolveKioskGate`）は UX 誘導であって
 * 実アクセス制御ではないため、各 API ハンドラの処理本体の前にこのガードを通す。
 *
 * セッションが無ければ 403 を返す（呼び出し側は早期 return する）。あれば `null` を返し処理続行。
 */
export async function denyWithoutKioskSession(): Promise<NextResponse | null> {
  const session = await requireKioskSession();
  return session ? null : forbidden();
}

/**
 * 受付 `[id]` の状態遷移を、**その受付を作成した端末のセッション**に限って許す。
 *
 * - セッションが無効（無し・失効・未登録・台帳を読めない）→ 403
 * - 受付が無い、または別端末の受付 → **404**（存在の有無を区別させない）
 *
 * 受付レコードは tenantId/siteId を持たないので、所有は作成端末（`reception.kioskId`。作成時に
 * セッションから確定する）で判定する。端末は台帳上ちょうど 1 つの tenant/site に属するため、
 * 端末一致は tenant/site 一致を含む。遷移に使うスコープは戻り値の `session` から取る。
 */
export async function requireOwnedReception(
  id: string,
): Promise<
  | { ok: true; session: KioskSession; reception: ReceptionSession }
  | { ok: false; response: NextResponse }
> {
  const session = await requireKioskSession();
  if (!session) return { ok: false, response: forbidden() };
  const found = await getReception(id);
  if (!found.ok || found.value.kioskId !== session.kioskId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'not_found', message: 'reception not found' },
        { status: 404 },
      ),
    };
  }
  return { ok: true, session, reception: found.value };
}
