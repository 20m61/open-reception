/**
 * 受付体験バージョンのサービス層 (issue #420 increment 2)。
 *
 * 純ロジック（`src/domain/experience-version/lifecycle.ts`）に永続化とスナップショット取得を
 * 束ねる。認可判定と監査記録は呼び出し側（route）が行う — このクラスは「誰が呼んでよいか」を
 * 知らない（`rules/admin-api-authz.md` の責務分離）。
 *
 * **スナップショットの粒度**: 現在 kiosk 単位で値が変わるセクションは無い（featureFlags は
 * テナント単位、operatingPolicy は拠点単位、他はグローバル）。そのため拠点単位のスナップショットで
 * 足りる。取得時に代表 kioskId を渡すのは resolver の入力を満たすためで、**将来 kiosk 単位で
 * 変わるセクションを足す場合はスナップショットの粒度を見直す必要がある**。
 */
import {
  approve,
  createExperience,
  draftVersion,
  hasBlockingFindings,
  publish,
  publishedVersion,
  recordValidation,
  rollbackTo,
  saveDraft,
} from '@/domain/experience-version/lifecycle';
import type {
  ExperienceConfigurationSnapshot,
  ReceptionExperience,
  ValidationFinding,
  ValidationSummary,
} from '@/domain/experience-version/types';
import { findForbiddenConfigurationValues } from '@/domain/product-context/payload-contract';
import { CONFIGURATION_SECTIONS } from '@/domain/product-context/types';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import { experienceIdFor, type ExperienceRepository, type StoredExperience } from './repository';

/** 現在の設定ストアから構成スナップショットを取得する port（resolver に委譲する）。 */
export type SnapshotCapture = (input: {
  tenantId: TenantId;
  siteId: SiteId;
  kioskId: string;
}) => Promise<ExperienceConfigurationSnapshot>;

export type ServiceError =
  | 'experience_not_found'
  | 'revision_conflict'
  | 'version_not_found'
  | 'not_draft'
  | 'not_approved'
  | 'validation_missing'
  | 'validation_failed'
  | 'not_published_before'
  | 'no_change'
  | 'snapshot_failed';

export type ServiceResult =
  | { ok: true; value: StoredExperience }
  | { ok: false; reason: ServiceError };

type Scope = { tenantId: TenantId; siteId: SiteId };

/**
 * スナップショットの自動検証 (#420「公開前の検証」)。
 * 現時点の実チェックは 2 つだけ:
 *   - 秘匿値・PII の混入（`payload-contract`）→ error（公開を止める）
 *   - セクションの欠落 → warning（互換アダプタ未実装のセクションが在りうるため止めない）
 * asset URL / motion mapping / call route 到達性の実チェックは後続 increment。
 */
export function validateSnapshot(
  snapshot: ExperienceConfigurationSnapshot,
  nowIso: string,
): ValidationSummary {
  const findings: ValidationFinding[] = [];

  for (const violation of findForbiddenConfigurationValues(snapshot.sections)) {
    findings.push({
      check: 'permission',
      severity: 'error',
      // パスのみ。値は載せない（`.claude/rules/pii-secret-minimization.md`）。
      message: `禁止された値が構成に含まれています: ${violation.path} (${violation.kind})`,
    });
  }

  for (const section of CONFIGURATION_SECTIONS) {
    if (!(section in snapshot.sections)) {
      findings.push({
        check: 'config_schema',
        severity: 'warning',
        message: `セクション ${section} がスナップショットにありません`,
      });
    }
  }

  return { checkedAt: nowIso, findings };
}

export class ExperienceVersionService {
  constructor(
    private readonly repo: ExperienceRepository,
    private readonly deps: { captureSnapshot: SnapshotCapture; now?: () => Date },
  ) {}

  private nowIso(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  private async persist(scope: Scope, experience: ReceptionExperience): Promise<StoredExperience> {
    const stored: StoredExperience = {
      ...experience,
      id: experienceIdFor(scope.tenantId, scope.siteId),
    };
    await this.repo.put(stored);
    return stored;
  }

  async getBySite(tenantId: TenantId, siteId: SiteId): Promise<StoredExperience | undefined> {
    return this.repo.findBySite(tenantId, siteId);
  }

  /**
   * 現在の設定ストアの内容を下書きとして固定する。体験が未作成なら revision 1 として作る。
   * 取得したスナップショットは自動検証にかけ、結果を版へ記録する。
   */
  async saveDraft(input: {
    tenantId: TenantId;
    siteId: SiteId;
    kioskId: string;
    editorId: string;
    name?: string;
    /** 楽観ロック。既存体験がある場合は必須（最新 revision と一致しなければ競合）。 */
    baseRevision?: number;
  }): Promise<ServiceResult> {
    const scope = { tenantId: input.tenantId, siteId: input.siteId };
    const nowIso = this.nowIso();

    let snapshot: ExperienceConfigurationSnapshot;
    try {
      snapshot = await this.deps.captureSnapshot({
        tenantId: input.tenantId,
        siteId: input.siteId,
        kioskId: input.kioskId,
      });
    } catch {
      // 現構成が解決できないなら下書きは作らない（中身の無い版を積まない）。
      return { ok: false, reason: 'snapshot_failed' };
    }

    const existing = await this.repo.findBySite(input.tenantId, input.siteId);
    const summary = validateSnapshot(snapshot, nowIso);

    if (!existing) {
      const created = createExperience({
        id: experienceIdFor(input.tenantId, input.siteId),
        tenantId: input.tenantId,
        siteId: input.siteId,
        name: input.name ?? String(input.siteId),
        configHash: snapshot.configHash,
        snapshot,
        createdBy: input.editorId,
        nowIso,
      });
      const validated = recordValidation(created, { revision: 1, summary, nowIso });
      if (!validated.ok) return { ok: false, reason: validated.reason };
      return { ok: true, value: await this.persist(scope, validated.value) };
    }

    const latest = Math.max(...existing.versions.map((v) => v.revision));
    const saved = saveDraft(existing, {
      configHash: snapshot.configHash,
      snapshot,
      editorId: input.editorId,
      nowIso,
      baseRevision: input.baseRevision ?? latest,
    });
    if (!saved.ok) return { ok: false, reason: saved.reason };

    const revision = draftVersion(saved.value)?.revision;
    if (revision === undefined) return { ok: false, reason: 'version_not_found' };
    const validated = recordValidation(saved.value, { revision, summary, nowIso });
    if (!validated.ok) return { ok: false, reason: validated.reason };

    return { ok: true, value: await this.persist(scope, validated.value) };
  }

  async approve(input: {
    tenantId: TenantId;
    siteId: SiteId;
    revision: number;
    approverId: string;
  }): Promise<ServiceResult> {
    const existing = await this.repo.findBySite(input.tenantId, input.siteId);
    if (!existing) return { ok: false, reason: 'experience_not_found' };

    const result = approve(existing, {
      revision: input.revision,
      approverId: input.approverId,
      nowIso: this.nowIso(),
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, value: await this.persist(input, result.value) };
  }

  async publish(input: {
    tenantId: TenantId;
    siteId: SiteId;
    revision: number;
    publisherId: string;
  }): Promise<ServiceResult> {
    const existing = await this.repo.findBySite(input.tenantId, input.siteId);
    if (!existing) return { ok: false, reason: 'experience_not_found' };

    const result = publish(existing, {
      revision: input.revision,
      publisherId: input.publisherId,
      nowIso: this.nowIso(),
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, value: await this.persist(input, result.value) };
  }

  async rollback(input: {
    tenantId: TenantId;
    siteId: SiteId;
    revision: number;
    actorId: string;
  }): Promise<ServiceResult> {
    const existing = await this.repo.findBySite(input.tenantId, input.siteId);
    if (!existing) return { ok: false, reason: 'experience_not_found' };

    const result = rollbackTo(existing, {
      revision: input.revision,
      actorId: input.actorId,
      nowIso: this.nowIso(),
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, value: await this.persist(input, result.value) };
  }
}

export { draftVersion, hasBlockingFindings, publishedVersion };
