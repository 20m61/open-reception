import { describe, expect, it } from 'vitest';
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
} from './lifecycle';
import type { ReceptionExperience, ValidationSummary } from './types';
import { asSiteId, asTenantId } from '@/domain/tenant/types';

const T0 = '2026-07-27T00:00:00.000Z';
const T1 = '2026-07-27T01:00:00.000Z';
const T2 = '2026-07-27T02:00:00.000Z';
const T3 = '2026-07-27T03:00:00.000Z';

const OK_VALIDATION: ValidationSummary = { checkedAt: T1, findings: [] };
const WARN_VALIDATION: ValidationSummary = {
  checkedAt: T1,
  findings: [{ check: 'asset', severity: 'warning', message: '背景画像が大きい' }],
};
const ERROR_VALIDATION: ValidationSummary = {
  checkedAt: T1,
  findings: [{ check: 'call_route', severity: 'error', message: '到達不能な取次先がある' }],
};

function newExperience(): ReceptionExperience {
  return createExperience({
    id: 'exp-1',
    tenantId: asTenantId('tenant-a'),
    siteId: asSiteId('site-1'),
    name: '本社受付',
    configHash: 'sha256:aaa',
    createdBy: 'admin-1',
    nowIso: T0,
  });
}

/** draft → 検証 → 承認 → 公開まで進めた体験を作る小ヘルパ。 */
function published(): ReceptionExperience {
  const exp = newExperience();
  const validated = recordValidation(exp, { revision: 1, summary: OK_VALIDATION, nowIso: T1 });
  if (!validated.ok) throw new Error('setup: recordValidation failed');
  const approved = approve(validated.value, { revision: 1, approverId: 'admin-2', nowIso: T1 });
  if (!approved.ok) throw new Error('setup: approve failed');
  const live = publish(approved.value, { revision: 1, publisherId: 'admin-2', nowIso: T1 });
  if (!live.ok) throw new Error('setup: publish failed');
  return live.value;
}

describe('createExperience', () => {
  it('revision 1 の下書きから始まり、公開版はまだ無い', () => {
    const exp = newExperience();

    expect(exp.versions).toHaveLength(1);
    expect(draftVersion(exp)).toMatchObject({
      revision: 1,
      status: 'draft',
      configHash: 'sha256:aaa',
      createdBy: 'admin-1',
    });
    expect(publishedVersion(exp)).toBeUndefined();
  });
});

describe('saveDraft', () => {
  it('新しい revision を積む（履歴を書き換えない）', () => {
    const exp = newExperience();

    const saved = saveDraft(exp, {
      configHash: 'sha256:bbb',
      editorId: 'admin-1',
      nowIso: T1,
      baseRevision: 1,
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.versions).toHaveLength(2);
    expect(draftVersion(saved.value)).toMatchObject({ revision: 2, configHash: 'sha256:bbb' });
    // 旧 draft は履歴として残り、内容は不変。
    expect(saved.value.versions[0]).toMatchObject({ revision: 1, configHash: 'sha256:aaa' });
  });

  it('入力のオブジェクトを破壊しない', () => {
    const exp = newExperience();
    const before = JSON.parse(JSON.stringify(exp));

    saveDraft(exp, { configHash: 'sha256:bbb', editorId: 'admin-1', nowIso: T1, baseRevision: 1 });

    expect(exp).toEqual(before);
  });

  it('他の編集者が先に保存していれば revision 競合で拒否する', () => {
    const exp = newExperience();
    const first = saveDraft(exp, {
      configHash: 'sha256:bbb',
      editorId: 'admin-1',
      nowIso: T1,
      baseRevision: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 古い revision 1 を見たまま保存しようとした 2 人目。
    const second = saveDraft(first.value, {
      configHash: 'sha256:ccc',
      editorId: 'admin-3',
      nowIso: T2,
      baseRevision: 1,
    });

    expect(second).toEqual({ ok: false, reason: 'revision_conflict' });
  });

  it('公開済みの体験に下書きを足しても、公開版は変わらない（AC: 即時反映されない）', () => {
    const live = published();

    const saved = saveDraft(live, {
      configHash: 'sha256:zzz',
      editorId: 'admin-1',
      nowIso: T2,
      baseRevision: 1,
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(publishedVersion(saved.value)).toMatchObject({ revision: 1, configHash: 'sha256:aaa' });
    expect(draftVersion(saved.value)).toMatchObject({ revision: 2, configHash: 'sha256:zzz' });
  });
});

describe('recordValidation / approve', () => {
  it('error が無ければ承認できる（warning は止めない）', () => {
    const exp = newExperience();
    const validated = recordValidation(exp, { revision: 1, summary: WARN_VALIDATION, nowIso: T1 });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const approved = approve(validated.value, {
      revision: 1,
      approverId: 'admin-2',
      nowIso: T1,
    });

    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(draftVersion(approved.value)).toMatchObject({
      approvedBy: 'admin-2',
      approvedAt: T1,
    });
  });

  it('error があれば承認を拒否する', () => {
    const exp = newExperience();
    const validated = recordValidation(exp, { revision: 1, summary: ERROR_VALIDATION, nowIso: T1 });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(approve(validated.value, { revision: 1, approverId: 'admin-2', nowIso: T1 })).toEqual({
      ok: false,
      reason: 'validation_failed',
    });
  });

  it('検証していない版は承認できない', () => {
    const exp = newExperience();

    expect(approve(exp, { revision: 1, approverId: 'admin-2', nowIso: T1 })).toEqual({
      ok: false,
      reason: 'validation_missing',
    });
  });

  it('存在しない版・下書きでない版は拒否する', () => {
    const live = published();

    expect(recordValidation(live, { revision: 9, summary: OK_VALIDATION, nowIso: T2 })).toEqual({
      ok: false,
      reason: 'version_not_found',
    });
    expect(recordValidation(live, { revision: 1, summary: OK_VALIDATION, nowIso: T2 })).toEqual({
      ok: false,
      reason: 'not_draft',
    });
  });
});

describe('publish', () => {
  it('承認済みの下書きを公開し、configHash をそのまま引き継ぐ（AC: プレビューと同一 hash）', () => {
    const live = published();

    expect(publishedVersion(live)).toMatchObject({
      revision: 1,
      status: 'published',
      configHash: 'sha256:aaa',
      publishedBy: 'admin-2',
      publishedAt: T1,
    });
    expect(draftVersion(live)).toBeUndefined();
  });

  it('未承認の下書きは公開できない', () => {
    const exp = newExperience();
    const validated = recordValidation(exp, { revision: 1, summary: OK_VALIDATION, nowIso: T1 });
    if (!validated.ok) throw new Error('setup');

    expect(publish(validated.value, { revision: 1, publisherId: 'admin-2', nowIso: T1 })).toEqual({
      ok: false,
      reason: 'not_approved',
    });
  });

  it('新しい版を公開すると、前の公開版は archived になる（live は常に 1 件）', () => {
    const live = published();
    const saved = saveDraft(live, {
      configHash: 'sha256:bbb',
      editorId: 'admin-1',
      nowIso: T2,
      baseRevision: 1,
    });
    if (!saved.ok) throw new Error('setup');
    const validated = recordValidation(saved.value, {
      revision: 2,
      summary: OK_VALIDATION,
      nowIso: T2,
    });
    if (!validated.ok) throw new Error('setup');
    const approved = approve(validated.value, { revision: 2, approverId: 'admin-2', nowIso: T2 });
    if (!approved.ok) throw new Error('setup');

    const next = publish(approved.value, { revision: 2, publisherId: 'admin-2', nowIso: T2 });

    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.versions.filter((v) => v.status === 'published')).toHaveLength(1);
    expect(publishedVersion(next.value)).toMatchObject({ revision: 2, configHash: 'sha256:bbb' });
    // 過去版は status のみ遷移し、内容（指紋・作成時刻）は書き換えない。
    expect(next.value.versions[0]).toMatchObject({
      revision: 1,
      status: 'archived',
      configHash: 'sha256:aaa',
      createdAt: T0,
    });
  });
});

describe('rollbackTo', () => {
  /** rev1 と rev2 を順に公開した状態。 */
  function twicePublished(): ReceptionExperience {
    const live = published();
    const saved = saveDraft(live, {
      configHash: 'sha256:bbb',
      editorId: 'admin-1',
      nowIso: T2,
      baseRevision: 1,
    });
    if (!saved.ok) throw new Error('setup');
    const validated = recordValidation(saved.value, {
      revision: 2,
      summary: OK_VALIDATION,
      nowIso: T2,
    });
    if (!validated.ok) throw new Error('setup');
    const approved = approve(validated.value, { revision: 2, approverId: 'admin-2', nowIso: T2 });
    if (!approved.ok) throw new Error('setup');
    const next = publish(approved.value, { revision: 2, publisherId: 'admin-2', nowIso: T2 });
    if (!next.ok) throw new Error('setup');
    return next.value;
  }

  it('過去の公開版の内容で新しい版を積む（revision は前へ戻さない）', () => {
    const exp = twicePublished();

    const rolled = rollbackTo(exp, { revision: 1, actorId: 'admin-2', nowIso: T3 });

    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    const live = publishedVersion(rolled.value);
    expect(live).toMatchObject({
      revision: 3,
      status: 'published',
      configHash: 'sha256:aaa',
      rolledBackFrom: 1,
      publishedBy: 'admin-2',
      publishedAt: T3,
    });
    // 切り戻された版は rolled_back として履歴に残る。
    expect(rolled.value.versions[1]).toMatchObject({ revision: 2, status: 'rolled_back' });
  });

  it('公開されたことのない版へは戻せない', () => {
    const exp = published();
    const saved = saveDraft(exp, {
      configHash: 'sha256:bbb',
      editorId: 'admin-1',
      nowIso: T2,
      baseRevision: 1,
    });
    if (!saved.ok) throw new Error('setup');

    expect(rollbackTo(saved.value, { revision: 2, actorId: 'admin-2', nowIso: T3 })).toEqual({
      ok: false,
      reason: 'not_published_before',
    });
  });

  it('いま公開中の版への切り戻しは no_change', () => {
    const exp = twicePublished();

    expect(rollbackTo(exp, { revision: 2, actorId: 'admin-2', nowIso: T3 })).toEqual({
      ok: false,
      reason: 'no_change',
    });
  });

  it('存在しない版は version_not_found', () => {
    expect(rollbackTo(published(), { revision: 9, actorId: 'admin-2', nowIso: T3 })).toEqual({
      ok: false,
      reason: 'version_not_found',
    });
  });
});

describe('構成スナップショット（#420 Inc2）', () => {
  const SNAP_A = { sections: { branding: { accentColor: '#aaa' } }, configHash: 'sha256:aaa' };
  const SNAP_B = { sections: { branding: { accentColor: '#bbb' } }, configHash: 'sha256:bbb' };

  /** snapshot 付きで rev1 を公開した体験。 */
  function publishedWithSnapshot(): ReceptionExperience {
    const exp = createExperience({
      id: 'exp-1',
      tenantId: asTenantId('tenant-a'),
      siteId: asSiteId('site-1'),
      name: '本社受付',
      configHash: SNAP_A.configHash,
      snapshot: SNAP_A,
      createdBy: 'admin-1',
      nowIso: T0,
    });
    const validated = recordValidation(exp, { revision: 1, summary: OK_VALIDATION, nowIso: T1 });
    if (!validated.ok) throw new Error('setup');
    const approved = approve(validated.value, { revision: 1, approverId: 'admin-2', nowIso: T1 });
    if (!approved.ok) throw new Error('setup');
    const live = publish(approved.value, { revision: 1, publisherId: 'admin-2', nowIso: T1 });
    if (!live.ok) throw new Error('setup');
    return live.value;
  }

  it('下書きを保存しても、公開版のスナップショットは変わらない（端末が見る中身が動かない）', () => {
    const live = publishedWithSnapshot();

    const saved = saveDraft(live, {
      configHash: SNAP_B.configHash,
      snapshot: SNAP_B,
      editorId: 'admin-1',
      nowIso: T2,
      baseRevision: 1,
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(publishedVersion(saved.value)?.snapshot).toEqual(SNAP_A);
    expect(draftVersion(saved.value)?.snapshot).toEqual(SNAP_B);
  });

  it('公開はスナップショットをそのまま引き継ぐ（公開時に取り直さない）', () => {
    const live = publishedWithSnapshot();

    expect(publishedVersion(live)?.snapshot).toEqual(SNAP_A);
    expect(publishedVersion(live)?.configHash).toBe(SNAP_A.configHash);
  });

  it('ロールバックは指紋だけでなく中身ごと戻す', () => {
    const live = publishedWithSnapshot();
    const saved = saveDraft(live, {
      configHash: SNAP_B.configHash,
      snapshot: SNAP_B,
      editorId: 'admin-1',
      nowIso: T2,
      baseRevision: 1,
    });
    if (!saved.ok) throw new Error('setup');
    const validated = recordValidation(saved.value, {
      revision: 2,
      summary: OK_VALIDATION,
      nowIso: T2,
    });
    if (!validated.ok) throw new Error('setup');
    const approved = approve(validated.value, { revision: 2, approverId: 'admin-2', nowIso: T2 });
    if (!approved.ok) throw new Error('setup');
    const next = publish(approved.value, { revision: 2, publisherId: 'admin-2', nowIso: T2 });
    if (!next.ok) throw new Error('setup');

    const rolled = rollbackTo(next.value, { revision: 1, actorId: 'admin-2', nowIso: T3 });

    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(publishedVersion(rolled.value)).toMatchObject({
      revision: 3,
      snapshot: SNAP_A,
      configHash: SNAP_A.configHash,
      rolledBackFrom: 1,
    });
  });
});

describe('hasBlockingFindings', () => {
  it('error のみを公開ブロックとみなす', () => {
    expect(hasBlockingFindings(OK_VALIDATION)).toBe(false);
    expect(hasBlockingFindings(WARN_VALIDATION)).toBe(false);
    expect(hasBlockingFindings(ERROR_VALIDATION)).toBe(true);
  });
});
