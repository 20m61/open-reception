'use client';

import { useEffect, useState } from 'react';
import type { AdminAuthStatus, EntraSettingStatus } from '@/lib/auth/admin-auth-config';
import { Section, StatusBadge } from '@/components/admin/ui';

/**
 * 認証方式設定（Microsoft Entra ID オプション）の状態表示 (issue #70)。
 *
 * セキュリティ最優先:
 *   - Client Secret / アクセストークン / issuer・clientId 等の**値は一切表示しない**。
 *     表示するのは provider・required・各設定の有無（設定済み/未設定）・許可ロール・
 *     設定エラー/警告の要約のみ。API レスポンスにも機密値は含まれない。
 *   - 値の登録・変更は env / Secrets Manager 側で行う旨を明示する（この画面は状態のみ）。
 *
 * #93（/admin/integrations）との役割分担: #93 はログイン方式 + 外部連携 + secret の横断
 * 一覧。本画面は Entra に特化した詳細（各設定の個別状態と有効化導線）を担う。
 */
const PROVIDER_LABEL: Record<string, string> = {
  none: '共有パスワード（既定）',
  cognito: 'Amazon Cognito',
  entra: 'Microsoft Entra ID',
};

const SETTING_LABEL: Record<EntraSettingStatus['key'], string> = {
  issuer: 'Issuer（ENTRA_ISSUER / ENTRA_TENANT_ID）',
  audience: 'Audience（ENTRA_AUDIENCE / ENTRA_CLIENT_ID）',
  jwksUri: 'JWKS URI（issuer から導出）',
  clientId: 'Client ID（ENTRA_CLIENT_ID）',
  allowedRoles: '許可ロール（ADMIN_ALLOWED_ROLES）',
};

const COGNITO_SETTING_LABEL: Record<string, string> = {
  userPoolId: 'User Pool ID（COGNITO_USER_POOL_ID）',
  clientId: 'App Client ID（COGNITO_CLIENT_ID）',
  region: 'Region（COGNITO_REGION）',
  issuer: 'Issuer（region/poolId から導出）',
  jwksUri: 'JWKS URI（issuer から導出）',
  allowedRoles: '許可ロール（ADMIN_ALLOWED_ROLES）',
};

export function AuthMethodSettings() {
  const [status, setStatus] = useState<AdminAuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const res = await fetch('/api/admin/auth');
      if (!active) return;
      if (!res.ok) {
        setError(res.status === 403 ? '閲覧権限がありません。' : '状態を取得できませんでした。');
        return;
      }
      setStatus((await res.json()) as AdminAuthStatus);
    })();
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>認証方式</h1>
        <p className="notice notice--danger" style={{ padding: 12 }}>
          {error}
        </p>
      </section>
    );
  }

  if (!status) {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>認証方式</h1>
        <p>読み込み中…</p>
      </section>
    );
  }

  const providerKind = status.ok ? 'ok' : 'critical';

  return (
    <section style={{ maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>認証方式（Microsoft Entra ID）</h1>
      <p style={{ opacity: 0.75, marginTop: -4 }}>
        管理画面のログイン方式と Entra ID の必須設定の<strong>状態</strong>を確認します。
        Client Secret・トークン・各設定値そのものはこの画面には表示されません。
      </p>

      <Section title="現在の認証方式" description="ADMIN_AUTH_PROVIDER で切り替えます。">
        <div data-testid="auth-provider" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <strong data-testid="auth-provider-value">
            {PROVIDER_LABEL[status.provider] ?? status.provider}
          </strong>
          <StatusBadge status={providerKind} label={status.ok ? '設定OK' : '要設定'} />
          <span data-testid="auth-required" style={{ fontSize: '0.85rem', opacity: 0.75 }}>
            認証必須: {status.required ? '有効' : '無効（PoC/ローカル）'}
          </span>
        </div>
        {status.errors.length > 0 ? (
          <ul data-testid="auth-errors" style={{ margin: '8px 0 0', color: 'var(--color-danger)' }}>
            {status.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        {status.warnings.length > 0 ? (
          <ul data-testid="auth-warnings" style={{ margin: '8px 0 0', opacity: 0.8 }}>
            {status.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
      </Section>

      {status.cognito ? (
        <Section
          title="Cognito 必須設定"
          description="値は env / CDK で設定します。ここでは有無のみ表示します（埋め込み SRP ログイン）。"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {status.cognito.settings.map((s) => (
              <div
                key={s.key}
                data-testid={`cognito-setting-${s.key}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--color-surface-2)',
                  background: 'var(--color-surface)',
                }}
              >
                <span>
                  {COGNITO_SETTING_LABEL[s.key] ?? s.key}
                  {s.requiredForLogin ? (
                    <span style={{ marginLeft: 6, fontSize: '0.75rem', opacity: 0.6 }}>必須</span>
                  ) : null}
                </span>
                <StatusBadge
                  status={s.presence === 'set' ? 'ok' : s.requiredForLogin ? 'critical' : 'warning'}
                  label={s.presence === 'set' ? '設定済み' : '未設定'}
                />
              </div>
            ))}
          </div>
          <p data-testid="cognito-allowed-roles" style={{ fontSize: '0.85rem', marginTop: 12 }}>
            許可ロール:{' '}
            {status.cognito.allowedRoles.length > 0
              ? status.cognito.allowedRoles.join(', ')
              : '（未設定: 全ロール許可）'}
          </p>
        </Section>
      ) : status.entra ? (
        <Section
          title="Entra ID 必須設定"
          description="値は env / Secrets Manager で設定します。ここでは有無のみ表示します。"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {status.entra.settings.map((s) => (
              <div
                key={s.key}
                data-testid={`entra-setting-${s.key}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--color-surface-2)',
                  background: 'var(--color-surface)',
                }}
              >
                <span>
                  {SETTING_LABEL[s.key]}
                  {s.requiredForLogin ? (
                    <span style={{ marginLeft: 6, fontSize: '0.75rem', opacity: 0.6 }}>必須</span>
                  ) : null}
                </span>
                <StatusBadge
                  status={s.presence === 'set' ? 'ok' : s.requiredForLogin ? 'critical' : 'warning'}
                  label={s.presence === 'set' ? '設定済み' : '未設定'}
                />
              </div>
            ))}
          </div>
          <p data-testid="entra-allowed-roles" style={{ fontSize: '0.85rem', marginTop: 12 }}>
            許可ロール:{' '}
            {status.entra.allowedRoles.length > 0
              ? status.entra.allowedRoles.join(', ')
              : '（未設定: 全ロール許可）'}
          </p>
        </Section>
      ) : (
        <Section title="Entra ID" description="">
          <p style={{ opacity: 0.75 }}>
            Microsoft Entra ID は無効です。有効化するには <code>ADMIN_AUTH_PROVIDER=entra</code>{' '}
            と必要な env を設定してください（手順は docs/admin-entra-auth.md）。
          </p>
        </Section>
      )}
    </section>
  );
}
