/**
 * 滞在状態サービス (issue #102, increment 1)。
 *
 * リポジトリ・状態遷移純関数・監査ログ・テナント認可を束ねる薄い層。
 * route ハンドラから呼び出す。副作用（永続化・監査）はここに閉じ込め、判定は
 * 純関数（src/domain/visit/state.ts, src/domain/tenant/authorization.ts）へ委譲する。
 *
 * 監査ログには PII を残さない。残すのは滞在 id・状態・滞在時間のバケットのみ
 * （docs/checkout-stay-design.md §3、docs/audit-logging.md と整合）。
 */
import { randomUUID } from 'node:crypto';
import { canAccessSite } from '@/domain/tenant/authorization';
import type { Actor } from '@/domain/tenant/authorization';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { AuditAction } from '@/domain/reception/log';
import {
  cancelStay,
  checkOut,
  type StayResult,
} from '@/domain/visit/state';
import {
  asStayId,
  type CreateStayInput,
  type StayId,
  type VisitStay,
} from '@/domain/visit/types';
import type { StayRepository } from './repository';

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

export type StayServiceDeps = {
  repo: StayRepository;
  appendAudit: AppendAudit;
  now?: () => Date;
};

const DEFAULT_RETENTION_DAYS = 30;

/** state の StayResult を ServiceResult へ写す。 */
function fromState<T>(r: StayResult<T>): ServiceResult<T> {
  return r.ok ? r : fail(r.error.code, r.error.message);
}

/**
 * 滞在時間をバケット化する（監査メタに生値を残さないための非 PII 化）。
 * 個人の行動を分単位で追跡可能にしない粒度に丸める。
 */
export function durationBucket(durationMs: number | undefined): string {
  if (durationMs === undefined) return 'unknown';
  const minutes = durationMs / 60000;
  if (minutes < 15) return 'lt_15m';
  if (minutes < 60) return 'lt_1h';
  if (minutes < 240) return 'lt_4h';
  if (minutes < 480) return 'lt_8h';
  return 'gte_8h';
}

export class StayService {
  private readonly repo: StayRepository;
  private readonly appendAudit: AppendAudit;
  private readonly now: () => Date;

  constructor(deps: StayServiceDeps) {
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
  ): Promise<ServiceResult<VisitStay[]>> {
    const auth = this.authorize(actor, tenantId, siteId, 'read');
    if (!auth.ok) return auth;
    return { ok: true, value: await this.repo.list(tenantId, siteId) };
  }

  async get(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    id: StayId,
  ): Promise<ServiceResult<VisitStay>> {
    const auth = this.authorize(actor, tenantId, siteId, 'read');
    if (!auth.ok) return auth;
    const found = await this.repo.get(tenantId, siteId, id);
    return found ? { ok: true, value: found } : fail('not_found', 'stay not found');
  }

  /**
   * 在館記録を作成する（present で起票）。PII は持たない。
   * actor 認可後に作成し、起票を監査に残す。
   */
  async createPresent(actor: Actor, input: CreateStayInput): Promise<ServiceResult<VisitStay>> {
    const auth = this.authorize(actor, input.tenantId, input.siteId, 'write');
    if (!auth.ok) return auth;

    const nowIso = this.now().toISOString();
    const stay: VisitStay = {
      id: asStayId(`stay-${randomUUID()}`),
      tenantId: input.tenantId,
      siteId: input.siteId,
      status: 'present',
      checkedInAt: input.checkedInAt ?? nowIso,
      reservationId: input.reservationId,
      receptionId: input.receptionId,
      targetLabel: input.targetLabel,
      purpose: input.purpose,
      retentionDays: input.retentionDays ?? DEFAULT_RETENTION_DAYS,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const created = await this.repo.create(stay);
    if (!created.ok) return fail('invalid_state', created.error.message);
    await this.audit('stay.updated', created.value);
    return { ok: true, value: created.value };
  }

  /** 退館チェックアウト（present → checked_out）。二重退館は invalid_state。 */
  async checkOut(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    id: StayId,
  ): Promise<ServiceResult<VisitStay>> {
    const current = await this.loadForWrite(actor, tenantId, siteId, id);
    if (!current.ok) return current;
    const next = fromState(checkOut(current.value, this.now()));
    if (!next.ok) return next;
    await this.repo.put(next.value);
    await this.audit('visitor.checked_out', next.value);
    return next;
  }

  /** 取消（誤登録の訂正、present → cancelled）。 */
  async cancel(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    id: StayId,
  ): Promise<ServiceResult<VisitStay>> {
    const current = await this.loadForWrite(actor, tenantId, siteId, id);
    if (!current.ok) return current;
    const next = fromState(cancelStay(current.value, this.now()));
    if (!next.ok) return next;
    await this.repo.put(next.value);
    await this.audit('stay.updated', next.value);
    return next;
  }

  /** write 認可 + 取得をまとめる。 */
  private async loadForWrite(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    id: StayId,
  ): Promise<ServiceResult<VisitStay>> {
    const auth = this.authorize(actor, tenantId, siteId, 'write');
    if (!auth.ok) return auth;
    const found = await this.repo.get(tenantId, siteId, id);
    if (!found) return fail('not_found', 'stay not found');
    return { ok: true, value: found };
  }

  /** PII を含めない監査記録（状態・滞在時間バケットのみ）。 */
  private async audit(action: AuditAction, s: VisitStay): Promise<void> {
    await this.appendAudit(action, { type: 'stay', id: s.id }, {
      status: s.status,
      durationBucket: durationBucket(s.durationMs),
    });
  }
}
