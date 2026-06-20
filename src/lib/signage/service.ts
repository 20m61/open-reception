/**
 * サイネージ設定サービス (issue #101, increment 1)。
 *
 * リポジトリ・検証純関数・監査ログ・テナント認可を束ねる薄い層。route から呼ぶ。
 * 副作用（永続化・監査）はここに閉じ込め、判定は純関数（src/domain/signage/rotation.ts,
 * src/domain/tenant/authorization.ts）へ委譲する。
 *
 * 監査: 事前定義済みの 'signage.updated' のみを使う（log.ts は触らない）。metadata に
 * 来訪者 PII は載せない（項目数・有効状態など運用に必要な最小限のみ）。
 */
import { canAccessSite, type Actor } from '@/domain/tenant/authorization';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { AuditAction } from '@/domain/reception/log';
import {
  defaultSignageConfig,
  type SignageConfig,
} from '@/domain/signage/types';
import { validateConfig, type ValidationError } from '@/domain/signage/rotation';
import type { SignageRepository } from './repository';

export type ServiceError = {
  code: 'invalid_input' | 'forbidden';
  message: string;
  /** invalid_input のときのフィールド別エラー（UI 表示用）。 */
  fields?: ValidationError[];
};
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

function fail(code: ServiceError['code'], message: string, fields?: ValidationError[]): ServiceResult<never> {
  return { ok: false, error: { code, message, fields } };
}

/** 監査追記の関数型（テストで差し替え可能にし、global backend 依存を切り離す）。 */
export type AppendAudit = (
  action: AuditAction,
  target: { type: string; id?: string },
  metadata?: Record<string, string>,
) => Promise<unknown>;

/** 設定の更新入力。並び順・有効状態・既定間隔・項目をまとめて置き換える。 */
export type UpdateSignageInput = {
  tenantId: TenantId;
  siteId: SiteId;
  enabled: boolean;
  defaultIntervalSeconds: number;
  items: SignageConfig['items'];
};

export type SignageServiceDeps = {
  repo: SignageRepository;
  appendAudit: AppendAudit;
  now?: () => Date;
};

export class SignageService {
  private readonly repo: SignageRepository;
  private readonly appendAudit: AppendAudit;
  private readonly now: () => Date;

  constructor(deps: SignageServiceDeps) {
    this.repo = deps.repo;
    this.appendAudit = deps.appendAudit;
    this.now = deps.now ?? (() => new Date());
  }

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

  /** サイトの設定を取得する。未保存なら安全な既定（時計のみ・無効）を返す。 */
  async get(
    actor: Actor,
    tenantId: TenantId,
    siteId: SiteId,
  ): Promise<ServiceResult<SignageConfig>> {
    const auth = this.authorize(actor, tenantId, siteId, 'read');
    if (!auth.ok) return auth;
    const found = await this.repo.get(tenantId, siteId);
    return {
      ok: true,
      value: found ?? defaultSignageConfig(tenantId, siteId, this.now().toISOString()),
    };
  }

  /** 設定を検証して保存する。検証に通らなければ invalid_input（フィールド別）を返す。 */
  async update(actor: Actor, input: UpdateSignageInput): Promise<ServiceResult<SignageConfig>> {
    const auth = this.authorize(actor, input.tenantId, input.siteId, 'write');
    if (!auth.ok) return auth;

    const config: SignageConfig = {
      tenantId: input.tenantId,
      siteId: input.siteId,
      enabled: input.enabled,
      defaultIntervalSeconds: input.defaultIntervalSeconds,
      items: input.items,
      updatedAt: this.now().toISOString(),
    };

    const validated = validateConfig(config);
    if (!validated.ok) {
      return fail('invalid_input', 'signage config is invalid', validated.errors);
    }

    await this.repo.put(config);
    await this.audit(config);
    return { ok: true, value: config };
  }

  /** PII を含めない監査記録。actor は呼び出し側（route）で admin に固定。 */
  private async audit(config: SignageConfig): Promise<void> {
    await this.appendAudit(
      'signage.updated',
      { type: 'signage', id: config.siteId },
      {
        enabled: String(config.enabled),
        itemCount: String(config.items.length),
        defaultIntervalSeconds: String(config.defaultIntervalSeconds),
      },
    );
  }
}
