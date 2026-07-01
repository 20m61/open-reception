'use client';

import { useEffect, useState } from 'react';
import type { MaskedAuditRow } from '@/domain/platform/console-summary';
import { formatPercent } from '@/domain/util/format';
import { MetricCard } from './primitives';

/**
 * 可観測性（read 中心） (issue #90, increment 2)。
 *
 * /api/platform/observability（developer 専用 read）から、接続済みの範囲（外部連携の接続結果・
 * マスク済み直近アクティビティ）を表示する。指標（エラー率・レイテンシ等）は未接続として
 * 「未接続」を明示する。直近ログは actor をマスク済みで PII を露出しない。
 */
type Integration = {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  lastResult: 'untested' | 'success' | 'failure';
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorSummary?: string;
};
type ObservabilityResponse = {
  integrations: Integration[];
  recentActivity: MaskedAuditRow[];
  reception: { receptions: number; successRate: number | null; callFailures: number; noAnswer: number };
  devices: { total: number; online: number; offline: number };
  metrics: Record<string, { status: 'pending' }>;
};

const PENDING_METRICS: readonly { key: string; label: string }[] = [
  { key: 'errorRate', label: 'エラー率' },
  { key: 'authErrors', label: '認証エラー' },
  { key: 'lambdaApiErrors', label: 'Lambda / API エラー' },
  { key: 'latency', label: 'レイテンシ' },
  { key: 'alerts', label: 'アラート履歴' },
];

const RESULT_LABEL: Record<Integration['lastResult'], string> = {
  untested: '未テスト',
  success: '成功',
  failure: '失敗',
};

export function Observability() {
  const [data, setData] = useState<ObservabilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/platform/observability');
      if (cancelled) return;
      if (!res.ok) {
        setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : '可観測性情報の取得に失敗しました。');
        return;
      }
      setData((await res.json()) as ObservabilityResponse);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>可観測性</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        外部連携の接続結果と直近アクティビティを横断確認します（読み取り専用）。直近ログは
        マスク済みで個人情報を露出しません。エラー率・レイテンシ等の指標は次増分で接続します。
      </p>

      {error ? <p style={{ color: '#e0a880' }}>{error}</p> : null}

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>外部連携の接続状態</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', opacity: 0.6 }}>
            <th style={{ padding: '6px 8px' }}>連携</th>
            <th style={{ padding: '6px 8px' }}>設定</th>
            <th style={{ padding: '6px 8px' }}>有効</th>
            <th style={{ padding: '6px 8px' }}>直近結果</th>
            <th style={{ padding: '6px 8px' }}>要約</th>
          </tr>
        </thead>
        <tbody>
          {(data?.integrations ?? []).map((i) => (
            <tr key={i.id} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={{ padding: '6px 8px' }}>{i.label}</td>
              <td style={{ padding: '6px 8px', opacity: 0.8 }}>{i.configured ? '済' : '未'}</td>
              <td style={{ padding: '6px 8px', opacity: 0.8 }}>{i.enabled ? '有効' : '無効'}</td>
              <td style={{ padding: '6px 8px', opacity: 0.8 }}>{RESULT_LABEL[i.lastResult]}</td>
              <td style={{ padding: '6px 8px', opacity: 0.6 }}>{i.lastErrorSummary ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>受付・端末（今月・実データ）</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <MetricCard label="受付成功率" value={data ? formatPercent(data.reception?.successRate ?? null) : '—'} />
        <MetricCard label="今月の受付数" value={data?.reception?.receptions ?? '—'} />
        <MetricCard label="通話失敗数" value={data?.reception?.callFailures ?? '—'} />
        <MetricCard label="未応答" value={data?.reception?.noAnswer ?? '—'} />
        {/* enabled フラグ数（実死活=heartbeat は次増分）。 */}
        <MetricCard
          label="有効な端末"
          value={data?.devices ? `${data.devices.online}/${data.devices.total}` : '—'}
        />
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>指標（実データ未接続）</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        {PENDING_METRICS.map((m) => (
          <MetricCard key={m.key} label={m.label} pending note="次増分で接続" />
        ))}
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>
        直近アクティビティ（マスク済み）
      </h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', opacity: 0.6 }}>
            <th style={{ padding: '6px 8px' }}>日時</th>
            <th style={{ padding: '6px 8px' }}>操作</th>
            <th style={{ padding: '6px 8px' }}>主体</th>
            <th style={{ padding: '6px 8px' }}>対象</th>
          </tr>
        </thead>
        <tbody>
          {(data?.recentActivity ?? []).map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={{ padding: '6px 8px', opacity: 0.8 }}>{r.at}</td>
              <td style={{ padding: '6px 8px' }}>{r.action}</td>
              <td style={{ padding: '6px 8px', opacity: 0.7 }}>{r.actor}</td>
              <td style={{ padding: '6px 8px', opacity: 0.7 }}>
                {r.targetType ?? '-'}
                {r.targetId ? <span style={{ opacity: 0.6 }}> {r.targetId}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
