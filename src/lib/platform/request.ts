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
import { resolveAdminActor } from '@/lib/auth/actor';
import { type Elevation, type ElevationScope, requireElevation } from '@/domain/auth/elevation';
import { ELEVATION_COOKIE, readElevation } from './elevation';

export { resolveAdminActor };

/**
 * platform API の認可ゲート。
 *   - 未認証 / 非 active           → 401 unauthorized。
 *   - 認証済みだが非 developer      → 403 forbidden。
 *   - developer（全テナント横断）   → ok:true で actor を返す。
 *
 * 返り値が ok:false の場合はそのまま return できる NextResponse を同梱する。
 */
export async function authorizePlatform(): Promise<
  { ok: true; actor: Actor } | { ok: false; response: NextResponse }
> {
  const actor = await resolveAdminActor();
  if (!actor || actor.status !== 'active' || actor.assignments.length === 0) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    };
  }
  if (!canEnterArea(actor, 'platform').allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    };
  }
  return { ok: true, actor };
}

/**
 * platform の**破壊的操作**ゲート (issue #83 AC5/AC10 / inc4b)。`authorizePlatform` に加えて
 * JIT 昇格（`platform_elevation` cookie）が有効で対象スコープを覆うことを要求する。
 *   - 未認証 / 非 developer                 → authorizePlatform の 401 / 403。
 *   - 認証済みだが未昇格 / 失効 / スコープ外 → 403 `elevation_required`（UI が昇格導線を出せる）。
 *   - 昇格中                                 → ok:true で actor と elevation を返す。
 * write ルートはこのガード通過後に処理し、必ず recordDangerAction で before/after を監査する。
 */
export async function assertElevated(
  target: ElevationScope = {},
): Promise<{ ok: true; actor: Actor; elevation: Elevation } | { ok: false; response: NextResponse }> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth;

  const token = (await cookies()).get(ELEVATION_COOKIE)?.value;
  const elevation = await readElevation(token);
  const check = requireElevation(elevation, target, Date.now());
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
