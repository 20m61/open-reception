'use client';

import { useEffect, useState } from 'react';
import type { MaintenanceSummary } from '@/domain/platform/console-summary';
import type { IncidentRow, IncidentSeverity, IncidentSummary } from '@/domain/platform/incident';
import type {
  MaintenanceImpact,
  MaintenanceWindowRow,
  MaintenanceWindowStatus,
  MaintenanceWindowSummary,
} from '@/domain/platform/maintenance-window';
import { DangerActionPlaceholder, MetricCard } from './primitives';

/**
 * メンテナンス状況・障害情報（read 中心） (issue #90, increment 2/3e)。
 *
 * /api/platform/maintenance（developer 専用 read）から、メンテナンス表示中の端末と
 * 障害・インシデントを横断確認する。機密値・PII・操作者識別子は含めない。お知らせ（notices）は
 * 未接続として明示する。メンテナンス発動・障害登録などの破壊的操作は影響範囲が広いため
 * DangerActionPlaceholder に隔離する。
 */
type MaintenanceResponse = {
  summary: MaintenanceSummary;
  incidents: IncidentSummary;
  windows: MaintenanceWindowSummary;
  notices: { status: 'pending' };
};

const WINDOW_STATUS_LABEL: Record<MaintenanceWindowStatus, string> = {
  scheduled: '予定',
  active: '進行中',
  completed: '完了',
  cancelled: '取消',
};

const IMPACT_LABEL: Record<MaintenanceImpact, string> = {
  notice_only: '案内のみ',
  limited: '一部制限',
  read_only: '読み取り専用',
  unavailable: '利用不可',
};

function windowScopeLabel(w: MaintenanceWindowRow): string {
  if (w.scope === 'platform') return '全体';
  return w.deviceId ?? w.siteId ?? w.tenantId ?? w.scope;
}

const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  info: '情報',
  minor: '軽微',
  major: '重大',
  critical: '致命的',
};

const STATUS_LABEL: Record<IncidentRow['status'], string> = {
  investigating: '調査中',
  identified: '原因特定',
  monitoring: '経過観察',
  resolved: '復旧済',
};

function incidentScopeLabel(i: IncidentRow): string {
  if (i.scope === 'platform') return '全体';
  return i.deviceId ?? i.siteId ?? i.tenantId ?? i.scope;
}

export function MaintenanceStatus() {
  const [data, setData] = useState<MaintenanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/platform/maintenance');
      if (cancelled) return;
      if (!res.ok) {
        setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : 'メンテナンス状況の取得に失敗しました。');
        return;
      }
      setData((await res.json()) as MaintenanceResponse);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>メンテナンス</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        メンテナンス表示中の端末と障害・インシデントを横断確認します（読み取り中心）。お知らせ
        （notices）の表示は次増分で接続します。状態の変更・障害登録は影響範囲が広いため、確認・
        昇格・監査を伴う導線に隔離します。
      </p>

      {error ? <p style={{ color: '#e0a880' }}>{error}</p> : null}

      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap', marginBottom: 'var(--space-md)' }}>
        <MetricCard
          label="メンテナンス表示中の端末"
          value={data ? data.summary.devicesInMaintenance : '—'}
        />
        <MetricCard label="進行中の障害" value={data ? data.incidents.activeCount : '—'} />
        <MetricCard
          label="メンテナンス予定/進行"
          value={data ? data.windows.scheduledCount + data.windows.activeCount : '—'}
        />
        <MetricCard label="お知らせ（notices）" pending note="次増分で接続" />
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>メンテナンス表示中の端末</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', opacity: 0.6 }}>
            <th style={{ padding: '6px 8px' }}>テナント</th>
            <th style={{ padding: '6px 8px' }}>端末</th>
            <th style={{ padding: '6px 8px' }}>サイト</th>
          </tr>
        </thead>
        <tbody>
          {(data?.summary.devices ?? []).map((d) => (
            <tr key={d.deviceId} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={{ padding: '6px 8px' }}>{d.tenantName}</td>
              <td style={{ padding: '6px 8px' }}>{d.deviceName}</td>
              <td style={{ padding: '6px 8px', opacity: 0.7 }}>{d.siteId}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>障害・インシデント</h2>
      {data && data.incidents.incidents.length === 0 ? (
        <p style={{ opacity: 0.7 }}>登録された障害情報はありません。</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.6 }}>
              <th style={{ padding: '6px 8px' }}>重大度</th>
              <th style={{ padding: '6px 8px' }}>状態</th>
              <th style={{ padding: '6px 8px' }}>範囲</th>
              <th style={{ padding: '6px 8px' }}>概要</th>
              <th style={{ padding: '6px 8px' }}>発生</th>
            </tr>
          </thead>
          <tbody>
            {(data?.incidents.incidents ?? []).map((i) => (
              <tr
                key={i.id}
                style={{ borderTop: '1px solid rgba(255,255,255,0.08)', opacity: i.active ? 1 : 0.55 }}
              >
                <td style={{ padding: '6px 8px' }}>{SEVERITY_LABEL[i.severity]}</td>
                <td style={{ padding: '6px 8px', opacity: 0.8 }}>{STATUS_LABEL[i.status]}</td>
                <td style={{ padding: '6px 8px', opacity: 0.7 }}>{incidentScopeLabel(i)}</td>
                <td style={{ padding: '6px 8px' }}>{i.title}</td>
                <td style={{ padding: '6px 8px', opacity: 0.7 }}>{i.startedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>予定メンテナンス</h2>
      {data && data.windows.windows.length === 0 ? (
        <p style={{ opacity: 0.7 }}>予定メンテナンスはありません。</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.6 }}>
              <th style={{ padding: '6px 8px' }}>状態</th>
              <th style={{ padding: '6px 8px' }}>範囲</th>
              <th style={{ padding: '6px 8px' }}>影響</th>
              <th style={{ padding: '6px 8px' }}>概要</th>
              <th style={{ padding: '6px 8px' }}>開始</th>
              <th style={{ padding: '6px 8px' }}>終了</th>
            </tr>
          </thead>
          <tbody>
            {(data?.windows.windows ?? []).map((w) => (
              <tr
                key={w.id}
                style={{ borderTop: '1px solid rgba(255,255,255,0.08)', opacity: w.open ? 1 : 0.55 }}
              >
                <td style={{ padding: '6px 8px' }}>{WINDOW_STATUS_LABEL[w.status]}</td>
                <td style={{ padding: '6px 8px', opacity: 0.7 }}>{windowScopeLabel(w)}</td>
                <td style={{ padding: '6px 8px', opacity: 0.8 }}>{IMPACT_LABEL[w.impact]}</td>
                <td style={{ padding: '6px 8px' }}>{w.message}</td>
                <td style={{ padding: '6px 8px', opacity: 0.7 }}>{w.startsAt}</td>
                <td style={{ padding: '6px 8px', opacity: 0.7 }}>{w.endsAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="メンテナンスモード発動 / お知らせ・障害情報の登録" />
      </div>
    </section>
  );
}
