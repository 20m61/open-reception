import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperienceVersionService, validateSnapshot, type SnapshotCapture } from './service';
import { InMemoryExperienceRepository } from './repository';
import { draftVersion, publishedVersion } from '@/domain/experience-version/lifecycle';
import { CONFIGURATION_SECTIONS } from '@/domain/product-context/types';
import { asSiteId, asTenantId } from '@/domain/tenant/types';

const TENANT = asTenantId('tenant-a');
const SITE = asSiteId('site-1');
const SCOPE = { tenantId: TENANT, siteId: SITE };
const NOW = '2026-07-27T00:00:00.000Z';

/** 全セクションを持つ健全なスナップショット。 */
function snapshotOf(hash: string, over: Record<string, unknown> = {}) {
  const sections: Record<string, unknown> = {};
  for (const s of CONFIGURATION_SECTIONS) sections[s] = { section: s };
  // 実スナップショットのローダは languages を必ず埋める。合成値のままだと
  // `language_fallback` チェック（#420）が正当に警告するため、健全な値を入れておく。
  sections.languages = { enabledLocales: ['ja'], defaultLocale: 'ja' };
  return { sections: { ...sections, ...over }, configHash: hash };
}

let repo: InMemoryExperienceRepository;
let captureSnapshot: ReturnType<typeof vi.fn<SnapshotCapture>>;
let service: ExperienceVersionService;

beforeEach(() => {
  repo = new InMemoryExperienceRepository();
  captureSnapshot = vi.fn<SnapshotCapture>().mockResolvedValue(snapshotOf('sha256:aaa'));
  service = new ExperienceVersionService(repo, {
    captureSnapshot,
    now: () => new Date(NOW),
  });
});

/** 下書き→承認→公開まで進める。 */
async function publishCurrent(revision: number) {
  const approved = await service.approve({ ...SCOPE, revision, approverId: 'admin-2' });
  expect(approved.ok).toBe(true);
  const published = await service.publish({ ...SCOPE, revision, publisherId: 'admin-2' });
  expect(published.ok).toBe(true);
  return published;
}

describe('saveDraft', () => {
  it('体験が無ければ revision 1 として作り、スナップショットと検証結果を記録する', async () => {
    const result = await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('tenant-a:site-1');
    const draft = draftVersion(result.value);
    expect(draft).toMatchObject({ revision: 1, configHash: 'sha256:aaa' });
    expect(draft?.snapshot?.sections.branding).toEqual({ section: 'branding' });
    expect(draft?.validationSummary?.findings).toEqual([]);
    expect(captureSnapshot).toHaveBeenCalledWith({
      tenantId: TENANT,
      siteId: SITE,
      kioskId: 'kiosk-1',
    });
  });

  it('保存内容が永続化される', async () => {
    await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });

    const stored = await repo.findBySite(TENANT, SITE);
    expect(stored?.versions).toHaveLength(1);
  });

  it('現構成を解決できなければ版を積まない', async () => {
    captureSnapshot.mockRejectedValue(new Error('store down'));

    const result = await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });

    expect(result).toEqual({ ok: false, reason: 'snapshot_failed' });
    await expect(repo.findBySite(TENANT, SITE)).resolves.toBeUndefined();
  });

  it('古い revision を基点にした保存は競合として拒否する', async () => {
    await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });
    await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });

    const stale = await service.saveDraft({
      ...SCOPE,
      kioskId: 'kiosk-1',
      editorId: 'admin-3',
      baseRevision: 1,
    });

    expect(stale).toEqual({ ok: false, reason: 'revision_conflict' });
  });

  it('公開後に下書きを保存しても、公開版のスナップショットは動かない（AC の中核）', async () => {
    await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });
    await publishCurrent(1);

    captureSnapshot.mockResolvedValue(snapshotOf('sha256:bbb', { branding: { changed: true } }));
    const saved = await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(publishedVersion(saved.value)?.configHash).toBe('sha256:aaa');
    expect(publishedVersion(saved.value)?.snapshot?.sections.branding).toEqual({
      section: 'branding',
    });
    expect(draftVersion(saved.value)?.configHash).toBe('sha256:bbb');
  });
});

describe('approve / publish', () => {
  it('検証 error がある下書きは承認できない（秘匿値の混入）', async () => {
    captureSnapshot.mockResolvedValue(
      snapshotOf('sha256:leak', { integrations: { apiKey: 'TEST-leak' } }),
    );
    await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });

    const approved = await service.approve({ ...SCOPE, revision: 1, approverId: 'admin-2' });

    expect(approved).toEqual({ ok: false, reason: 'validation_failed' });
  });

  it('未承認の版は公開できない', async () => {
    await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });

    const published = await service.publish({ ...SCOPE, revision: 1, publisherId: 'admin-2' });

    expect(published).toEqual({ ok: false, reason: 'not_approved' });
  });

  it('体験が存在しない拠点への操作は experience_not_found', async () => {
    await expect(
      service.approve({ ...SCOPE, revision: 1, approverId: 'admin-2' }),
    ).resolves.toEqual({ ok: false, reason: 'experience_not_found' });
  });
});

describe('rollback', () => {
  it('前の公開版の中身へ戻す', async () => {
    await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });
    await publishCurrent(1);

    captureSnapshot.mockResolvedValue(snapshotOf('sha256:bbb'));
    await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });
    await publishCurrent(2);

    const rolled = await service.rollback({ ...SCOPE, revision: 1, actorId: 'admin-2' });

    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(publishedVersion(rolled.value)).toMatchObject({
      revision: 3,
      configHash: 'sha256:aaa',
      rolledBackFrom: 1,
    });
  });
});

describe('取次到達性の検証 (#420)', () => {
  const policyWithMissingEndpoint = {
    id: 'p1',
    tenantId: 'internal',
    siteId: 'default-site',
    name: 'TEST-ポリシー',
    enabled: true,
    steps: [{ id: 's1', endpointId: 'missing', action: 'live_bridge' as const, timeoutSeconds: 20, nextOn: {} }],
  };

  it('注入したローダの指摘が検証結果へ載る', async () => {
    const svc = new ExperienceVersionService(new InMemoryExperienceRepository(), {
      captureSnapshot,
      now: () => new Date(NOW),
      loadCallRouteContext: async () => ({
        policies: [policyWithMissingEndpoint],
        endpointIds: new Set<string>(),
      }),
    });

    const result = await svc.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const findings = draftVersion(result.value)?.validationSummary?.findings ?? [];
    expect(findings.some((f) => f.check === 'call_route' && f.severity === 'error')).toBe(true);
  });

  it('取次設定を読めなくても下書き保存は止めず、warning として残す', async () => {
    const svc = new ExperienceVersionService(new InMemoryExperienceRepository(), {
      captureSnapshot,
      now: () => new Date(NOW),
      loadCallRouteContext: async () => {
        throw new Error('backend down');
      },
    });

    const result = await svc.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const findings = draftVersion(result.value)?.validationSummary?.findings ?? [];
    expect(findings).toContainEqual(
      expect.objectContaining({ check: 'call_route', severity: 'warning' }),
    );
  });

  it('ローダ未指定なら取次検査をしない（既存の呼び出し側を壊さない）', async () => {
    const result = await service.saveDraft({ ...SCOPE, kioskId: 'kiosk-1', editorId: 'admin-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const findings = draftVersion(result.value)?.validationSummary?.findings ?? [];
    expect(findings.every((f) => f.check !== 'call_route')).toBe(true);
  });
});

describe('validateSnapshot', () => {
  it('健全な構成では指摘ゼロ', () => {
    expect(validateSnapshot(snapshotOf('sha256:aaa'), NOW).findings).toEqual([]);
  });

  it('秘匿値の混入は error（値はメッセージに載せない）', () => {
    const summary = validateSnapshot(
      snapshotOf('sha256:x', { voice: { apiKey: 'TEST-secret-value' } }),
      NOW,
    );

    const errors = summary.findings.filter((f) => f.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('voice.apiKey');
    expect(JSON.stringify(summary)).not.toContain('TEST-secret-value');
  });

  it('セクション欠落は warning（公開は止めない）', () => {
    const summary = validateSnapshot({ sections: {}, configHash: 'sha256:empty' }, NOW);

    expect(summary.findings.filter((f) => f.check === 'config_schema')).toHaveLength(
      CONFIGURATION_SECTIONS.length,
    );
    // 空スナップショットでも公開を止めない（error を出さない）。
    expect(summary.findings.every((f) => f.severity === 'warning')).toBe(true);
  });
});
