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
import {
  DEFAULT_ONLINE_WINDOW_MS,
  deriveConnectivity,
  type DeviceConnectivity,
} from '@/domain/tenant/device-liveness';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditAction } from '@/domain/reception/log';
import {
  issueEnrollmentToken,
  newEnrollmentJti,
  type EnrollmentClaims,
} from '@/lib/auth/kiosk-enrollment';
import {
  asDeviceId,
  asTenantId,
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

// 稼働状態の派生は #261 で純ドメイン（src/domain/tenant/device-liveness.ts）へ移設した。
// SiteService / fleet 集計と同一ロジックを共有する。既存 import 互換のため再輸出する。
export {
  DEFAULT_ONLINE_WINDOW_MS,
  deriveConnectivity,
  type DeviceConnectivity,
} from '@/domain/tenant/device-liveness';

/** 一覧/詳細レスポンス。token 平文は含めない（tokenRegistered の真偽のみ）。 */
export type DeviceView = Device & {
  /** 派生した稼働状態。 */
  connectivity: DeviceConnectivity;
};

/**
 * エンロール発行の結果。`enrollment` は **一過性**（一度だけ返す）。
 * 平文 token は永続化・監査・再取得しない（docs/reception-issuance-design.md §3）。
 */
export type EnrollmentIssue = {
  view: DeviceView;
  enrollment: { token: string; expiresAt: string };
};

/** consumeEnrollment の失敗理由。enroll API の HTTP マッピングに使う。 */
export type ConsumeFailure = 'not_found' | 'used' | 'revoked';

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
   * 別途 issueEnrollment（受付 URL/QR 発行）で登録する運用にする。
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
   *
   * 有効/無効の切替は **保留中のエンロール URL を必ず無効化**する（`enrollmentTokenId` を消去）。
   * これがないと「URL を止めるために revoke → TTL 内に再有効化」で旧 URL が復活してしまう。
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
      enrollmentTokenId: undefined,
      updatedAt: this.now().toISOString(),
    };
    await this.devices.putDevice(next);
    await this.audit(enabled ? 'device.enabled' : 'device.disabled', next);
    return { ok: true, value: this.toView(next) };
  }

  /**
   * 受付 URL/QR 用のエンロールトークンを発行する（危険操作・確認ダイアログ前提は UI 側）。
   * サイト write 認可が必要。新 jti を採番して `enrollmentTokenId` に保存し（旧 URL を無効化）、
   * `tokenRegistered=true` を立てる。
   *
   * セキュリティ: 平文トークンは `enrollment`（一過性フィールド）でのみ一度返す。**view・監査・
   * 永続化のいずれにも平文を出さない**（docs/reception-issuance-design.md §3, #105）。
   * 監査: device.token_reissued（metadata は id/name/siteId/status のみ）。
   */
  async issueEnrollment(
    actor: Actor,
    tenantId: TenantId,
    id: DeviceId,
    ttlMs?: number,
  ): Promise<ServiceResult<EnrollmentIssue>> {
    const found = await this.devices.getDevice(tenantId, id);
    if (!found) return fail('not_found', 'device not found');
    if (!canAccessSite(actor, tenantId, found.siteId, 'write'))
      return fail('forbidden', 'actor cannot issue enrollment for this device');

    const jti = newEnrollmentJti();
    const { token, expiresAt } = await issueEnrollmentToken(
      { tenantId: String(tenantId), siteId: String(found.siteId), deviceId: String(found.id), jti },
      ttlMs,
      this.now().getTime(),
    );
    const next: Device = {
      ...found,
      tokenRegistered: true,
      enrollmentTokenId: jti,
      updatedAt: this.now().toISOString(),
    };
    await this.devices.putDevice(next);
    await this.audit('device.token_reissued', next);
    return { ok: true, value: { view: this.toView(next), enrollment: { token, expiresAt } } };
  }

  /**
   * エンロールトークンを消費し、kiosk セッション交換用の kioskId を返す。
   *
   * 受付端末自身のパス（/api/kiosk/enroll）から呼ぶ。管理 actor は介在しないため認可しない
   * （recordHeartbeat / kiosk authorize と同じ扱い）。守りは署名（呼び出し側で検証済み）・単回性・
   * 端末状態で行う。単回性: `jti === enrollmentTokenId` の時のみ成功し、成功時に消去する。
   *   - 端末なし → not_found / jti 不一致（消費済 or 再発行後）→ used / revoked → revoked。
   * 成功時に lastSeenAt を更新する（初回起動を稼働反映）。監査しない（端末起動の高頻度パス）。
   */
  async consumeEnrollment(
    claims: EnrollmentClaims,
  ): Promise<{ ok: true; kioskId: string } | { ok: false; reason: ConsumeFailure }> {
    const tenantId = asTenantId(claims.tenantId);
    const device = await this.devices.getDevice(tenantId, asDeviceId(claims.deviceId));
    if (!device) return { ok: false, reason: 'not_found' };
    if (!device.enrollmentTokenId || device.enrollmentTokenId !== claims.jti)
      return { ok: false, reason: 'used' };
    if (device.status === 'revoked') return { ok: false, reason: 'revoked' };

    // 消去は **条件付き部分更新**（enrollmentTokenId === jti のときのみ）で原子的に行う。同一 URL の
    // 同時アクセスで上の read チェックを両者が通過しても、書込で勝てるのは 1 つだけ → 二重消費を防ぐ。
    // アイテム全体は置換せず該当フィールドのみ更新するため lost-update も避ける (issue #239)。
    const won = await this.devices.consumeEnrollment(
      asDeviceId(claims.deviceId),
      claims.jti,
      this.now().toISOString(),
    );
    if (!won) {
      // 競合で書込に負けた。再読込で割り込みの種類を区別する（used と取り違えない）。
      const after = await this.devices.getDevice(tenantId, asDeviceId(claims.deviceId));
      if (!after) return { ok: false, reason: 'not_found' }; // 間に削除された。
      if (after.status === 'revoked') return { ok: false, reason: 'revoked' };
      return { ok: false, reason: 'used' };
    }
    return { ok: true, kioskId: String(device.id) };
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
    // lastSeenAt **のみ**を部分更新する。全置換 put だと read→write 間に consumeEnrollment が消去した
    // enrollmentTokenId を stale 値で書き戻し、消費済トークンを復活させ得る (issue #239)。
    await this.devices.touchLastSeen(device.id, (seenAt ?? this.now()).toISOString());
    return { matched: true };
  }

  /**
   * kiosk レジストリ（#18）のみに存在する端末を Device レジストリへ取り込む (issue #261)。
   *
   * Device を source-of-truth へ寄せる片方向同期（docs/site-device-management-design.md
   * §Device/Kiosk 統合方針）。heartbeat 経路（/api/kiosk/heartbeat）から、recordHeartbeat が
   * matched:false（対応 Device なし）のときに呼ばれる。これで kiosk-only の実機も
   * 死活集計（summarizeFleet）の実 heartbeat に載る（#260 撤回理由 1 の恒久解）。
   *
   * 設計上の注意:
   *   - 認可しない（端末自身のパス）。ただし **呼び出し側が kiosk レジストリでの実在を確認**
   *     してから渡す契約とし、無認可 heartbeat からの任意行作成を防ぐ（登録済み kiosk 限定）。
   *   - id は kiosk と一致させる（統合方針の id 一致）。既存 Device がある場合は conflict で
   *     no-op（冪等・並行 heartbeat の競合も片方だけが作成に勝つ）。
   *   - enabled=false の kiosk は revoked として写像し、取り込みで勝手に有効化しない。
   *   - 監査しない（actor 不在のシステム由来同期。対象は管理者登録済み kiosk のみ）。
   */
  async adoptKiosk(
    kiosk: { id: string; displayName: string; location?: string; enabled: boolean },
    scope: { tenantId: TenantId; siteId: SiteId },
    seenAt?: Date,
  ): Promise<{ created: boolean }> {
    const id = kiosk.id.trim();
    const name = kiosk.displayName.trim();
    if (id === '' || name === '') return { created: false };
    const nowIso = this.now().toISOString();
    const created = await this.devices.createDevice({
      id: asDeviceId(id),
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      name,
      status: kiosk.enabled ? 'active' : 'revoked',
      location: kiosk.location?.trim() || undefined,
      kind: 'kiosk',
      maintenance: false,
      lastSeenAt: (seenAt ?? this.now()).toISOString(),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return { created: created.ok };
  }

  /**
   * kiosk 管理操作（/admin/kiosks の作成・setEnabled）を Device レジストリへ即時写像する
   * (issue #284 inc1 逆方向同期。adoptKiosk の heartbeat 起点取り込みを管理操作起点で補完)。
   *
   * 設計上の注意:
   *   - 対応 Device が無ければ adoptKiosk と同型で作成する。ただし **lastSeenAt は付けない**。
   *     管理操作は端末の稼働証跡ではないため、heartbeat 前の端末を偽 online にしない。
   *   - 既存 Device は **status のみ** enabled から写像する（enabled=false → revoked。#283 と
   *     同じ規則）。name/location は Device 側の編集（update）を正とし、kiosk 側で上書きしない。
   *   - status 切替時は保留中エンロール URL を無効化する（enrollmentTokenId 消去。
   *     setEnabled と同じ「revoke → 再有効化で旧 URL が復活しない」規則）。
   *   - 認可しない。呼び出し側（/api/admin/kiosks 系ルート）が requireActor + assertCanWrite
   *     で認可済みの管理操作に限って渡す契約。
   *   - 監査しない。管理操作そのものは既存の kiosk.created / kiosk.revoked / kiosk.restored で
   *     記録済みであり、写像で AuditAction を増やさない（二重記録を避ける）。
   *   - kiosk レジストリはテナントレスのため、解決は findDeviceById（id 一致）・作成先は
   *     呼び出し側が渡す既定スコープ（#283 と同じ既知の制約）。
   */
  async syncKioskState(
    kiosk: { id: string; displayName: string; location?: string; enabled: boolean },
    scope: { tenantId: TenantId; siteId: SiteId },
  ): Promise<{ created: boolean; updated: boolean }> {
    const id = kiosk.id.trim();
    const name = kiosk.displayName.trim();
    if (id === '' || name === '') return { created: false, updated: false };

    const existing = await this.devices.findDeviceById(asDeviceId(id));
    const status = kiosk.enabled ? 'active' : 'revoked';
    if (!existing) {
      const nowIso = this.now().toISOString();
      const created = await this.devices.createDevice({
        id: asDeviceId(id),
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        name,
        status,
        location: kiosk.location?.trim() || undefined,
        kind: 'kiosk',
        maintenance: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      return { created: created.ok, updated: false };
    }
    if (existing.status === status) return { created: false, updated: false };
    await this.devices.putDevice({
      ...existing,
      status,
      enrollmentTokenId: undefined,
      updatedAt: this.now().toISOString(),
    });
    return { created: false, updated: true };
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
