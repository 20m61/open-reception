/**
 * 来訪予約サービス (issue #97, increment 1)。
 *
 * リポジトリ・ライフサイクル純関数・監査ログ・テナント認可を束ねる薄い層。
 * route ハンドラから呼び出す。副作用（永続化・監査）はここに閉じ込め、判定は
 * 可能な限り純関数（src/domain/reservation/lifecycle.ts, src/domain/tenant/authorization.ts）
 * へ委譲する。
 *
 * 監査ログには PII（visitorName / companyName / note）を残さない。残すのは
 * 予約 id・対象種別・操作のみ（docs/audit-logging.md と整合）。
 */
import { randomUUID } from 'node:crypto';
import { canAccessSite } from '@/domain/tenant/authorization';
import type { Actor } from '@/domain/tenant/authorization';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { AuditAction } from '@/domain/reception/log';
import {
  applyEdit,
  applyReissue,
  cancelReservation,
  markExpiredIfNeeded,
  revokeReservation,
  validateCreateInput,
  type ReservationResult,
} from '@/domain/reservation/lifecycle';
import {
  asReservationId,
  type CreateReservationInput,
  type EditReservationPatch,
  type ReservationId,
  type VisitReservation,
} from '@/domain/reservation/types';
import { generateReservationToken } from '@/domain/reservation/token';
import type { ReservationRepository } from './repository';

export type ServiceError = {
  code: 'invalid_input' | 'invalid_state' | 'not_found' | 'forbidden';
  message: string;
};
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

function fail(code: ServiceError['code'], message: string): ServiceResult<never> {
  return { ok: false, error: { code, message } };
}

/** 監査ログ追記の関数型（テストで差し替え可能にし、global backend 依存を切り離す）。 */
export type AppendAudit = (
  action: AuditAction,
  target: { type: string; id?: string },
  metadata?: Record<string, string>,
) => Promise<unknown>;

export type ReservationServiceDeps = {
  repo: ReservationRepository;
  appendAudit: AppendAudit;
  now?: () => Date;
};

/** lifecycle の ReservationResult を ServiceResult へ写す。 */
function fromLifecycle<T>(r: ReservationResult<T>): ServiceResult<T> {
  return r.ok ? r : fail(r.error.code, r.error.message);
}

export class ReservationService {
  private readonly repo: ReservationRepository;
  private readonly appendAudit: AppendAudit;
  private readonly now: () => Date;

  constructor(deps: ReservationServiceDeps) {
    this.repo = deps.repo;
    this.appendAudit = deps.appendAudit;
    this.now = deps.now ?? (() => new Date());
  }

  /** サイト境界の認可。op は read/write。失敗時は forbidden。 */
  private authorize(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    op: 'read' | 'write',
  ): ServiceResult<true> {
    return canAccessSite(actor, tenantId, siteId, op)
      ? { ok: true, value: true }
      : fail('forbidden', 'actor cannot access this site');
  }

  async list(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
  ): Promise<ServiceResult<VisitReservation[]>> {
    const auth = this.authorize(actor, tenantId, siteId, 'read');
    if (!auth.ok) return auth;
    return { ok: true, value: await this.repo.list(tenantId, siteId) };
  }

  async get(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    id: ReservationId,
  ): Promise<ServiceResult<VisitReservation>> {
    const auth = this.authorize(actor, tenantId, siteId, 'read');
    if (!auth.ok) return auth;
    const found = await this.repo.get(tenantId, siteId, id);
    return found ? { ok: true, value: found } : fail('not_found', 'reservation not found');
  }

  /** 予約を作成し、token を発行する。作成と token 発行を監査に残す。 */
  async create(
    actor: Actor,
    input: CreateReservationInput,
  ): Promise<ServiceResult<VisitReservation>> {
    const auth = this.authorize(actor, input.tenantId, input.siteId, 'write');
    if (!auth.ok) return auth;
    const validated = validateCreateInput(input);
    if (!validated.ok) return fail(validated.error.code, validated.error.message);

    const nowIso = this.now().toISOString();
    const reservation: VisitReservation = {
      id: asReservationId(`rsv-${randomUUID()}`),
      tenantId: input.tenantId,
      siteId: input.siteId,
      visitorName: input.visitorName.trim(),
      companyName: input.companyName?.trim() || undefined,
      visitAt: input.visitAt,
      note: input.note?.trim() || undefined,
      targetType: input.targetType,
      targetId: input.targetId,
      token: generateReservationToken(),
      usagePolicy: input.usagePolicy,
      expiresAt: input.expiresAt,
      status: 'active',
      retentionDays: input.retentionDays,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const created = await this.repo.create(reservation);
    if (!created.ok) return fail('invalid_state', created.error.message);

    await this.audit('reservation.created', reservation);
    await this.audit('reservation.token_issued', reservation);
    return { ok: true, value: created.value };
  }

  async edit(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    id: ReservationId,
    patch: EditReservationPatch,
  ): Promise<ServiceResult<VisitReservation>> {
    const current = await this.loadForWrite(actor, tenantId, siteId, id);
    if (!current.ok) return current;
    const next = fromLifecycle(applyEdit(current.value, patch, this.now()));
    if (!next.ok) return next;
    await this.repo.put(next.value);
    await this.audit('reservation.updated', next.value);
    return next;
  }

  async cancel(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    id: ReservationId,
  ): Promise<ServiceResult<VisitReservation>> {
    const current = await this.loadForWrite(actor, tenantId, siteId, id);
    if (!current.ok) return current;
    const next = fromLifecycle(cancelReservation(current.value, this.now()));
    if (!next.ok) return next;
    await this.repo.put(next.value);
    await this.audit('reservation.cancelled', next.value);
    return next;
  }

  async revoke(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    id: ReservationId,
  ): Promise<ServiceResult<VisitReservation>> {
    const current = await this.loadForWrite(actor, tenantId, siteId, id);
    if (!current.ok) return current;
    const next = fromLifecycle(revokeReservation(current.value, this.now()));
    if (!next.ok) return next;
    await this.repo.put(next.value);
    await this.audit('reservation.revoked', next.value);
    return next;
  }

  /**
   * QR 再発行: 新しい token と有効期限を発行し、旧トークンを失効する。
   * 同一予約レコードに新トークンを適用し（旧トークンは無効化される）、監査に残す。
   */
  async reissueToken(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    id: ReservationId,
    newExpiresAt: string,
  ): Promise<ServiceResult<VisitReservation>> {
    const current = await this.loadForWrite(actor, tenantId, siteId, id);
    if (!current.ok) return current;
    const reissued = fromLifecycle(
      applyReissue(current.value, generateReservationToken(), newExpiresAt, this.now()),
    );
    if (!reissued.ok) return reissued;
    await this.repo.put(reissued.value);
    await this.audit('reservation.token_reissued', reissued.value);
    return reissued;
  }

  /** write 認可 + 取得 + 期限切れ反映をまとめる。 */
  private async loadForWrite(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    id: ReservationId,
  ): Promise<ServiceResult<VisitReservation>> {
    const auth = this.authorize(actor, tenantId, siteId, 'write');
    if (!auth.ok) return auth;
    const found = await this.repo.get(tenantId, siteId, id);
    if (!found) return fail('not_found', 'reservation not found');
    // 期限切れを参照時に永続反映（active のままにしない）。
    const expired = markExpiredIfNeeded(found, this.now());
    if (expired.ok && expired.value !== found && expired.value.status !== found.status) {
      await this.repo.put(expired.value);
      return { ok: true, value: expired.value };
    }
    return { ok: true, value: found };
  }

  /** PII を含めない監査記録。actor は呼び出し側（route）で admin に固定。 */
  private async audit(action: AuditAction, r: VisitReservation): Promise<void> {
    await this.appendAudit(action, { type: 'reservation', id: r.id }, {
      targetType: r.targetType,
      usagePolicy: r.usagePolicy,
      status: r.status,
    });
  }
}
