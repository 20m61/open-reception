/**
 * 受付端末（Device）管理サービス (issue #87, increment 2)。
 *
 * SiteService（inc1）に倣う薄い層。route ハンドラから呼び出し、認可判定は純関数
 * （src/domain/tenant/authorization.ts）へ委譲し、副作用（永続化・監査）をここに閉じ込める。
 *
 * Tenant > Site > Device のテナント境界に乗せた Device 管理を提供する。既存 kiosks 管理
 * （#18 / KiosksManager）は書き換えず、Device/kiosk 統合の本対応は次増分
 * （docs/site-device-management-design.md §Device/Kiosk 統合方針）。
 *
 * セキュリティ:
 *   - device token の平文は保持・返却・監査のいずれにも出さない（`tokenRegistered` の真偽のみ）。
 *   - viewer は書込不可・テナント越境は拒否（authorization.ts の純関数で担保）。
 *
 * 監査は PII を残さない。残すのは Device の id・name・siteId・status・操作のみ。
 * 事前定義済みアクション device.token_reissued / device.disabled / device.enabled を使う。
 */
import { randomUUID } from 'node:crypto';
import { canAccessSite } from '@/domain/tenant/authorization';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditAction } from '@/domain/reception/log';
import {
  asDeviceId,
  type Device,
  type DeviceId,
  type DeviceKind,
  type SiteId,
  type TenantId,
} from '@/domain/tenant/types';
import type { AppendAudit, ServiceResult } from './site-service';
import type { DeviceRepository, SiteRepository } from './repository';

function fail(
  code: 'invalid_input' | 'not_found' | 'forbidden',
  message: string,
): ServiceResult<never> {
  return { ok: false, error: { code, message } };
}

/**
 * UI 向けの稼働状態（issue #87 画面要件: オンライン / オフライン / メンテナンス中）。
 * inc3 で Kiosk→Device の heartbeat を `lastSeenAt` に取り込み、online/offline を実活動から
 * 導く（recordHeartbeat 経由）。status + maintenance + lastSeenAt から派生する。
 */
export type DeviceConnectivity = 'online' | 'offline' | 'maintenance' | 'disabled';

export const DEFAULT_ONLINE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Device の稼働状態を派生する純関数 (issue #87 inc3)。
 * DeviceService（一覧/詳細）と SiteService（オンライン端末数の集計）で同一ロジックを共有する。
 *   - revoked → disabled
 *   - maintenance → maintenance
 *   - lastSeenAt が窓内 → online、それ以外 → offline
 *   - lastSeenAt 未取得 → offline（heartbeat 未着）
 */
export function deriveConnectivity(
  device: Device,
  now: Date,
  onlineWindowMs: number = DEFAULT_ONLINE_WINDOW_MS,
): DeviceConnectivity {
  if (device.status === 'revoked') return 'disabled';
  if (device.maintenance) return 'maintenance';
  if (!device.lastSeenAt) return 'offline';
  const age = now.getTime() - new Date(device.lastSeenAt).getTime();
  return age >= 0 && age <= onlineWindowMs ? 'online' : 'offline';
}

/** 一覧/詳細レスポンス。token 平文は含めない（tokenRegistered の真偽のみ）。 */
export type DeviceView = Device & {
  /** 派生した稼働状態。 */
  connectivity: DeviceConnectivity;
};

export type CreateDeviceInput = {
  tenantId: TenantId;
  siteId: SiteId;
  name: string;
  location?: string;
  kind?: DeviceKind;
};

export type UpdateDevicePatch = {
  name?: string;
  location?: string;
  kind?: DeviceKind;
  maintenance?: boolean;
};

export type DeviceServiceDeps = {
  devices: DeviceRepository;
  sites: SiteRepository;
  appendAudit: AppendAudit;
  now?: () => Date;
  /** オフライン判定のしきい値（ms）。既定 5 分。 */
  onlineWindowMs?: number;
};

export class DeviceService {
  private readonly devices: DeviceRepository;
  private readonly sites: SiteRepository;
  private readonly appendAudit: AppendAudit;
  private readonly now: () => Date;
  private readonly onlineWindowMs: number;

  constructor(deps: DeviceServiceDeps) {
    this.devices = deps.devices;
    this.sites = deps.sites;
    this.appendAudit = deps.appendAudit;
    this.now = deps.now ?? (() => new Date());
    this.onlineWindowMs = deps.onlineWindowMs ?? DEFAULT_ONLINE_WINDOW_MS;
  }

  /**
   * 指定サイト配下の受付端末一覧を返す。サイト境界 read 認可が必要。
   * site_manager は権限のあるサイトのみ。テナント越境は拒否。
   */
  async list(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
  ): Promise<ServiceResult<DeviceView[]>> {
    if (!canAccessSite(actor, tenantId, siteId, 'read'))
      return fail('forbidden', 'actor cannot access this site');
    const devices = await this.devices.listDevices(tenantId, siteId);
    return { ok: true, value: devices.map((d) => this.toView(d)) };
  }

  /** 単一端末を取得する。サイト境界 read 認可が必要（端末の siteId で判定）。 */
  async get(
    actor: Actor,
    tenantId: TenantId,
    id: DeviceId,
  ): Promise<ServiceResult<DeviceView>> {
    const found = await this.devices.getDevice(tenantId, id);
    if (!found) return fail('not_found', 'device not found');
    if (!canAccessSite(actor, tenantId, found.siteId, 'read'))
      return fail('forbidden', 'actor cannot access this device');
    return { ok: true, value: this.toView(found) };
  }

  /**
   * 受付端末を登録する。対象サイトへの write 認可が必要（site_manager は自サイトのみ可）。
   * 親サイトの存在を確認する。token はここでは発行せず（tokenRegistered=false）、
   * 別途 reissueToken で登録する運用にする。
   */
  async create(actor: Actor, input: CreateDeviceInput): Promise<ServiceResult<DeviceView>> {
    if (!canAccessSite(actor, input.tenantId, input.siteId, 'write'))
      return fail('forbidden', 'actor cannot create devices in this site');
    const site = await this.sites.getSite(input.tenantId, input.siteId);
    if (!site) return fail('not_found', 'site not found');
    const name = input.name.trim();
    if (name === '') return fail('invalid_input', 'name is required');

    const nowIso = this.now().toISOString();
    const device: Device = {
      id: asDeviceId(`device-${randomUUID()}`),
      tenantId: input.tenantId,
      siteId: input.siteId,
      name,
      status: 'active',
      location: input.location?.trim() || undefined,
      kind: input.kind ?? 'kiosk',
      maintenance: false,
      tokenRegistered: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const created = await this.devices.createDevice(device);
    if (!created.ok) return fail('invalid_input', created.error.message);
    return { ok: true, value: this.toView(created.value) };
  }

  /** 端末の表示メタ（名称・設置場所・種別・メンテ表示）を更新する。サイト write 認可が必要。 */
  async update(
    actor: Actor,
    tenantId: TenantId,
    id: DeviceId,
    patch: UpdateDevicePatch,
  ): Promise<ServiceResult<DeviceView>> {
    const found = await this.devices.getDevice(tenantId, id);
    if (!found) return fail('not_found', 'device not found');
    if (!canAccessSite(actor, tenantId, found.siteId, 'write'))
      return fail('forbidden', 'actor cannot write to this device');

    let name = found.name;
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (trimmed === '') return fail('invalid_input', 'name must not be empty');
      name = trimmed;
    }
    const next: Device = {
      ...found,
      name,
      location:
        patch.location !== undefined ? patch.location.trim() || undefined : found.location,
      kind: patch.kind ?? found.kind,
      maintenance: patch.maintenance ?? found.maintenance,
      updatedAt: this.now().toISOString(),
    };
    await this.devices.putDevice(next);
    return { ok: true, value: this.toView(next) };
  }

  /**
   * 端末の有効 / 無効を切り替える（危険操作）。サイト write 認可が必要。
   * 監査: device.enabled / device.disabled（token 値は残さない）。
   */
  async setEnabled(
    actor: Actor,
    tenantId: TenantId,
    id: DeviceId,
    enabled: boolean,
  ): Promise<ServiceResult<DeviceView>> {
    const found = await this.devices.getDevice(tenantId, id);
    if (!found) return fail('not_found', 'device not found');
    if (!canAccessSite(actor, tenantId, found.siteId, 'write'))
      return fail('forbidden', 'actor cannot write to this device');

    const next: Device = {
      ...found,
      status: enabled ? 'active' : 'revoked',
      updatedAt: this.now().toISOString(),
    };
    await this.devices.putDevice(next);
    await this.audit(enabled ? 'device.enabled' : 'device.disabled', next);
    return { ok: true, value: this.toView(next) };
  }

  /**
   * 端末 token を再発行する（危険操作・確認ダイアログ前提は UI 側）。
   * サイト write 認可が必要。token の平文は **レスポンスにも監査にも残さない**。
   * 本増分は tokenRegistered=true を立てるところまで（実 token 発行・配布は次増分）。
   * 監査: device.token_reissued（metadata は id/name/siteId のみ）。
   */
  async reissueToken(
    actor: Actor,
    tenantId: TenantId,
    id: DeviceId,
  ): Promise<ServiceResult<DeviceView>> {
    const found = await this.devices.getDevice(tenantId, id);
    if (!found) return fail('not_found', 'device not found');
    if (!canAccessSite(actor, tenantId, found.siteId, 'write'))
      return fail('forbidden', 'actor cannot reissue token for this device');

    const next: Device = {
      ...found,
      tokenRegistered: true,
      updatedAt: this.now().toISOString(),
    };
    await this.devices.putDevice(next);
    await this.audit('device.token_reissued', next);
    return { ok: true, value: this.toView(next) };
  }

  /**
   * Kiosk→Device 統合の read 経路 (issue #87 inc3)。
   *
   * 既存 kiosk heartbeat（/api/kiosk/heartbeat, #30）から呼び、kiosk id に一致する
   * Device の `lastSeenAt` を更新する。これにより Device 側の稼働状態（online/offline）が
   * 実際の端末活動を反映する（inc2 までは lastSeenAt が常に未設定で offline 固定だった）。
   *
   * 設計上の注意:
   *   - 認可しない。これは端末自身の定期確認パスであり、管理 actor は介在しない。
   *     既存 kiosk heartbeat が認可なしなのと同じ扱い。
   *   - テナント文脈を持たないため id 一致のみで解決する（findDeviceById）。更新は
   *     その 1 件の lastSeenAt に限定し、テナント/サイト境界は崩さない。
   *   - 監査しない（高頻度イベントのため。AuditAction も増やさない）。
   *   - 対応 Device が無い kiosk（旧レジストリのみの端末）は no-op で握りつぶさず
   *     `matched: false` を返す。呼び出し側は heartbeat 応答を止めない（best-effort）。
   */
  async recordHeartbeat(
    kioskId: string,
    seenAt?: Date,
  ): Promise<{ matched: boolean }> {
    const trimmed = kioskId.trim();
    if (trimmed === '') return { matched: false };
    const device = await this.devices.findDeviceById(asDeviceId(trimmed));
    if (!device) return { matched: false };
    const next: Device = {
      ...device,
      lastSeenAt: (seenAt ?? this.now()).toISOString(),
    };
    await this.devices.putDevice(next);
    return { matched: true };
  }

  /** Device → DeviceView。token 平文は持ち込まない（型上も存在しない）。 */
  private toView(device: Device): DeviceView {
    return {
      ...device,
      connectivity: deriveConnectivity(device, this.now(), this.onlineWindowMs),
    };
  }

  /** PII を含めない監査記録。token 値は決して metadata に入れない。 */
  private async audit(action: AuditAction, device: Device): Promise<void> {
    await this.appendAudit(action, { type: 'device', id: device.id }, {
      name: device.name,
      siteId: device.siteId,
      status: device.status,
    });
  }
}
