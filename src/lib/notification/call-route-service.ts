/**
 * 通知ルート設定サービス (issue #88, increment 1)。
 *
 * リポジトリ・テナント/サイト認可・監査ログを束ねる薄い層。route ハンドラから呼び出す。
 * 認可判定は純関数（src/domain/tenant/authorization.ts）へ委譲し、副作用（永続化・監査）は
 * ここに閉じ込める（SiteService #87 と同じ責務分離）。
 *
 * 認可方針（#80）:
 *   - 一覧/取得: canAccessSite(read)（site_manager は担当サイトのみ）。
 *   - 作成/更新/削除: canAccessSite(write)（viewer は不可・他テナント越境は不可）。
 *
 * 監査方針:
 *   - 設定変更を call_route.created / updated / deleted で記録する。
 *   - 機微値（target.value＝電話番号/メール等）は監査に **残さない**。残すのは
 *     id・name・siteId・enabled・グループ/呼び出し先の **件数** のみ。
 */
import { randomUUID } from 'node:crypto';
import { canAccessSite } from '@/domain/tenant/authorization';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditAction } from '@/domain/reception/log';
import { asSiteId, type SiteId, type TenantId } from '@/domain/tenant/types';
import type { CallRouteRepository } from './repository';
import {
  asCallRouteId,
  type CallRoute,
  type CallRouteId,
  type CreateCallRouteInput,
  type UpdateCallRoutePatch,
} from './types';
import { validateGroups, validateRouteName } from './validation';

export type ServiceError = {
  code: 'invalid_input' | 'not_found' | 'forbidden';
  message: string;
};
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

function fail(code: ServiceError['code'], message: string): ServiceResult<never> {
  return { ok: false, error: { code, message } };
}

/** 監査ログ追記の関数型（テストで差し替え可能。global backend 依存を切り離す）。 */
export type AppendAudit = (
  action: AuditAction,
  target: { type: string; id?: string },
  metadata?: Record<string, string>,
) => Promise<unknown>;

export type CallRouteServiceDeps = {
  routes: CallRouteRepository;
  appendAudit: AppendAudit;
  now?: () => Date;
};

export class CallRouteService {
  private readonly routes: CallRouteRepository;
  private readonly appendAudit: AppendAudit;
  private readonly now: () => Date;

  constructor(deps: CallRouteServiceDeps) {
    this.routes = deps.routes;
    this.appendAudit = deps.appendAudit;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * テナント配下の通知ルート一覧を返す（siteId 指定時はそのサイトに絞る）。
   * site_manager のように特定サイトのみ権限を持つ場合は、権限のあるサイトのみ表示する。
   */
  async list(actor: Actor, tenantId: TenantId, siteId?: SiteId): Promise<ServiceResult<CallRoute[]>> {
    const all = await this.routes.listRoutes(tenantId, siteId);
    const visible = all.filter((r) => canAccessSite(actor, tenantId, r.siteId, 'read'));
    return { ok: true, value: visible };
  }

  async get(actor: Actor, tenantId: TenantId, id: CallRouteId): Promise<ServiceResult<CallRoute>> {
    const found = await this.routes.getRoute(tenantId, id);
    if (!found) return fail('not_found', 'call route not found');
    if (!canAccessSite(actor, tenantId, found.siteId, 'read'))
      return fail('forbidden', 'actor cannot access this call route');
    return { ok: true, value: found };
  }

  /** 通知ルートを作成する。対象サイトへの write 認可が必要（viewer/他テナントは不可）。 */
  async create(actor: Actor, input: CreateCallRouteInput): Promise<ServiceResult<CallRoute>> {
    if (!canAccessSite(actor, input.tenantId, input.siteId, 'write'))
      return fail('forbidden', 'actor cannot create call routes for this site');

    const name = validateRouteName(input.name);
    if (!name.ok) return fail('invalid_input', name.error.message);
    const groups = validateGroups(input.groups);
    if (!groups.ok) return fail('invalid_input', groups.error.message);

    const nowIso = this.now().toISOString();
    const route: CallRoute = {
      id: asCallRouteId(`route-${randomUUID()}`),
      tenantId: input.tenantId,
      siteId: input.siteId,
      name: name.value,
      groups: groups.value,
      enabled: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const created = await this.routes.createRoute(route);
    if (!created.ok) return fail('invalid_input', created.error.message);
    await this.audit('call_route.created', route);
    return { ok: true, value: created.value };
  }

  /** ルート名・グループ・有効/無効を更新する。対象サイトへの write 認可が必要。 */
  async update(
    actor: Actor,
    tenantId: TenantId,
    id: CallRouteId,
    patch: UpdateCallRoutePatch,
  ): Promise<ServiceResult<CallRoute>> {
    const found = await this.routes.getRoute(tenantId, id);
    if (!found) return fail('not_found', 'call route not found');
    if (!canAccessSite(actor, tenantId, found.siteId, 'write'))
      return fail('forbidden', 'actor cannot write to this call route');

    let name = found.name;
    if (patch.name !== undefined) {
      const v = validateRouteName(patch.name);
      if (!v.ok) return fail('invalid_input', v.error.message);
      name = v.value;
    }
    let groups = found.groups;
    if (patch.groups !== undefined) {
      const v = validateGroups(patch.groups);
      if (!v.ok) return fail('invalid_input', v.error.message);
      groups = v.value;
    }
    const next: CallRoute = {
      ...found,
      name,
      groups,
      enabled: patch.enabled ?? found.enabled,
      updatedAt: this.now().toISOString(),
    };
    await this.routes.putRoute(next);
    await this.audit('call_route.updated', next);
    return { ok: true, value: next };
  }

  /** ルートを削除する。対象サイトへの write 認可が必要。 */
  async remove(actor: Actor, tenantId: TenantId, id: CallRouteId): Promise<ServiceResult<void>> {
    const found = await this.routes.getRoute(tenantId, id);
    if (!found) return fail('not_found', 'call route not found');
    if (!canAccessSite(actor, tenantId, found.siteId, 'write'))
      return fail('forbidden', 'actor cannot delete this call route');
    const removed = await this.routes.deleteRoute(tenantId, id);
    if (!removed.ok) return fail('not_found', removed.error.message);
    await this.audit('call_route.deleted', found);
    return { ok: true, value: undefined };
  }

  /**
   * PII を含めない監査記録。target.value（電話番号/メール）は残さず、件数のみ残す。
   * actor は呼び出し側（route）で admin に固定。
   */
  private async audit(action: AuditAction, route: CallRoute): Promise<void> {
    const targetCount = route.groups.reduce((sum, g) => sum + g.targets.length, 0);
    await this.appendAudit(action, { type: 'call_route', id: route.id }, {
      name: route.name,
      siteId: route.siteId,
      enabled: String(route.enabled),
      groupCount: String(route.groups.length),
      targetCount: String(targetCount),
    });
  }
}

/** route 側で文字列 → ブランド ID へ畳む際の薄いヘルパ（再 export）。 */
export { asCallRouteId, asSiteId };
