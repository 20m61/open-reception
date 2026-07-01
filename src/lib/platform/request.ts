/**
 * プラットフォーム運用コンソール API のリクエスト認可ヘルパ (issue #90, increment 1)。
 *
 * platform エリアは総合開発者・プラットフォーム運用者（developer ロール）専用の
 * テナント横断コンソール。本ヘルパは全 platform API の入口で「未認証 → 401 /
 * 非 developer → 403」を一律に強制する（#83 安全方針: 通常時 read 中心・最小権限）。
 *
 * - actor の実解決は中央モジュール @/lib/auth/actor に集約済み（developer は env の
 *   明示 allowlist でのみ付与される）。ここからは互換のため re-export する。
 * - エリア境界の判定は #85 の純関数 canEnterArea(actor, 'platform')
 *   （= accessibleTenants(actor).scope==='all'、developer のみ）に委譲する。
 *
 * これは UX/入口の二重化ではなく「最終的な認可は必ず API 側で行う」（route-guard.ts の
 * 方針）の実体。layout のガードはあくまで表示制御で、データ露出は本ヘルパが守る。
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import type { Actor } from '@/domain/tenant/authorization';
import { canEnterArea } from '@/components/admin/route-guard';
import { resolveAdminActor, resolveAdminActorWithIdentity } from '@/lib/auth/actor';
import { type ElevationScope, requireElevation } from '@/domain/auth/elevation';
import { ELEVATION_COOKIE, readElevation, type ReadElevation } from './elevation';

export { resolveAdminActor };

/**
 * platform API の認可ゲート。
 *   - 未認証 / 非 active           → 401 unauthorized。
 *   - 認証済みだが非 developer      → 403 forbidden。
 *   - developer（全テナント横断）   → ok:true で actor を返す。
 *
 * 返り値が ok:false の場合はそのまま return できる NextResponse を同梱する。
 */
/** 未認証 401 / 非 developer 403 の共通ゲート（両 authorize が同一判定を共有し drift を防ぐ）。 */
function platformGate(actor: Actor | null): { ok: true } | { ok: false; response: NextResponse } {
  if (!actor || actor.status !== 'active' || actor.assignments.length === 0) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  if (!canEnterArea(actor, 'platform').allowed) {
    return { ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { ok: true };
}

export async function authorizePlatform(): Promise<
  { ok: true; actor: Actor } | { ok: false; response: NextResponse }
> {
  const actor = await resolveAdminActor();
  const gate = platformGate(actor);
  return gate.ok ? { ok: true, actor: actor! } : gate;
}

/**
 * `authorizePlatform` に加えて操作者 identity も返す (issue #264)。昇格発行（/elevate）で cookie の
 * subject 束縛・監査 actor に使う。write ルートは identity を cookie（昇格）から得るため本関数は不要
 * （assertElevated の elevation.sub を使う）。認可判定は platformGate を共有する。
 */
export async function authorizePlatformWithIdentity(): Promise<
  { ok: true; actor: Actor; identity: string } | { ok: false; response: NextResponse }
> {
  const resolved = await resolveAdminActorWithIdentity();
  const gate = platformGate(resolved?.actor ?? null);
  return gate.ok ? { ok: true, actor: resolved!.actor, identity: resolved!.identity } : gate;
}

/**
 * platform の**破壊的操作**ゲート (issue #83 AC5/AC10 / inc4b)。`authorizePlatform` に加えて
 * JIT 昇格（`platform_elevation` cookie）が有効で対象スコープを覆うことを要求する。
 *   - 未認証 / 非 developer                 → 401 / 403。
 *   - 認証済みだが未昇格 / 失効 / スコープ外 → 403 `elevation_required`（UI が昇格導線を出せる）。
 *   - 昇格 cookie が**別人の identity**       → 403（漏洩 cookie の replay/誤帰属を防ぐ, #264）。
 *   - 昇格中（本人）                          → ok:true で actor と elevation を返す。
 * write ルートはこのガード通過後に処理し、必ず recordDangerAction で before/after を監査する。
 */
export async function assertElevated(
  target: ElevationScope = {},
): Promise<{ ok: true; actor: Actor; elevation: ReadElevation } | { ok: false; response: NextResponse }> {
  const auth = await authorizePlatformWithIdentity();
  if (!auth.ok) return auth;

  const token = (await cookies()).get(ELEVATION_COOKIE)?.value;
  const elevation = await readElevation(token);
  // 昇格 cookie は発行時の操作者(sub)に束縛。別 developer が漏洩 cookie を replay しても拒否し、
  // かつ他人の操作を誤帰属しない（#264）。sub 不一致は未昇格と同じ 403 で存在を秘匿する。
  // 限界: これは **per-operator identity（SSO の email/subject）** 前提。共有パスワード運用
  // （OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer）は全員 identity='password-admin' で per-operator の
  // 区別が無いため束縛は実質的な制約にならない（SSO 運用でのみ有効。単一資格運用は元々同一主体）。
  const boundToActor = elevation !== null && elevation.sub === auth.identity;
  const check = requireElevation(boundToActor ? elevation : null, target, Date.now());
  // boundToActor が false のときは requireElevation(null) が not ok を返すので !check.ok が拾う。
  // !elevation は ok:true 分岐で elevation を非 null に絞るための TS ガード。
  if (!check.ok || !elevation) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'elevation_required', reason: check.ok ? 'not_elevated' : check.reason },
        { status: 403 },
      ),
    };
  }
  return { ok: true, actor: auth.actor, elevation };
}
