'use client';

import { useEffect, useState } from 'react';
import { DangerActionPlaceholder, MetricCard } from './primitives';

/**
 * 機能フラグ / 利用制限（read 中心） (issue #90, increment 2)。
 *
 * /api/platform/feature-flags（developer 専用 read）から、プラットフォーム全体で接続済みの
 * フラグ（Vonage 通話・管理ログイン方式）を読み取り表示する。未接続項目（音声合成・VRM 受付・
 * 各種利用上限）は「未接続」と明示する。変更は破壊的操作のため DangerActionPlaceholder に隔離する。
 */
type AuthMethod = { id: string; label: string; enabled: boolean; issues: string[] };
type FlagsResponse = {
  flags: {
    vonage: { configured: boolean; enabled: boolean };
    authMethods: AuthMethod[];
    voiceSynthesis: { status: 'pending' };
    avatarReception: { status: 'pending' };
  };
  limits: Record<string, { status: 'pending' }>;
};

function boolLabel(v: boolean): string {
  return v ? '有効' : '無効';
}

export function FeatureFlags() {
  const [data, setData] = useState<FlagsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/platform/feature-flags');
      if (cancelled) return;
      if (!res.ok) {
        setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : '機能フラグの取得に失敗しました。');
        return;
      }
      setData((await res.json()) as FlagsResponse);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>機能フラグ / 利用制限</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        プラットフォーム全体の機能フラグと利用上限を確認します（読み取り中心）。機密値は表示しません。
        テナント単位の上書きと変更は次増分で、確認・昇格・監査を伴って実装します。
      </p>

      {error ? <p style={{ color: '#e0a880' }}>{error}</p> : null}

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>機能フラグ</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <MetricCard
          label="Vonage 電話通知"
          value={data ? boolLabel(data.flags.vonage.enabled) : '—'}
          note={data ? (data.flags.vonage.configured ? '設定済み' : '未設定') : undefined}
        />
        <MetricCard label="音声合成" pending note="次増分で接続" />
        <MetricCard label="VRM / アバター受付" pending note="次増分で接続" />
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>ログイン方式</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        {(data?.flags.authMethods ?? []).map((m) => (
          <MetricCard
            key={m.id}
            label={m.label}
            value={boolLabel(m.enabled)}
            note={m.issues.length > 0 ? m.issues.join(' / ') : undefined}
          />
        ))}
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>
        利用上限（実データ未接続）
      </h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <MetricCard label="受付端末上限" pending note="次増分で接続" />
        <MetricCard label="月間通話数上限" pending note="次増分で接続" />
        <MetricCard label="概算コスト上限" pending note="次増分で接続" />
      </div>

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="機能フラグ / 利用制限の変更" />
      </div>
    </section>
  );
}
