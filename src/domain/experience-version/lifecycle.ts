/**
 * 受付体験の版ライフサイクル (issue #420)。
 *
 * 編集 → 下書き保存 → 自動検証 → 承認 → 公開 → （必要なら）ロールバック、までの状態遷移を
 * 純関数で表す。永続化・認可・監査ログは呼び出し側（repository / route）が担う。
 *
 * 不変条件:
 *   - `versions` は append-only・`revision` 昇順・単調増加（rollback も新規採番）。
 *   - live な `published` は同時に 1 件だけ。
 *   - 未確定の `draft` も同時に 1 件だけ（最新 revision）。
 *   - 過去版の `configHash` / `createdAt` / `revision` は書き換えない（status のみ遷移する）。
 */
import type {
  ReceptionExperience,
  ReceptionExperienceVersion,
  ValidationSummary,
} from './types';
import type { SiteId, TenantId } from '@/domain/tenant/types';

export type LifecycleResult<R extends string> =
  | { ok: true; value: ReceptionExperience }
  | { ok: false; reason: R };

/** 公開を止める指摘（`error`）があるか。`warning` は止めない。 */
export function hasBlockingFindings(summary: ValidationSummary): boolean {
  return summary.findings.some((f) => f.severity === 'error');
}

/** いま公開中の版。未公開なら undefined。 */
export function publishedVersion(
  exp: ReceptionExperience,
): ReceptionExperienceVersion | undefined {
  return exp.versions.find((v) => v.status === 'published');
}

/** 編集中の下書き。無ければ undefined。 */
export function draftVersion(exp: ReceptionExperience): ReceptionExperienceVersion | undefined {
  return exp.versions.find((v) => v.status === 'draft');
}

function latestRevision(exp: ReceptionExperience): number {
  return exp.versions.reduce((max, v) => (v.revision > max ? v.revision : max), 0);
}

/** 版を 1 件だけ差し替えた新しい履歴を返す（他の版は同一参照のまま）。 */
function withVersion(
  exp: ReceptionExperience,
  revision: number,
  patch: Partial<ReceptionExperienceVersion>,
  nowIso: string,
): ReceptionExperience {
  return {
    ...exp,
    versions: exp.versions.map((v) => (v.revision === revision ? { ...v, ...patch } : v)),
    updatedAt: nowIso,
  };
}

export function createExperience(input: {
  id: string;
  tenantId: TenantId;
  siteId: SiteId;
  name: string;
  configHash: string;
  createdBy: string;
  nowIso: string;
}): ReceptionExperience {
  return {
    id: input.id,
    tenantId: input.tenantId,
    siteId: input.siteId,
    name: input.name,
    versions: [
      {
        revision: 1,
        status: 'draft',
        configHash: input.configHash,
        createdBy: input.createdBy,
        createdAt: input.nowIso,
      },
    ],
    updatedAt: input.nowIso,
  };
}

/**
 * 下書きを保存する。**新しい revision を積む**（履歴を書き換えない）。
 * `baseRevision` は編集者が読み込んだ時点の最新 revision。ずれていれば競合として拒否する
 * （後勝ちで他人の編集を消さない）。
 */
export function saveDraft(
  exp: ReceptionExperience,
  input: { configHash: string; editorId: string; nowIso: string; baseRevision: number },
): LifecycleResult<'revision_conflict'> {
  const latest = latestRevision(exp);
  if (input.baseRevision !== latest) return { ok: false, reason: 'revision_conflict' };

  const next: ReceptionExperienceVersion = {
    revision: latest + 1,
    status: 'draft',
    configHash: input.configHash,
    createdBy: input.editorId,
    createdAt: input.nowIso,
  };
  // 直前の下書きは確定せずに置き換えられたので archived として履歴に残す。
  const superseded = exp.versions.map((v) =>
    v.status === 'draft' ? { ...v, status: 'archived' as const } : v,
  );

  return {
    ok: true,
    value: { ...exp, versions: [...superseded, next], updatedAt: input.nowIso },
  };
}

/** 自動検証の結果を下書きへ記録する。 */
export function recordValidation(
  exp: ReceptionExperience,
  input: { revision: number; summary: ValidationSummary; nowIso: string },
): LifecycleResult<'version_not_found' | 'not_draft'> {
  const target = exp.versions.find((v) => v.revision === input.revision);
  if (!target) return { ok: false, reason: 'version_not_found' };
  if (target.status !== 'draft') return { ok: false, reason: 'not_draft' };

  return {
    ok: true,
    value: withVersion(exp, input.revision, { validationSummary: input.summary }, input.nowIso),
  };
}

/** 人間による承認。検証済み・error なしの下書きにのみ与えられる。 */
export function approve(
  exp: ReceptionExperience,
  input: { revision: number; approverId: string; nowIso: string },
): LifecycleResult<'version_not_found' | 'not_draft' | 'validation_missing' | 'validation_failed'> {
  const target = exp.versions.find((v) => v.revision === input.revision);
  if (!target) return { ok: false, reason: 'version_not_found' };
  if (target.status !== 'draft') return { ok: false, reason: 'not_draft' };
  if (!target.validationSummary) return { ok: false, reason: 'validation_missing' };
  if (hasBlockingFindings(target.validationSummary)) {
    return { ok: false, reason: 'validation_failed' };
  }

  return {
    ok: true,
    value: withVersion(
      exp,
      input.revision,
      { approvedBy: input.approverId, approvedAt: input.nowIso },
      input.nowIso,
    ),
  };
}

/**
 * 承認済みの下書きを公開する。`configHash` は**引き継ぐだけ**で再計算しない
 * （AC「プレビューと公開後の画面で同一 config hash」）。前の公開版は archived にする。
 */
export function publish(
  exp: ReceptionExperience,
  input: { revision: number; publisherId: string; nowIso: string },
): LifecycleResult<'version_not_found' | 'not_draft' | 'not_approved'> {
  const target = exp.versions.find((v) => v.revision === input.revision);
  if (!target) return { ok: false, reason: 'version_not_found' };
  if (target.status !== 'draft') return { ok: false, reason: 'not_draft' };
  if (!target.approvedBy) return { ok: false, reason: 'not_approved' };

  const versions = exp.versions.map((v) => {
    if (v.revision === input.revision) {
      return {
        ...v,
        status: 'published' as const,
        publishedBy: input.publisherId,
        publishedAt: input.nowIso,
      };
    }
    return v.status === 'published' ? { ...v, status: 'archived' as const } : v;
  });

  return { ok: true, value: { ...exp, versions, updatedAt: input.nowIso } };
}

/**
 * 過去に公開した版の内容へ戻す。**revision は前へ戻さず新規採番する**
 * （端末は revision の大小だけで新旧を判定するため、番号を巻き戻すと切り戻しを検出できない）。
 * 切り戻された（それまで live だった）版は `rolled_back` として履歴に残す。
 */
export function rollbackTo(
  exp: ReceptionExperience,
  input: { revision: number; actorId: string; nowIso: string },
): LifecycleResult<'version_not_found' | 'not_published_before' | 'no_change'> {
  const target = exp.versions.find((v) => v.revision === input.revision);
  if (!target) return { ok: false, reason: 'version_not_found' };
  // 一度も公開されていない版（下書き・破棄）へは戻せない。
  if (!target.publishedAt) return { ok: false, reason: 'not_published_before' };
  if (target.status === 'published') return { ok: false, reason: 'no_change' };

  const restored: ReceptionExperienceVersion = {
    revision: latestRevision(exp) + 1,
    status: 'published',
    configHash: target.configHash,
    validationSummary: target.validationSummary,
    createdBy: input.actorId,
    createdAt: input.nowIso,
    approvedBy: input.actorId,
    approvedAt: input.nowIso,
    publishedBy: input.actorId,
    publishedAt: input.nowIso,
    rolledBackFrom: target.revision,
  };
  const versions = exp.versions.map((v) =>
    v.status === 'published' ? { ...v, status: 'rolled_back' as const } : v,
  );

  return {
    ok: true,
    value: { ...exp, versions: [...versions, restored], updatedAt: input.nowIso },
  };
}
