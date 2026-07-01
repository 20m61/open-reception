'use client';

import { useEffect, useState } from 'react';
import type {
  UpdateScope,
  UpdateState,
  UpdateStatusRow,
  UpdateStatusSummary,
} from '@/domain/platform/update-status';
import { DangerActionPlaceholder, MetricCard } from './primitives';

/**
 * アップデート状況（read 中心） (issue #83 AC6)。
 *
 * /api/platform/updates（developer 専用 read）から、Tenant/Site/Device 単位のアップデート状況を
 * 横断確認する。機密値・PII・操作者識別子は含めない。対象テナント選択中は全体影響＋当該テナントに
 * 絞り込まれる。実際の更新実行（デプロイ/ロールバック）は影響範囲が広いため、確認・昇格・監査を
 * 伴う導線（DangerActionPlaceholder）に隔離する。
 */
type UpdatesResponse = { updates: UpdateStatusSummary };

const STATE_LABEL: Record<UpdateState, string> = {
  up_to_date: '最新',
  update_available: '更新あり',
  updating: '更新中',
  failed: '失敗',
};

const SCOPE_LABEL: Record<UpdateScope, string> = {
  platform: '全体',
  tenant: 'テナント',
  site: '拠点',
  device: '端末',
};

function scopeTarget(r: UpdateStatusRow): string {
  if (r.scope === 'platform') return '全体';
  return r.deviceId ?? r.siteId ?? r.tenantId ?? r.scope;
}

export function UpdateStatus() {
  const [data, setData] = useState<UpdatesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/platform/updates');
        if (cancelled) return;
        if (!res.ok) {
          setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : 'アップデート状況の取得に失敗しました。');
          return;
        }
        setData((await res.json()) as UpdatesResponse);
      } catch {
        // ネットワーク断・レスポンス解析失敗を握り潰さずエラー表示する。
        if (!cancelled) setError('アップデート状況の取得に失敗しました。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = data?.updates.updates ?? [];

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>アップデート状況</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        テナント / 拠点 / 端末単位のアップデート状況を横断確認します（読み取り中心）。対象テナント選択中は
        全体影響＋当該テナントに絞り込まれます。更新の実行・ロールバックは影響範囲が広いため、確認・
        昇格・監査を伴う導線に隔離します。
      </p>

      {error ? <p style={{ color: '#e0a880' }}>{error}</p> : null}

      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap', marginBottom: 'var(--space-md)' }}>
        <MetricCard label="要対応（更新待ち/中/失敗）" value={data ? data.updates.pendingCount : '—'} />
        <MetricCard label="更新失敗" value={data ? data.updates.byState.failed : '—'} />
        <MetricCard label="更新あり" value={data ? data.updates.byState.update_available : '—'} />
        <MetricCard label="全対象" value={data ? data.updates.totalCount : '—'} />
      </div>

      {!data && !error ? <p style={{ opacity: 0.7 }}>読み込み中…</p> : null}
      {data && rows.length === 0 ? (
        <p style={{ opacity: 0.7 }}>アップデート状況の登録はありません。</p>
      ) : null}
      {rows.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.6 }}>
              <th style={{ padding: '6px 8px' }}>状況</th>
              <th style={{ padding: '6px 8px' }}>範囲</th>
              <th style={{ padding: '6px 8px' }}>対象</th>
              <th style={{ padding: '6px 8px' }}>コンポーネント</th>
              <th style={{ padding: '6px 8px' }}>現行→最新</th>
              <th style={{ padding: '6px 8px' }}>確認日時</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid rgba(255,255,255,0.08)', opacity: r.pending ? 1 : 0.6 }}>
                <td style={{ padding: '6px 8px' }}>{STATE_LABEL[r.state]}</td>
                <td style={{ padding: '6px 8px', opacity: 0.7 }}>{SCOPE_LABEL[r.scope]}</td>
                <td style={{ padding: '6px 8px', opacity: 0.7 }}>{scopeTarget(r)}</td>
                <td style={{ padding: '6px 8px' }}>{r.component}</td>
                <td style={{ padding: '6px 8px', opacity: 0.8 }}>
                  {r.currentVersion}
                  {r.currentVersion !== r.latestVersion ? ` → ${r.latestVersion}` : ''}
                </td>
                <td style={{ padding: '6px 8px', opacity: 0.7 }}>{r.checkedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="アップデート実行 / ロールバック" />
      </div>
    </section>
  );
}
