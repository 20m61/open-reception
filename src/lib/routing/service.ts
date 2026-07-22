/**
 * ルーティング設定サービス (issue #374, 残 increment)。
 *
 * 接続先（ContactEndpoint）とルーティングポリシー（RoutingPolicy）の永続化・テナント/サイト認可・
 * 検証・監査を束ねる薄い層。route ハンドラから呼び出す。純ロジック（`@/domain/routing/*`）へ
 * 委譲し、副作用（永続化・監査）はここに閉じ込める（ReceptionFlowService #100 と同じ責務分離）。
 *
 * 認可方針（#80 / `.claude/rules/admin-api-authz.md`）:
 *   - サイト付き資源: canAccessSite(read|write)。テナント横断資源（siteId 未設定）: canAccessTenant。
 *   - 作成/更新/削除は write（viewer 不可・他テナント越境不可・developer のみ横断）。
 *
 * 検証方針:
 *   - 接続先は `validateEndpoint`（channel↔アドレス整合、E.164/SIP 形式）。
 *   - ポリシーは保存前に `validateRoutingPolicySet`（テナント内の全ポリシー + 候補）で構造検証し、
 *     循環（fallback_cycle）・未登録 endpoint・不整合遷移を **保存時に拒否**（invalid_input + issues）。
 *
 * PII 方針（`.claude/rules/pii-secret-minimization.md`）:
 *   - 接続アドレス（e164/uri）は API レスポンス（EndpointView）にも監査 metadata にも出さない。
 *     UI へは末尾数桁の `maskedAddress` のみ。
 */
import { randomUUID } from 'node:crypto';
import { canAccessSite, canAccessTenant, type Actor } from '@/domain/tenant/authorization';
import { asSiteId, type SiteId, type TenantId } from '@/domain/tenant/types';
import type { AuditAction } from '@/domain/reception/log';
import {
  endpointAddress,
  validateEndpoint,
  type ContactEndpoint,
} from '@/domain/routing/endpoint';
import {
  validateRoutingPolicySet,
  type RoutingPolicy,
  type RoutingPolicyIssue,
} from '@/domain/routing/policy';
import { describeRoutingPolicy } from '@/domain/routing/describe';
import type { ParsedRoutingPolicyBody } from './input';
import type { ContactEndpointRepository, RoutingPolicyRepository } from './repository';
import type { EndpointView, PolicyView, StoredContactEndpoint, StoredRoutingPolicy } from './types';

export type ServiceError = {
  code: 'invalid_input' | 'not_found' | 'forbidden' | 'conflict';
  message: string;
  /** ポリシー構造検証で拒否したときの詳細（フィールド別表示に使う）。 */
  issues?: RoutingPolicyIssue[];
};
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

function fail(code: ServiceError['code'], message: string, issues?: RoutingPolicyIssue[]): ServiceResult<never> {
  return { ok: false, error: { code, message, issues } };
}

/** 監査ログ追記の関数型（テストで差し替え可能）。 */
export type AppendAudit = (
  action: AuditAction,
  target: { type: string; id?: string },
  metadata?: Record<string, string>,
) => Promise<unknown>;

export type RoutingServiceDeps = {
  endpoints: ContactEndpointRepository;
  policies: RoutingPolicyRepository;
  appendAudit: AppendAudit;
  now?: () => Date;
  newId?: () => string;
};

export type CreateEndpointInput = {
  tenantId: TenantId;
  siteId?: SiteId;
  /** 信頼できない接続先入力（id はサーバで採番するため無視する）。 */
  raw: unknown;
};

export type UpdateEndpointPatch = {
  label?: string | null;
  enabled?: boolean;
  ownerId?: string;
  /** 変更後のアドレス（現行 channel に対応する E.164 / SIP URI）。未指定なら据え置き。 */
  address?: string;
};

export type CreatePolicyInput = {
  tenantId: TenantId;
  body: ParsedRoutingPolicyBody;
};

/** アドレスの機微値を伏せる（末尾 4 桁のみ残す）。 */
export function maskAddress(value: string): string {
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

export class RoutingService {
  private readonly endpoints: ContactEndpointRepository;
  private readonly policies: RoutingPolicyRepository;
  private readonly appendAudit: AppendAudit;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: RoutingServiceDeps) {
    this.endpoints = deps.endpoints;
    this.policies = deps.policies;
    this.appendAudit = deps.appendAudit;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  // ---- 認可ヘルパ（サイト付きは canAccessSite、テナント横断は canAccessTenant）----
  private canAccess(actor: Actor, tenantId: TenantId, siteId: string | undefined, op: 'read' | 'write'): boolean {
    if (siteId === undefined) return canAccessTenant(actor, tenantId, op);
    return canAccessSite(actor, tenantId, asSiteId(siteId), op);
  }

  // ================= Endpoints =================

  async listEndpoints(actor: Actor, tenantId: TenantId, siteId?: SiteId): Promise<ServiceResult<EndpointView[]>> {
    const all = await this.endpoints.list(tenantId, siteId);
    const visible = all.filter((e) => this.canAccess(actor, tenantId, e.siteId, 'read'));
    return { ok: true, value: visible.map(toEndpointView) };
  }

  async getEndpoint(actor: Actor, tenantId: TenantId, id: string): Promise<ServiceResult<EndpointView>> {
    const found = await this.endpoints.get(tenantId, id);
    if (!found) return fail('not_found', 'endpoint not found');
    if (!this.canAccess(actor, tenantId, found.siteId, 'read')) return fail('forbidden', 'cannot read endpoint');
    return { ok: true, value: toEndpointView(found) };
  }

  async createEndpoint(actor: Actor, input: CreateEndpointInput): Promise<ServiceResult<EndpointView>> {
    if (!this.canAccess(actor, input.tenantId, input.siteId ? String(input.siteId) : undefined, 'write'))
      return fail('forbidden', 'cannot create endpoints for this scope');

    // id はサーバ採番（クライアント指定を信用しない）。
    const raw =
      typeof input.raw === 'object' && input.raw !== null ? { ...(input.raw as Record<string, unknown>) } : {};
    raw.id = this.newId();
    const validated = validateEndpoint(raw);
    if (!validated.ok) return fail('invalid_input', validated.error.message);

    const nowIso = this.now().toISOString();
    const stored: StoredContactEndpoint = {
      ...validated.value,
      tenantId: String(input.tenantId),
      siteId: input.siteId ? String(input.siteId) : undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const created = await this.endpoints.create(stored);
    if (!created.ok) return fail(created.error.code === 'conflict' ? 'conflict' : 'invalid_input', created.error.message);
    await this.auditEndpoint('contact_endpoint.created', created.value);
    return { ok: true, value: toEndpointView(created.value) };
  }

  async updateEndpoint(
    actor: Actor,
    tenantId: TenantId,
    id: string,
    patch: UpdateEndpointPatch,
  ): Promise<ServiceResult<EndpointView>> {
    const found = await this.endpoints.get(tenantId, id);
    if (!found) return fail('not_found', 'endpoint not found');
    if (!this.canAccess(actor, tenantId, found.siteId, 'write')) return fail('forbidden', 'cannot write endpoint');

    // 変更候補を組み立て、アドレス変更時は channel 整合を再検証する。
    const candidateRaw: Record<string, unknown> = {
      id: found.id,
      ownerType: found.ownerType,
      ownerId: patch.ownerId !== undefined && patch.ownerId.trim() !== '' ? patch.ownerId.trim() : found.ownerId,
      providerKey: found.providerKey,
      enabled: patch.enabled !== undefined ? patch.enabled : found.enabled,
      channel: found.channel,
      label: patch.label === null ? undefined : patch.label !== undefined ? patch.label : found.label,
    };
    if (found.channel === 'pstn') candidateRaw.e164 = patch.address !== undefined ? patch.address : found.e164;
    else candidateRaw.uri = patch.address !== undefined ? patch.address : found.uri;

    const validated = validateEndpoint(candidateRaw);
    if (!validated.ok) return fail('invalid_input', validated.error.message);

    const next: StoredContactEndpoint = {
      ...validated.value,
      tenantId: found.tenantId,
      siteId: found.siteId,
      createdAt: found.createdAt,
      updatedAt: this.now().toISOString(),
    };
    await this.endpoints.put(next);
    await this.auditEndpoint('contact_endpoint.updated', next);
    return { ok: true, value: toEndpointView(next) };
  }

  async removeEndpoint(actor: Actor, tenantId: TenantId, id: string): Promise<ServiceResult<void>> {
    const found = await this.endpoints.get(tenantId, id);
    if (!found) return fail('not_found', 'endpoint not found');
    if (!this.canAccess(actor, tenantId, found.siteId, 'write')) return fail('forbidden', 'cannot delete endpoint');
    const removed = await this.endpoints.remove(tenantId, id);
    if (!removed.ok) return fail('not_found', removed.error.message);
    await this.auditEndpoint('contact_endpoint.deleted', found);
    return { ok: true, value: undefined };
  }

  // ================= Policies =================

  async listPolicies(actor: Actor, tenantId: TenantId, siteId?: SiteId): Promise<ServiceResult<PolicyView[]>> {
    const all = await this.policies.list(tenantId, siteId);
    const visible = all.filter((p) => this.canAccess(actor, tenantId, p.siteId, 'read'));
    const endpoints = await this.endpoints.list(tenantId);
    return { ok: true, value: visible.map((p) => toPolicyView(p, endpoints)) };
  }

  async getPolicy(actor: Actor, tenantId: TenantId, id: string): Promise<ServiceResult<PolicyView>> {
    const found = await this.policies.get(tenantId, id);
    if (!found) return fail('not_found', 'policy not found');
    if (!this.canAccess(actor, tenantId, found.siteId, 'read')) return fail('forbidden', 'cannot read policy');
    const endpoints = await this.endpoints.list(tenantId);
    return { ok: true, value: toPolicyView(found, endpoints) };
  }

  async createPolicy(actor: Actor, input: CreatePolicyInput): Promise<ServiceResult<PolicyView>> {
    const { tenantId, body } = input;
    if (!this.canAccess(actor, tenantId, body.siteId, 'write'))
      return fail('forbidden', 'cannot create policies for this scope');

    const nowIso = this.now().toISOString();
    const candidate: StoredRoutingPolicy = {
      id: this.newId(),
      tenantId: String(tenantId),
      siteId: body.siteId,
      name: body.name,
      steps: body.steps,
      fallbackPolicyId: body.fallbackPolicyId,
      enabled: body.enabled,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const issues = await this.validateCandidate(tenantId, candidate);
    if (issues.length > 0) return fail('invalid_input', 'routing policy is invalid', issues);

    const created = await this.policies.create(candidate);
    if (!created.ok) return fail(created.error.code === 'conflict' ? 'conflict' : 'invalid_input', created.error.message);
    await this.auditPolicy('routing_policy.created', created.value);
    const endpoints = await this.endpoints.list(tenantId);
    return { ok: true, value: toPolicyView(created.value, endpoints) };
  }

  async updatePolicy(
    actor: Actor,
    tenantId: TenantId,
    id: string,
    patch: Partial<ParsedRoutingPolicyBody>,
  ): Promise<ServiceResult<PolicyView>> {
    const found = await this.policies.get(tenantId, id);
    if (!found) return fail('not_found', 'policy not found');
    if (!this.canAccess(actor, tenantId, found.siteId, 'write')) return fail('forbidden', 'cannot write policy');

    const candidate: StoredRoutingPolicy = {
      ...found,
      name: patch.name !== undefined ? patch.name : found.name,
      siteId: patch.siteId !== undefined ? patch.siteId : found.siteId,
      steps: patch.steps !== undefined ? patch.steps : found.steps,
      enabled: patch.enabled !== undefined ? patch.enabled : found.enabled,
      fallbackPolicyId: 'fallbackPolicyId' in patch ? patch.fallbackPolicyId : found.fallbackPolicyId,
      updatedAt: this.now().toISOString(),
    };

    // siteId が変わった場合は新スコープの write も要る。
    if (patch.siteId !== undefined && !this.canAccess(actor, tenantId, patch.siteId, 'write'))
      return fail('forbidden', 'cannot move policy to this scope');

    const issues = await this.validateCandidate(tenantId, candidate);
    if (issues.length > 0) return fail('invalid_input', 'routing policy is invalid', issues);

    await this.policies.put(candidate);
    await this.auditPolicy('routing_policy.updated', candidate);
    const endpoints = await this.endpoints.list(tenantId);
    return { ok: true, value: toPolicyView(candidate, endpoints) };
  }

  async removePolicy(actor: Actor, tenantId: TenantId, id: string): Promise<ServiceResult<void>> {
    const found = await this.policies.get(tenantId, id);
    if (!found) return fail('not_found', 'policy not found');
    if (!this.canAccess(actor, tenantId, found.siteId, 'write')) return fail('forbidden', 'cannot delete policy');
    const removed = await this.policies.remove(tenantId, id);
    if (!removed.ok) return fail('not_found', removed.error.message);
    await this.auditPolicy('routing_policy.deleted', found);
    return { ok: true, value: undefined };
  }

  /**
   * 候補ポリシーをテナント内の既存ポリシー集合に重ねて構造検証し、**候補に関わる** issue のみ返す。
   * fallback 循環は候補が属する循環ノードに fallback_cycle issue が立つため、候補 id で拾える。
   */
  private async validateCandidate(tenantId: TenantId, candidate: StoredRoutingPolicy): Promise<RoutingPolicyIssue[]> {
    const endpoints = await this.endpoints.list(tenantId);
    const endpointIds = new Set(endpoints.map((e) => e.id));
    const existing = await this.policies.list(tenantId);
    const merged: RoutingPolicy[] = [...existing.filter((p) => p.id !== candidate.id), candidate];
    return validateRoutingPolicySet(merged, endpointIds).filter((i) => i.policyId === candidate.id);
  }

  private async auditEndpoint(action: AuditAction, e: StoredContactEndpoint): Promise<void> {
    // アドレス（e164/uri）・label は監査へ残さない（PII 最小化）。
    await this.appendAudit(action, { type: 'contact_endpoint', id: e.id }, {
      channel: e.channel,
      ownerType: e.ownerType,
      ownerId: e.ownerId,
      providerKey: e.providerKey,
      enabled: String(e.enabled),
      ...(e.siteId ? { siteId: e.siteId } : {}),
    });
  }

  private async auditPolicy(action: AuditAction, p: StoredRoutingPolicy): Promise<void> {
    await this.appendAudit(action, { type: 'routing_policy', id: p.id }, {
      name: p.name,
      enabled: String(p.enabled),
      stepCount: String(p.steps.length),
      hasFallback: String(p.fallbackPolicyId !== undefined),
      ...(p.siteId ? { siteId: p.siteId } : {}),
    });
  }
}

/** 保存接続先 → API ビュー（アドレスをマスクし、e164/uri を構造的に落とす）。 */
export function toEndpointView(e: StoredContactEndpoint): EndpointView {
  return {
    id: e.id,
    tenantId: e.tenantId,
    siteId: e.siteId,
    ownerType: e.ownerType,
    ownerId: e.ownerId,
    channel: e.channel,
    providerKey: e.providerKey,
    enabled: e.enabled,
    label: e.label,
    maskedAddress: maskAddress(endpointAddress(e)),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** 保存ポリシー + テナントの接続先 → 文章形式説明つき API ビュー。 */
export function toPolicyView(p: StoredRoutingPolicy, endpoints: ReadonlyArray<ContactEndpoint>): PolicyView {
  return { ...p, description: describeRoutingPolicy(p, endpoints as ContactEndpoint[]) };
}
