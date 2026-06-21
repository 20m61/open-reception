/**
 * 拠点（Site）管理サービス (issue #87, increment 1)。
 *
 * リポジトリ・テナント/サイト認可・監査ログを束ねる薄い層。route ハンドラから呼び出す。
 * 判定は純関数（src/domain/tenant/authorization.ts）へ委譲し、副作用（永続化・監査）は
 * ここに閉じ込める。ReservationService（#97）と同じ責務分離の方針。
 *
 * スコープ（このトラックの担当範囲）:
 *   - inc1 は **Site 管理を主**とする（一覧・作成・編集・有効/停止）。
 *   - Device は既存 kiosks 管理（#18）と重複するため、ここでは Site⇔Device の
 *     **紐づけ表示**（サイト配下の端末数・オンライン数）に留め、端末の作り替えはしない。
 *     Device/kiosk の統合方針と次増分は docs/site-device-management-design.md に明記。
 *
 * 監査は PII を残さない。残すのは Site の id・name・status・操作のみ。
 */
import { randomUUID } from 'node:crypto';
import { canAccessSite, canAccessTenant } from '@/domain/tenant/authorization';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditAction } from '@/domain/reception/log';
import {
  asSiteId,
  type Site,
  type SiteId,
  type SiteStatus,
  type TenantId,
} from '@/domain/tenant/types';
import type { DeviceRepository, SiteRepository } from './repository';
import { deriveConnectivity } from './device-service';

export type ServiceError = {
  code: 'invalid_input' | 'not_found' | 'forbidden';
  message: string;
};
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

function fail(code: ServiceError['code'], message: string): ServiceResult<never> {
  return { ok: false, error: { code, message } };
}

/**
 * テナント全体を管理できる actor か（developer または当該テナントの tenant_admin）。
 * 新規サイト作成のように「テナントに属するサブ要素を増やす」操作はこの権限を要する。
 * canAccessTenant(write) はサイト単位の site_manager でも真になりうるため、ここでは
 * 「siteId 束縛のないテナント全体スコープの write 割り当て」を明示的に要求する。
 */
function canManageTenant(actor: Actor, tenantId: TenantId): boolean {
  if (actor.status !== 'active') return false;
  for (const a of actor.assignments) {
    if (a.role === 'developer') return true;
    if (a.role === 'tenant_admin' && a.tenantId === tenantId) return true;
  }
  return false;
}

/** 監査ログ追記の関数型（テストで差し替え可能にし、global backend 依存を切り離す）。 */
export type AppendAudit = (
  action: AuditAction,
  target: { type: string; id?: string },
  metadata?: Record<string, string>,
) => Promise<unknown>;

/**
 * Site に Device（=kiosk）の紐づけ集計を付与したビュー (issue #87 画面要件)。
 * 端末トークンなどの機密は含めない（一覧では数の把握のみ）。
 */
export type SiteWithDevices = Site & {
  /** サイト配下の端末数。 */
  deviceCount: number;
  /**
   * オンライン端末数。inc3 で実 heartbeat（Device.lastSeenAt）由来の稼働状態へ更新。
   * deriveConnectivity が 'online' を返す端末のみ数える（DeviceService と同一ロジック）。
   * heartbeat 未着・revoked・maintenance はオンラインに数えない。
   */
  onlineDeviceCount: number;
};

export type CreateSiteInput = {
  tenantId: TenantId;
  name: string;
};

export type UpdateSitePatch = {
  name?: string;
  status?: SiteStatus;
};

export type SiteServiceDeps = {
  sites: SiteRepository;
  devices: DeviceRepository;
  appendAudit: AppendAudit;
  now?: () => Date;
};

export class SiteService {
  private readonly sites: SiteRepository;
  private readonly devices: DeviceRepository;
  private readonly appendAudit: AppendAudit;
  private readonly now: () => Date;

  constructor(deps: SiteServiceDeps) {
    this.sites = deps.sites;
    this.devices = deps.devices;
    this.appendAudit = deps.appendAudit;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * テナント配下の拠点一覧を返す（Device 紐づけ集計つき）。
   * テナント境界: developer / 当該テナントの割り当てが必要。
   * site_manager のように特定サイトのみ権限を持つ場合は、当該サイトだけに絞る。
   */
  async list(actor: Actor, tenantId: TenantId): Promise<ServiceResult<SiteWithDevices[]>> {
    if (!canAccessTenant(actor, tenantId, 'read'))
      return fail('forbidden', 'actor cannot access this tenant');
    const all = await this.sites.listSites(tenantId);
    // site_manager（サイト単位）は権限のあるサイトのみ表示する（#87 UI 方針）。
    const visible = all.filter((s) => canAccessSite(actor, tenantId, s.id, 'read'));
    const withDevices: SiteWithDevices[] = [];
    for (const site of visible) {
      withDevices.push(await this.attachDevices(site));
    }
    return { ok: true, value: withDevices };
  }

  async get(
    actor: Actor,
    tenantId: TenantId,
    id: SiteId,
  ): Promise<ServiceResult<SiteWithDevices>> {
    if (!canAccessSite(actor, tenantId, id, 'read'))
      return fail('forbidden', 'actor cannot access this site');
    const found = await this.sites.getSite(tenantId, id);
    return found
      ? { ok: true, value: await this.attachDevices(found) }
      : fail('not_found', 'site not found');
  }

  /**
   * 拠点を作成する。作成は **テナント全体に対する操作** なので、テナント横断の write 権限
   * （developer / tenant_admin）が必要。site_manager は特定サイトの権限しか持たないため、
   * テナント write 判定（canAccessTenant）を満たしても新規サイト作成は許可しない。
   * 作成を監査に残す。
   */
  async create(actor: Actor, input: CreateSiteInput): Promise<ServiceResult<Site>> {
    if (!canManageTenant(actor, input.tenantId))
      return fail('forbidden', 'actor cannot create sites in this tenant');
    const name = input.name.trim();
    if (name === '') return fail('invalid_input', 'name is required');

    const nowIso = this.now().toISOString();
    const site: Site = {
      id: asSiteId(`site-${randomUUID()}`),
      tenantId: input.tenantId,
      name,
      status: 'active',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const created = await this.sites.createSite(site);
    if (!created.ok) return fail('invalid_input', created.error.message);
    await this.audit('site.created', site);
    return { ok: true, value: created.value };
  }

  /** 拠点名・状態（有効/停止）を更新する。サイト境界 write 認可が必要。 */
  async update(
    actor: Actor,
    tenantId: TenantId,
    id: SiteId,
    patch: UpdateSitePatch,
  ): Promise<ServiceResult<Site>> {
    if (!canAccessSite(actor, tenantId, id, 'write'))
      return fail('forbidden', 'actor cannot write to this site');
    const found = await this.sites.getSite(tenantId, id);
    if (!found) return fail('not_found', 'site not found');

    let name = found.name;
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (trimmed === '') return fail('invalid_input', 'name must not be empty');
      name = trimmed;
    }
    const next: Site = {
      ...found,
      name,
      status: patch.status ?? found.status,
      updatedAt: this.now().toISOString(),
    };
    await this.sites.putSite(next);
    await this.audit('site.updated', next);
    return { ok: true, value: next };
  }

  /** サイトに Device 集計を付与する。端末の機密は読まない（数のみ）。 */
  private async attachDevices(site: Site): Promise<SiteWithDevices> {
    const devices = await this.devices.listDevices(site.tenantId, site.id);
    const now = this.now();
    return {
      ...site,
      deviceCount: devices.length,
      onlineDeviceCount: devices.filter((d) => deriveConnectivity(d, now) === 'online').length,
    };
  }

  /** PII を含めない監査記録。actor は呼び出し側（route）で admin に固定。 */
  private async audit(action: AuditAction, site: Site): Promise<void> {
    await this.appendAudit(action, { type: 'site', id: site.id }, {
      name: site.name,
      status: site.status,
    });
  }
}
