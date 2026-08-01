'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, SaveFeedback, Section, useSaveFeedback } from '@/components/admin/ui';
import { space } from '@/components/admin/ui/tokens';
import { resolveVersionActions, type VersionAction } from './experience-version-actions';
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
  /** `versions` / `rollout` がどのスコープの内容か。null = 未取得。 */
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  /** 版一覧の取得失敗（null = 失敗していない）。「版が 1 つも無い」と区別する。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rollout, setRollout] = useState<Rollout>(EMPTY_ROLLOUT);
  const [busy, setBusy] = useState(false);
  const { feedback, success, failure, clear } = useSaveFeedback();

  const qs = `tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`;

  const load = useCallback(async () => {
    // 拠点が確定するまで取りに行かない。確定前の暫定拠点で投げると、遅れて届いた応答が
    // 別拠点の版一覧を上書きし、**表示は A なのに中身は B** になる（#535 レビュー P1 と同型）。
    if (!scopeReady) return;
    const startedWith = scopeKey;
    let versionsRes: Response;
    let rolloutRes: Response;
    try {
      [versionsRes, rolloutRes] = await Promise.all([
        fetch(`/api/admin/experience-versions?${qs}`),
        fetch(`/api/admin/experience-versions/deployments?${qs}`),
      ]);
    } catch {
      // 握り潰すと unhandled rejection になり、画面には「まだ版がありません」という
      // **事実と異なる断定**だけが残る（#552 レビュー P2 と同型）。
      if (isCurrentScope(startedWith)) setLoadError('版一覧を取得できませんでした（通信エラー）。');
      return;
    }
    if (!isCurrentScope(startedWith)) return;
    if (!versionsRes.ok) {
      setLoadError(`版一覧を取得できませんでした（${versionsRes.status}）。`);
      return;
    }
    const body = await versionsRes.json();
    setVersions(body.experience?.versions ?? []);
    setLoadedScope(startedWith);
    setLoadError(null);
    // 反映状況は補助情報。取得できなくても版一覧は出す。
    setRollout(rolloutRes.ok ? await rolloutRes.json() : EMPTY_ROLLOUT);
  }, [qs, scopeReady, scopeKey, isCurrentScope]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * **いま出している版が、いま選んでいる拠点のものか。**
   *
   * `isCurrentScope` は「古い応答を反映しない」だけで、**すでに描かれている版**は守らない。
   * 拠点 A → B へ切り替えると B の応答が届くまで A の版が残り、その間に「公開」や
   * 「ロールバック」を押せてしまう。これらは body に `siteId` と `revision` を載せるので、
   * **B の拠点に対して A の revision を指定する**ことになる（#552 レビュー P1 と同型）。
   */
  const versionsLoaded = loadedScope === scopeKey;
  const scopedVersions = versionsLoaded ? versions : [];

  const draft = scopedVersions.find((v) => v.status === 'draft');
  const published = scopedVersions.find((v) => v.status === 'published');
  const rollbackTarget = scopedVersions
    .filter((v) => v.publishedAt && v.status !== 'published')
    .sort((a, b) => b.revision - a.revision)[0];

  /**
   * **ハンドラとボタンが同じ 1 つの値を見る。** 別々に書くと必ずどちらかだけ直され、
   * 「押せるのに何も起きない」サイレント no-op になる（#552 レビュー P1）。
   * 判定は純関数（`experience-version-actions.ts`）が持ち、テストで固定してある。
   *
   * **`save-draft` だけ版の取得状態に依存しない** — 一覧 GET の失敗で「現在の設定を版として
   * 固定する」復旧経路が永久に止まるのを避ける（読み取りの失敗で書き込みを殺さない）。
   */
  const actions = resolveVersionActions({
    scopeReady,
    sitePending,
    busy,
    versionsLoaded,
    draft,
    published,
    rollbackTarget,
  });

  const act = useCallback(
    async (action: VersionAction, extra: Record<string, unknown> = {}) => {
      // ボタンと同じ判定を通す（二重化は意図的。ボタン以外の経路も塞ぐ）。
      if (!actions[action]) return;
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
    [actions, clear, failure, load, siteId, success, tenantId],
  );

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
      {loadError === null ? null : (
        <p
          data-testid="experience-versions-load-error"
          role="alert"
          style={{ color: 'var(--color-danger)' }}
        >
          {loadError}{' '}
          <Button
            data-testid="experience-versions-retry"
            disabled={!scopeReady}
            onClick={() => void load()}
          >
            再試行
          </Button>
        </p>
      )}
      <Section title="操作">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm }}>
          <Button onClick={() => void act('save-draft')} disabled={!actions['save-draft']}>
            現在の設定を下書きにする
          </Button>
          <Button
            variant="secondary"
            onClick={() => void act('approve', { revision: draft?.revision })}
            disabled={!actions.approve}
          >
            下書きを承認
          </Button>
          <Button
            onClick={() => void act('publish', { revision: draft?.revision })}
            disabled={!actions.publish}
          >
            公開する
          </Button>
          <Button
            variant="secondary"
            onClick={() => void act('rollback', { revision: rollbackTarget?.revision })}
            disabled={!actions.rollback}
          >
            {rollbackTarget ? `rev.${rollbackTarget.revision} へ切り戻す` : '切り戻す'}
          </Button>
        </div>
        <SaveFeedback feedback={feedback} />
      </Section>

      <ExperienceVersionsView
        versions={scopedVersions}
        desired={rollout.desired}
        deployments={rollout.deployments}
        summary={rollout.summary}
      />
    </div>
  );
}
