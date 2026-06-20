'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DashboardSummary } from '@/domain/reception/dashboard-summary';
import { Button } from '@/components/admin/ui';
import { StatusBadge } from './StatusBadge';
import { MetricCard } from './MetricCard';
import { Section, CardGrid } from './Section';
import { RecentCalls } from './RecentCalls';

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; summary: DashboardSummary };

/**
 * テナント管理者向けダッシュボード概況 (issue #86, increment 1)。
 *
 * 受付が安全に動いているか・本日の呼び出し状況・端末稼働を一目で把握し、
 * 各管理画面（受付履歴/端末/部署/担当者/セキュリティ/監査）への導線を提供する。
 * 概況は集約 API（/api/admin/dashboard）から 1 度に取得する（過剰な API を叩かない）。
 *
 * 実データが未接続の指標（Vonage 連携状態・利用量・予想コスト・お知らせ）は
 * プレースホルダ + design 注記で表示し、本実装を #89/#82/#90 に委譲する。
 * ロール/テナント境界に沿った表示制御は #85 の actor 解決連携後に厳密化する。
 */
export function Dashboard() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const res = await fetch('/api/admin/dashboard');
      if (!res.ok) {
        setState({ phase: 'error' });
        return;
      }
      setState({ phase: 'ready', summary: (await res.json()) as DashboardSummary });
    } catch {
      setState({ phase: 'error' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === 'loading') {
    return (
      <p data-testid="dashboard-loading" style={{ opacity: 0.7 }}>
        概況を読み込み中です…
      </p>
    );
  }

  if (state.phase === 'error') {
    return (
      <div data-testid="dashboard-error">
        <p style={{ color: 'var(--color-danger)' }}>概況の取得に失敗しました。</p>
        <Button variant="secondary" onClick={() => void load()}>
          再読み込み
        </Button>
      </div>
    );
  }

  const { status, today, devices, recentCalls } = state.summary;
  const callProblem = today.failed + today.timeout;

  return (
    <div data-testid="dashboard">
      <header style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 'var(--space-lg, 24px)' }}>
        <h1 style={{ margin: 0 }}>ダッシュボード</h1>
        <StatusBadge status={status} />
      </header>
      <p style={{ opacity: 0.8, marginTop: 0, maxWidth: 680 }}>
        受付がいま安全に動いているかを確認できます。気になる項目はカードから各管理画面へ移動できます。
      </p>

      <Section title="本日の受付状況">
        <CardGrid>
          <MetricCard label="本日の受付件数" value={today.total} unit="件" href="/admin/receptions" hint="今日これまでの受付数" />
          <MetricCard label="呼び出し成功" value={today.connected} unit="件" tone="success" href="/admin/receptions" />
          <MetricCard
            label="未応答・失敗"
            value={callProblem}
            unit="件"
            tone={callProblem > 0 ? 'warning' : 'neutral'}
            href="/admin/receptions"
            hint={`未応答 ${today.timeout} / 失敗 ${today.failed}`}
          />
          <MetricCard label="代替導線の利用" value={today.fallbackUsed} unit="件" href="/admin/receptions" hint="呼び出しできず別手段に切替えた件数" />
        </CardGrid>
      </Section>

      <Section title="受付端末">
        <CardGrid>
          <MetricCard
            label="オンライン端末"
            value={`${devices.online} / ${devices.total}`}
            tone={devices.total > 0 && devices.online === 0 ? 'danger' : devices.offline > 0 ? 'warning' : 'success'}
            href="/admin/kiosks"
            hint={devices.offline > 0 ? `${devices.offline} 台がオフラインです` : 'すべての端末が稼働中'}
          />
          <MetricCard
            label="Vonage 連携状態"
            tone="neutral"
            href="/admin/voice"
            placeholder
            note="連携状態の実データは #82/#90 で接続予定（design 注記）"
          >
            <span style={{ fontSize: '1.1rem', fontWeight: 700, opacity: 0.7 }}>準備中</span>
          </MetricCard>
        </CardGrid>
      </Section>

      <Section title="利用量・コスト（概況）">
        <CardGrid>
          <MetricCard
            label="今月の利用量"
            href="/admin/audit"
            placeholder
            note="利用量サマリは #89 で実装（概況サマリからの導線）"
          >
            <span style={{ fontSize: '1.1rem', fontWeight: 700, opacity: 0.7 }}>準備中</span>
          </MetricCard>
          <MetricCard
            label="今月の予想コスト"
            href="/admin/audit"
            placeholder
            note="「概算」「予想」コストは #89 で実装"
          >
            <span style={{ fontSize: '1.1rem', fontWeight: 700, opacity: 0.7 }}>準備中</span>
          </MetricCard>
          <MetricCard
            label="重要なお知らせ"
            href="/admin/audit"
            placeholder
            note="メンテナンス情報・警告は #90 で実装"
          >
            <span style={{ fontSize: '1.1rem', fontWeight: 700, opacity: 0.7 }}>現在お知らせはありません</span>
          </MetricCard>
        </CardGrid>
      </Section>

      <Section title="直近の呼び出し履歴">
        <RecentCalls calls={recentCalls} />
      </Section>

      <Section title="各管理画面へ">
        <CardGrid>
          <MetricCard label="受付履歴" href="/admin/receptions" hint="呼び出しの記録を確認" />
          <MetricCard label="受付端末" href="/admin/kiosks" hint="端末の登録・失効" />
          <MetricCard label="部署" href="/admin/departments" hint="呼び出し先の部署" />
          <MetricCard label="担当者" href="/admin/staff" hint="呼び出し先の担当者" />
          <MetricCard label="セキュリティ" href="/admin/security" hint="アクセス制御・緊急停止" />
          <MetricCard label="監査ログ" href="/admin/audit" hint="操作・受付の証跡" />
        </CardGrid>
      </Section>
    </div>
  );
}
