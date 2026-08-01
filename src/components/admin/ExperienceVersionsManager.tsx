'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, SaveFeedback, Section, useSaveFeedback } from '@/components/admin/ui';
import { space } from '@/components/admin/ui/tokens';
import { hasValidationErrors } from '@/domain/experience-version/deployment-view';
import type { ReceptionExperienceVersion } from '@/domain/experience-version/types';
import {
  ExperienceVersionsView,
  type DeploymentRowView,
} from './ExperienceVersionsView';
import type { RolloutCounts } from '@/domain/experience-version/deployment-view';
import { useSiteScope } from './use-site-scope';
import { SiteScopeSelect } from './SiteScopeSelect';

type Rollout = {
  desired: { revision: number; publishedAt?: string } | null;
  deployments: DeploymentRowView[];
  summary: RolloutCounts | null;
};

const EMPTY_ROLLOUT: Rollout = { desired: null, deployments: [], summary: null };

/**
 * 受付体験の版管理 (issue #420)。
 *
 * 「現在の設定を下書きとして固定 → 承認 → 公開 → 端末への反映を確認」の運用導線。
 * 表示は `ExperienceVersionsView`（純粋）に委ね、ここは取得と操作だけを持つ。
 *
 * **下書き保存が固定するのは「いまの設定ストアの内容」**。個別の設定画面（ブランディング・
 * 音声・サイネージ等）で編集したあと、ここで下書き化して公開する。公開するまで端末へは
 * 届かない（`docs/product-integration-plan.md` §9 B-06）。
 *
 * 構成の中身は API 応答に含まれないため、内容の確認はプレビュー
 * （`/api/configuration/effective?version=draft`）で行う。
 *
 * 構成解決に使う代表端末はサーバ側が拠点の端末台帳から選ぶ（画面は端末 ID を持たない）。
 */
export function ExperienceVersionsManager({
  tenantId,
  siteId: defaultSiteId,
}: {
  tenantId: string;
  /** サーバ (`resolveDefaultScope`) 由来の既定拠点。URL 未指定時のフォールバック。 */
  siteId: string;
}) {
  /**
   * 対象拠点は URL が真実源 (#554)。以前は既定拠点に固定で、**UI から別拠点の版管理へ
   * 到達する手段が無く**、ヘッダの対象拠点表示（#423）も黙っていた。拠点別 5 画面と
   * 同じ `useSiteScope` に揃える。
   */
  const { sites, siteId, scopeKey, scopeReady, isCurrentScope, selectSite, sitePending, listStatus } =
    useSiteScope(tenantId, defaultSiteId);
  const [versions, setVersions] = useState<ReceptionExperienceVersion[]>([]);
  const [rollout, setRollout] = useState<Rollout>(EMPTY_ROLLOUT);
  const [busy, setBusy] = useState(false);
  const { feedback, success, failure, clear } = useSaveFeedback();

  const qs = `tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`;

  const load = useCallback(async () => {
    // 拠点が確定するまで取りに行かない。確定前の暫定拠点で投げると、遅れて届いた応答が
    // 別拠点の版一覧を上書きし、**表示は A なのに中身は B** になる（#535 レビュー P1 と同型）。
    if (!scopeReady) return;
    const startedWith = scopeKey;
    const [versionsRes, rolloutRes] = await Promise.all([
      fetch(`/api/admin/experience-versions?${qs}`),
      fetch(`/api/admin/experience-versions/deployments?${qs}`),
    ]);
    if (!isCurrentScope(startedWith)) return;
    if (versionsRes.ok) {
      const body = await versionsRes.json();
      setVersions(body.experience?.versions ?? []);
    }
    // 反映状況は補助情報。取得できなくても版一覧は出す。
    setRollout(rolloutRes.ok ? await rolloutRes.json() : EMPTY_ROLLOUT);
  }, [qs, scopeReady, scopeKey, isCurrentScope]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      // 拠点が確定するまで・切替が確定するまで書き込まない。ここを開けると
      // **別拠点の版を公開・ロールバック**できてしまう（body に siteId を載せるため）。
      if (!scopeReady || sitePending) return;
      setBusy(true);
      clear();
      try {
        const res = await fetch('/api/admin/experience-versions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId, siteId, action, ...extra }),
        });
        if (res.ok) {
          success('更新しました');
          await load();
        } else {
          const body = await res.json().catch(() => ({}));
          // 失敗理由をそのまま出す（承認前の公開・競合・検証エラーを運用者が区別できるように）。
          failure(`失敗しました: ${body.error ?? res.status}`);
        }
      } catch {
        failure('通信に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [clear, failure, load, scopeReady, sitePending, siteId, success, tenantId],
  );

  const draft = versions.find((v) => v.status === 'draft');
  const published = versions.find((v) => v.status === 'published');
  const rollbackTarget = versions
    .filter((v) => v.publishedAt && v.status !== 'published')
    .sort((a, b) => b.revision - a.revision)[0];

  return (
    <div style={{ display: 'grid', gap: space.lg }}>
      {/* 対象拠点を常時表示し、ここから切り替えられるようにする (#554)。 */}
      <SiteScopeSelect
        sites={sites}
        siteId={siteId}
        onSelect={selectSite}
        disabled={sitePending}
        status={listStatus}
        testId="experience-versions-site-select"
      />
      <Section title="操作">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm }}>
          <Button onClick={() => void act('save-draft')} disabled={busy}>
            現在の設定を下書きにする
          </Button>
          <Button
            variant="secondary"
            onClick={() => void act('approve', { revision: draft?.revision })}
            disabled={busy || !draft || draft.approvedBy !== undefined || hasValidationErrors(draft)}
          >
            下書きを承認
          </Button>
          <Button
            onClick={() => void act('publish', { revision: draft?.revision })}
            disabled={busy || !draft || draft.approvedBy === undefined}
          >
            公開する
          </Button>
          <Button
            variant="secondary"
            onClick={() => void act('rollback', { revision: rollbackTarget?.revision })}
            disabled={busy || !rollbackTarget || !published}
          >
            {rollbackTarget ? `rev.${rollbackTarget.revision} へ切り戻す` : '切り戻す'}
          </Button>
        </div>
        <SaveFeedback feedback={feedback} />
      </Section>

      <ExperienceVersionsView
        versions={versions}
        desired={rollout.desired}
        deployments={rollout.deployments}
        summary={rollout.summary}
      />
    </div>
  );
}
