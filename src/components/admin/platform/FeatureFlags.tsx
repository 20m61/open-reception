'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  TENANT_FEATURE_FLAG_KEYS,
  TENANT_FEATURE_FLAG_LABELS,
  type TenantFeatureFlagKey,
} from '@/domain/platform/feature-flags';
import {
  buildFeatureFlagUpdatePayload,
  featureFlagUpdateError,
  type ElevatedWriteError,
} from '@/lib/platform/client-elevation';
import { DangerActionPlaceholder, MetricCard } from './primitives';

/**
 * 機能フラグ / 利用制限 (issue #90 inc2 / #83 inc5a)。
 *
 * read: /api/platform/feature-flags（プラットフォーム全体のフラグ + テナント別フラグのサマリ）と
 * /api/platform/tenants/[tenantId]/feature-flags（テナント単位の実効値）。
 * write: 同ルートへの PATCH（#83 §1「機能制限の変更」= 昇格必須の破壊的操作）。
 *
 * セキュリティ: 昇格・監査の強制は**サーバ（assertElevated + recordDangerAction）が本体**。
 * この UI は入力と誘導の UX のみで、クライアント判定に保護を置かない。非昇格時はサーバが
 * 403 elevation_required を返すため、画面上部の昇格パネル（#platform-elevation）へ誘導する。
 * 楽観更新はせず、成功後にサーバから再取得する（既存 platform write UI の型に合わせる）。
 */
type AuthMethod = { id: string; label: string; enabled: boolean; issues: string[] };
type TenantFlagSummary = { defaultEnabled: boolean; disabledTenants: number };
type FlagsResponse = {
  flags: {
    vonage: { configured: boolean; enabled: boolean };
    authMethods: AuthMethod[];
    voiceSynthesis: TenantFlagSummary;
    avatarReception: TenantFlagSummary;
  };
  limits: Record<string, { status: 'pending' }>;
};
type TenantRow = { id: string; name: string; slug: string; status: 'active' | 'suspended' };
type TenantFlagsResponse = {
  tenantId: string;
  flags: Record<TenantFeatureFlagKey, boolean>;
  updatedAt?: string;
};

function boolLabel(v: boolean): string {
  return v ? '有効' : '無効';
}

export function FeatureFlags() {
  const [data, setData] = useState<FlagsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    const res = await fetch('/api/platform/feature-flags');
    if (!res.ok) {
      setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : '機能フラグの取得に失敗しました。');
      return;
    }
    setData((await res.json()) as FlagsResponse);
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const summaryValue = (s: TenantFlagSummary | undefined) =>
    s ? `既定 ${boolLabel(s.defaultEnabled)}` : '—';
  const summaryNote = (s: TenantFlagSummary | undefined) =>
    s ? (s.disabledTenants > 0 ? `無効化テナント ${s.disabledTenants} 件` : '全テナント既定値') : undefined;

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>機能フラグ / 利用制限</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        プラットフォーム全体の機能フラグと利用上限を確認し、テナント単位で機能を切り替えます。
        機密値は表示しません。変更（機能制限の変更）は JIT 昇格が必要な破壊的操作で、監査に記録されます。
      </p>

      {error ? <p style={{ color: 'var(--color-platform-warn)' }}>{error}</p> : null}

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>機能フラグ</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <MetricCard
          label="Vonage 電話通知"
          value={data ? boolLabel(data.flags.vonage.enabled) : '—'}
          note={data ? (data.flags.vonage.configured ? '設定済み' : '未設定') : undefined}
        />
        <MetricCard
          label="音声合成"
          value={summaryValue(data?.flags.voiceSynthesis)}
          note={summaryNote(data?.flags.voiceSynthesis)}
        />
        <MetricCard
          label="VRM / アバター受付"
          value={summaryValue(data?.flags.avatarReception)}
          note={summaryNote(data?.flags.avatarReception)}
        />
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

      <TenantFeatureFlagEditor onChanged={() => void loadSummary()} />

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>
        利用上限（実データ未接続）
      </h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <MetricCard label="受付端末上限" pending note="メータリング接続後" />
        <MetricCard label="月間通話数上限" pending note="メータリング接続後" />
        <MetricCard label="概算コスト上限" pending note="メータリング接続後" />
      </div>

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="利用上限の変更" />
      </div>
    </section>
  );
}

/**
 * テナント別機能フラグの編集（昇格つき write, #83 inc5a）。
 * テナントを選び、フラグごとに理由つきで切替える。成功後はサーバから再取得（楽観更新なし）。
 */
function TenantFeatureFlagEditor({ onChanged }: { onChanged?: () => void }) {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [tenantId, setTenantId] = useState<string>('');
  const [flags, setFlags] = useState<TenantFlagsResponse | null>(null);
  const [reason, setReason] = useState('');
  const [busyKey, setBusyKey] = useState<TenantFeatureFlagKey | null>(null);
  const [writeError, setWriteError] = useState<ElevatedWriteError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/platform/tenants');
      if (cancelled || !res.ok) return;
      const body = (await res.json()) as { tenants: TenantRow[] };
      setTenants(body.tenants);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadTenantFlags = useCallback(async (id: string) => {
    setFlags(null);
    if (id === '') return;
    const res = await fetch(`/api/platform/tenants/${encodeURIComponent(id)}/feature-flags`);
    if (!res.ok) {
      setWriteError({ needsElevation: false, message: 'テナントの機能フラグの取得に失敗しました。' });
      return;
    }
    setFlags((await res.json()) as TenantFlagsResponse);
  }, []);

  function selectTenant(id: string) {
    setTenantId(id);
    setWriteError(null);
    setDone(null);
    void loadTenantFlags(id);
  }

  async function toggle(key: TenantFeatureFlagKey, enable: boolean) {
    setWriteError(null);
    setDone(null);
    const built = buildFeatureFlagUpdatePayload({ key, enable, reason });
    if (!built.ok) {
      setWriteError({ needsElevation: false, message: built.error });
      return;
    }
    setBusyKey(key);
    try {
      const res = await fetch(`/api/platform/tenants/${encodeURIComponent(tenantId)}/feature-flags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.payload),
      });
      const resBody: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setWriteError(featureFlagUpdateError(res.status, resBody));
        return;
      }
      setDone(
        `「${TENANT_FEATURE_FLAG_LABELS[key]}」を${enable ? '有効' : '無効'}にしました（監査に記録済み）。`,
      );
      setReason('');
      // 楽観更新はしない: サーバ応答が正。テナントの実効値と横断サマリを再取得する。
      await loadTenantFlags(tenantId);
      onChanged?.();
    } catch {
      setWriteError({ needsElevation: false, message: '機能フラグ変更リクエストの送信に失敗しました。' });
    } finally {
      setBusyKey(null);
    }
  }

  const inputStyle = {
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 8,
    padding: '6px 10px',
    color: 'inherit',
    fontSize: '0.85rem',
    boxSizing: 'border-box',
  } as const;

  return (
    <div
      data-testid="tenant-feature-flag-editor"
      style={{
        marginTop: 'var(--space-lg)',
        maxWidth: 760,
        border: '1px solid color-mix(in srgb, var(--color-platform-warn) 40%, transparent)',
        borderRadius: 10,
        padding: 'var(--space-md)',
        display: 'grid',
        gap: 'var(--space-sm)',
        fontSize: '0.85rem',
      }}
    >
      <strong style={{ color: 'var(--color-platform-warn)' }}>テナント別機能フラグの変更（昇格が必要な操作）</strong>
      <p style={{ margin: 0, opacity: 0.7 }}>
        テナントごとに利用できる機能を切り替えます。実行には対象テナントを覆う JIT
        昇格が必要で、操作理由・変更前後の値とともに監査に記録されます。無効化しても設定・データは保持されます。
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        対象テナント
        <select
          value={tenantId}
          onChange={(e) => selectTenant(e.target.value)}
          style={{ ...inputStyle, width: 'auto' }}
        >
          <option value="">選択してください</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}（{t.slug}）{t.status === 'suspended' ? ' — 停止中' : ''}
            </option>
          ))}
        </select>
      </label>

      {tenantId !== '' && flags ? (
        <>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="操作理由（必須・監査に記録）"
            aria-label="操作理由"
            style={{ ...inputStyle, width: '100%' }}
          />
          <div style={{ display: 'grid', gap: 6 }}>
            {TENANT_FEATURE_FLAG_KEYS.map((key) => (
              <div
                key={key}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' }}
              >
                <span style={{ minWidth: 180 }}>{TENANT_FEATURE_FLAG_LABELS[key]}</span>
                <span style={{ color: flags.flags[key] ? 'var(--color-platform-ok)' : 'var(--color-platform-warn)' }}>
                  {boolLabel(flags.flags[key])}
                </span>
                <button
                  type="button"
                  disabled={busyKey !== null}
                  onClick={() => void toggle(key, !flags.flags[key])}
                  style={{ ...inputStyle, cursor: 'pointer' }}
                >
                  {busyKey === key ? '変更中…' : flags.flags[key] ? '昇格つきで無効化' : '昇格つきで有効化'}
                </button>
              </div>
            ))}
          </div>
          {flags.updatedAt ? (
            <p style={{ margin: 0, opacity: 0.5, fontSize: '0.75rem' }}>
              最終変更: {new Date(flags.updatedAt).toLocaleString('ja-JP')}
            </p>
          ) : null}
        </>
      ) : null}
      {tenantId !== '' && !flags && !writeError ? <p style={{ margin: 0, opacity: 0.6 }}>読み込み中…</p> : null}

      {writeError ? (
        <p role="alert" style={{ color: 'var(--color-platform-warn)', margin: 0 }}>
          {writeError.message}
          {writeError.needsElevation ? (
            <>
              {' '}
              <a href="#platform-elevation" style={{ color: 'var(--color-platform-warn)', textDecoration: 'underline' }}>
                画面上部の「JIT 昇格」パネルから昇格する
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {done ? <p style={{ color: 'var(--color-platform-ok)', margin: 0 }}>{done}</p> : null}
    </div>
  );
}
