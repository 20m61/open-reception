/**
 * Vonage Video セッションの所有テナントと、トークン発行のための解決。
 *
 * 🔴 **不変条件: あるセッションに対する Vonage 操作（作成・端末トークン・担当者トークン）は、
 * すべてそのセッションを作ったテナントの設定で行う。**
 *
 * テナントごとに Vonage アプリケーションが違うと、別テナントの設定で発行したトークンは
 * そのセッションに入れない（または別アプリケーションのトークンになる）。作成側は端末の所属
 * テナントで作るので（`api/kiosk/receptions/[id]/call`）、発行側が既定テナントなどの別の
 * 規則でテナントを選ぶと、同じ呼び出しの中でテナントが分かれる。
 *
 * そのため所有テナントは**作成時に受付レコードへ記録**し（`startCall` が書く
 * `ReceptionSession.vonageTenantId`）、発行側はそこからしか取らない。要求元の入力
 * （body / query / 応答トークンの主張）は「要求元がどのテナントか」を示すだけで、
 * 設定を引くテナントには使わない —— 一致しなければ発行しない。
 *
 * 発行の入口はここ 1 つにしてある。tenantId を引数に取らないので、呼び出し側が別の
 * テナントの設定を引く書き方ができない。
 */
import type { ReceptionSession } from '@/domain/reception/session';
import type { VonageSessionService } from '@/adapters/call/vonage-session';
import { resolveVonageSessionService } from './adapter-factory';
import { getVonagePublicConfigForTenant } from './vonage-config';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';

/**
 * セッションの所有テナント。
 *
 * - 記録があればそれ
 * - 記録が無い（この項目が入る前に作られたレコード）→ 既定テナント。当時は作成・発行とも
 *   既定テナントで行っていたので、これが実際の所有テナントである
 * - 記録が壊れている（空・非文字列）→ null。既定テナントへ倒すと、壊れたレコードに
 *   既定テナントの資格情報でトークンを出すことになる
 */
export function vonageSessionTenantOf(
  reception: Pick<ReceptionSession, 'vonageTenantId'>,
): string | null {
  const recorded: unknown = reception.vonageTenantId;
  if (recorded === undefined) return resolveDefaultScope().tenantId;
  return typeof recorded === 'string' && recorded !== '' ? recorded : null;
}

export type VonageSessionAccess =
  | {
      kind: 'ok';
      tenantId: string;
      sessionId: string;
      applicationId: string;
      service: VonageSessionService;
    }
  /** 要求元のテナントがセッションの所有テナントと違う（または所有テナントが解決できない）。 */
  | { kind: 'mismatch' }
  /** セッション未確立、または所有テナントの Vonage が無効・不備。 */
  | { kind: 'unavailable' };

/**
 * 要求元（`requesterTenantId`。サーバー側で認証済みの値だけを渡すこと）が、受付の
 * Vonage セッションへトークンを得てよいかを判定し、所有テナントの設定で発行手段を解決する。
 *
 * テナントの比較は設定を引く前に行う（不一致なら所有テナントの設定に触れない）。
 */
export async function resolveVonageSessionAccess(
  reception: Pick<ReceptionSession, 'vonageSessionId' | 'vonageTenantId'>,
  requesterTenantId: string | undefined,
): Promise<VonageSessionAccess> {
  const tenantId = vonageSessionTenantOf(reception);
  if (tenantId === null || requesterTenantId !== tenantId) return { kind: 'mismatch' };

  const sessionId = reception.vonageSessionId;
  if (!sessionId) return { kind: 'unavailable' };
  const service = await resolveVonageSessionService(tenantId);
  const publicConfig = await getVonagePublicConfigForTenant(tenantId);
  if (!service || !publicConfig) return { kind: 'unavailable' };
  return { kind: 'ok', tenantId, sessionId, applicationId: publicConfig.applicationId, service };
}
