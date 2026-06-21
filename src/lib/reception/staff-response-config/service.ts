/**
 * 担当者応答設定サービス (issue #99 increment 2)。
 *
 * リポジトリ・テナント/サイト認可・設定解決を束ねる薄い層。route ハンドラから呼び出す。
 * 応答種別ごとの「有効/無効・来訪者文言上書き」を保持し、未設定種別は純ドメインの既定へ
 * フォールバックする（ReceptionFlowService #100 と同じ責務分離）。
 *
 * 認可方針（#80）:
 *   - 取得: canAccessSite(read)（site_manager は担当サイトのみ）。
 *   - 更新: canAccessSite(write)（viewer 不可・他テナント越境不可）。
 *
 * 監査方針:
 *   - 本増分では設定変更用の AuditAction を新設しない（log.ts を触らない方針）。
 *     設定変更は監査に残さず、実際の担当者応答のみ既存 reception.staff_responded で残す
 *     （recordStaffResponse 側）。PII（来訪者入力値）は一切扱わない。
 */
import {
  STAFF_RESPONSE_ACTIONS,
  isStaffResponseAction,
  resolveStaffResponseDefinitions,
  type ResolvedStaffResponseDefinition,
  type StaffResponseAction,
  type StaffResponseActionOverride,
  type StaffResponseConfigOverrides,
} from '@/domain/reception/staff-response';
import { canAccessSite, type Actor } from '@/domain/tenant/authorization';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import {
  staffResponseConfigId,
  type StaffResponseConfigRepository,
} from './repository';
import type { StaffResponseOverridePatch, StoredStaffResponseConfig } from './types';

export type ServiceError = {
  code: 'invalid_input' | 'not_found' | 'forbidden';
  message: string;
};
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

function fail(code: ServiceError['code'], message: string): ServiceResult<never> {
  return { ok: false, error: { code, message } };
}

/** 来訪者文言上書きの最大長。短く保たせるための上限。 */
export const MESSAGE_OVERRIDE_MAX = 120;

/** 管理画面に返す設定ビュー: サイト境界 + 全応答種別の実効定義（既定にフォールバック済み）。 */
export type StaffResponseConfigView = {
  tenantId: TenantId;
  siteId: SiteId;
  definitions: ResolvedStaffResponseDefinition[];
  updatedAt?: string;
};

export type StaffResponseConfigServiceDeps = {
  repo: StaffResponseConfigRepository;
  now?: () => Date;
};

export class StaffResponseConfigService {
  private readonly repo: StaffResponseConfigRepository;
  private readonly now: () => Date;

  constructor(deps: StaffResponseConfigServiceDeps) {
    this.repo = deps.repo;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 指定サイトの応答設定を実効定義ビューで返す。read 認可が必要。
   * 未保存でも全種別の既定を返す（管理画面が空でも一覧を出せる）。
   */
  async getView(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
  ): Promise<ServiceResult<StaffResponseConfigView>> {
    if (!canAccessSite(actor, tenantId, siteId, 'read'))
      return fail('forbidden', 'actor cannot read staff response config for this site');
    const stored = await this.repo.get(tenantId, siteId);
    return {
      ok: true,
      value: {
        tenantId,
        siteId,
        definitions: resolveStaffResponseDefinitions(stored?.overrides),
        updatedAt: stored?.updatedAt,
      },
    };
  }

  /**
   * 1 応答種別の有効/無効・文言上書きを更新する。write 認可が必要。
   * messageOverride: 文字列で上書き設定、null/空白で上書き解除、undefined で据え置き。
   */
  async updateAction(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
    patch: StaffResponseOverridePatch,
  ): Promise<ServiceResult<StaffResponseConfigView>> {
    if (!canAccessSite(actor, tenantId, siteId, 'write'))
      return fail('forbidden', 'actor cannot update staff response config for this site');

    if (!isStaffResponseAction(patch.action))
      return fail('invalid_input', 'unknown response action');

    const normalized = normalizeMessageOverride(patch.messageOverride);
    if (!normalized.ok) return fail('invalid_input', normalized.message);

    const stored = (await this.repo.get(tenantId, siteId)) ?? this.empty(tenantId, siteId);
    const nextOverrides: StaffResponseConfigOverrides = { ...stored.overrides };
    const current: StaffResponseActionOverride = { ...nextOverrides[patch.action] };

    if (patch.enabled !== undefined) current.enabled = patch.enabled;
    if (normalized.value === 'clear') delete current.messageOverride;
    else if (normalized.value !== undefined) current.messageOverride = normalized.value;

    // 空の上書き（何も設定が残らない）は種別ごと削除して既定へ戻す。
    if (current.enabled === undefined && current.messageOverride === undefined)
      delete nextOverrides[patch.action];
    else nextOverrides[patch.action] = current;

    const next: StoredStaffResponseConfig = {
      ...stored,
      overrides: nextOverrides,
      updatedAt: this.now().toISOString(),
    };
    await this.repo.put(next);

    return {
      ok: true,
      value: {
        tenantId,
        siteId,
        definitions: resolveStaffResponseDefinitions(next.overrides),
        updatedAt: next.updatedAt,
      },
    };
  }

  /**
   * 応答実行経路（respond route / kiosk）向け: 認可なしで指定サイトの overrides を返す。
   * 受付端末・担当者導線は kiosk/answer トークンで scope が確定するため、admin の
   * RoleAssignment 認可は適用しない。未保存なら空（＝全種別既定）。
   */
  async resolveOverrides(
    tenantId: TenantId,
    siteId: SiteId,
  ): Promise<StaffResponseConfigOverrides> {
    const stored = await this.repo.get(tenantId, siteId);
    return stored?.overrides ?? {};
  }

  private empty(tenantId: TenantId, siteId: SiteId): StoredStaffResponseConfig {
    const nowIso = this.now().toISOString();
    return {
      id: staffResponseConfigId(tenantId, siteId),
      tenantId,
      siteId,
      overrides: {},
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }
}

/** 全応答種別の配列（route のバリデーション補助に再エクスポート）。 */
export { STAFF_RESPONSE_ACTIONS };
export type { StaffResponseAction };

/**
 * messageOverride 入力を正規化する。
 *  - undefined → undefined（据え置き）
 *  - null / 空白 → 'clear'（上書き解除）
 *  - 文字列 → trim 済み文字列（長すぎれば invalid）
 */
function normalizeMessageOverride(
  raw: string | null | undefined,
): { ok: true; value: string | 'clear' | undefined } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: 'clear' };
  if (typeof raw !== 'string') return { ok: false, message: 'messageOverride must be a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: 'clear' };
  if (trimmed.length > MESSAGE_OVERRIDE_MAX)
    return { ok: false, message: `messageOverride must be at most ${MESSAGE_OVERRIDE_MAX} characters` };
  return { ok: true, value: trimmed };
}
