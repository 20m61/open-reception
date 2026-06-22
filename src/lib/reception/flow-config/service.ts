/**
 * 受付フロー設定サービス (issue #100, increment 1)。
 *
 * リポジトリ・テナント/サイト認可・監査ログを束ねる薄い層。route ハンドラから呼び出す。
 * フロー定義の検証は純ドメイン（src/domain/reception/custom-flow.ts）へ、認可判定は
 * 純関数（src/domain/tenant/authorization.ts）へ委譲し、副作用（永続化・監査）はここに
 * 閉じ込める（CallRouteService #88 と同じ責務分離）。
 *
 * 認可方針（#80）:
 *   - 一覧/取得: canAccessSite(read)（site_manager は担当サイトのみ）。
 *   - 作成/更新/削除: canAccessSite(write)（viewer 不可・他テナント越境不可）。
 *
 * 監査方針:
 *   - 設定変更を reception_flow.created / updated / deleted で記録する（事前定義済み）。
 *   - PII（来訪者の入力値）は監査に残さない。残すのは purposeKey・displayName・siteId・
 *     enabled・ステップ数・フィールド数のみ。フィールドのラベルは管理者定義のテンプレート
 *     だが、機微情報を避けるため監査には件数のみ残す。
 */
import { randomUUID } from 'node:crypto';
import {
  asReceptionFlowId,
  enabledFlowsForDisplay,
  validateCallRouteId,
  validateOptionalText,
  validateOrder,
  validateReceptionFlow,
  validateSteps,
  validateFields,
  validateDisplayName,
  type ReceptionFlowId,
} from '@/domain/reception/custom-flow';
import { canAccessSite, type Actor } from '@/domain/tenant/authorization';
import type { AuditAction } from '@/domain/reception/log';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { ReceptionFlowRepository } from './repository';
import type {
  CreateReceptionFlowInput,
  StoredReceptionFlow,
  UpdateReceptionFlowPatch,
} from './types';

export type ServiceError = {
  code: 'invalid_input' | 'not_found' | 'forbidden' | 'conflict';
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

export type ReceptionFlowServiceDeps = {
  flows: ReceptionFlowRepository;
  appendAudit: AppendAudit;
  now?: () => Date;
};

const DESCRIPTION_MAX = 500;

export class ReceptionFlowService {
  private readonly flows: ReceptionFlowRepository;
  private readonly appendAudit: AppendAudit;
  private readonly now: () => Date;

  constructor(deps: ReceptionFlowServiceDeps) {
    this.flows = deps.flows;
    this.appendAudit = deps.appendAudit;
    this.now = deps.now ?? (() => new Date());
  }

  /** テナント配下のフロー一覧（siteId 指定時はそのサイトに絞る）。read 権限のあるサイトのみ。 */
  async list(
    actor: Actor,
    tenantId: TenantId,
    siteId?: SiteId,
  ): Promise<ServiceResult<StoredReceptionFlow[]>> {
    const all = await this.flows.listFlows(tenantId, siteId);
    const visible = all.filter((f) => canAccessSite(actor, tenantId, f.siteId, 'read'));
    return { ok: true, value: visible };
  }

  /**
   * 受付端末向け: 指定サイトの「有効な」フローのみを表示順で返す（actor 不要）。
   * 受付端末は kiosk セッションで scope（tenant/site）が確定するため、admin の
   * RoleAssignment 認可は適用しない（端末は当該サイトのフローのみ取得できる前提）。
   * フィルタ・整列は純ドメイン（enabledFlowsForDisplay）に委譲する。
   */
  async listEnabledForKiosk(
    tenantId: TenantId,
    siteId: SiteId,
  ): Promise<StoredReceptionFlow[]> {
    const all = await this.flows.listFlows(tenantId, siteId);
    return enabledFlowsForDisplay(all);
  }

  async get(
    actor: Actor,
    tenantId: TenantId,
    id: ReceptionFlowId,
  ): Promise<ServiceResult<StoredReceptionFlow>> {
    const found = await this.flows.getFlow(tenantId, id);
    if (!found) return fail('not_found', 'reception flow not found');
    if (!canAccessSite(actor, tenantId, found.siteId, 'read'))
      return fail('forbidden', 'actor cannot access this reception flow');
    return { ok: true, value: found };
  }

  /** フローを作成する。対象サイトへの write 認可が必要。 */
  async create(
    actor: Actor,
    input: CreateReceptionFlowInput,
  ): Promise<ServiceResult<StoredReceptionFlow>> {
    if (!canAccessSite(actor, input.tenantId, input.siteId, 'write'))
      return fail('forbidden', 'actor cannot create reception flows for this site');

    const validated = validateReceptionFlow(input);
    if (!validated.ok) return fail('invalid_input', validated.error.message);

    const nowIso = this.now().toISOString();
    const stored: StoredReceptionFlow = {
      id: asReceptionFlowId(`flow-${randomUUID()}`),
      tenantId: input.tenantId,
      siteId: input.siteId,
      ...validated.value,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const created = await this.flows.createFlow(stored);
    if (!created.ok)
      return fail(created.error.code === 'conflict' ? 'conflict' : 'invalid_input', created.error.message);
    await this.audit('reception_flow.created', created.value);
    return { ok: true, value: created.value };
  }

  /** 表示名・説明・順序・ステップ・フィールド・完了文・有効無効を更新する。write 認可必要。 */
  async update(
    actor: Actor,
    tenantId: TenantId,
    id: ReceptionFlowId,
    patch: UpdateReceptionFlowPatch,
  ): Promise<ServiceResult<StoredReceptionFlow>> {
    const found = await this.flows.getFlow(tenantId, id);
    if (!found) return fail('not_found', 'reception flow not found');
    if (!canAccessSite(actor, tenantId, found.siteId, 'write'))
      return fail('forbidden', 'actor cannot write to this reception flow');

    const next: StoredReceptionFlow = { ...found };

    if (patch.displayName !== undefined) {
      const v = validateDisplayName(patch.displayName);
      if (!v.ok) return fail('invalid_input', v.error.message);
      next.displayName = v.value;
    }
    if (patch.description !== undefined) {
      const v = validateOptionalText(patch.description, DESCRIPTION_MAX, 'description');
      if (!v.ok) return fail('invalid_input', v.error.message);
      next.description = v.value;
    }
    if (patch.order !== undefined) {
      const v = validateOrder(patch.order);
      if (!v.ok) return fail('invalid_input', v.error.message);
      next.order = v.value;
    }
    if (patch.steps !== undefined) {
      const v = validateSteps(patch.steps);
      if (!v.ok) return fail('invalid_input', v.error.message);
      next.steps = v.value;
    }
    if (patch.fields !== undefined) {
      const v = validateFields(patch.fields);
      if (!v.ok) return fail('invalid_input', v.error.message);
      next.fields = v.value;
    }
    if (patch.completionMessage !== undefined) {
      const v = validateOptionalText(patch.completionMessage, DESCRIPTION_MAX, 'completionMessage');
      if (!v.ok) return fail('invalid_input', v.error.message);
      next.completionMessage = v.value;
    }
    if (patch.callRouteId !== undefined) {
      const v = validateCallRouteId(patch.callRouteId);
      if (!v.ok) return fail('invalid_input', v.error.message);
      next.callRouteId = v.value;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;

    next.updatedAt = this.now().toISOString();
    await this.flows.putFlow(next);
    await this.audit('reception_flow.updated', next);
    return { ok: true, value: next };
  }

  /** フローを削除する。対象サイトへの write 認可が必要。 */
  async remove(
    actor: Actor,
    tenantId: TenantId,
    id: ReceptionFlowId,
  ): Promise<ServiceResult<void>> {
    const found = await this.flows.getFlow(tenantId, id);
    if (!found) return fail('not_found', 'reception flow not found');
    if (!canAccessSite(actor, tenantId, found.siteId, 'write'))
      return fail('forbidden', 'actor cannot delete this reception flow');
    const removed = await this.flows.deleteFlow(tenantId, id);
    if (!removed.ok) return fail('not_found', removed.error.message);
    await this.audit('reception_flow.deleted', found);
    return { ok: true, value: undefined };
  }

  /** PII を含めない監査記録。入力値は残さず、件数のみ残す。actor は呼び出し側で admin に固定。 */
  private async audit(action: AuditAction, flow: StoredReceptionFlow): Promise<void> {
    await this.appendAudit(action, { type: 'reception_flow', id: flow.id }, {
      purposeKey: flow.purposeKey,
      displayName: flow.displayName,
      siteId: flow.siteId,
      enabled: String(flow.enabled),
      stepCount: String(flow.steps.length),
      fieldCount: String(flow.fields.length),
    });
  }
}
