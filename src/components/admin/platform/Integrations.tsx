'use client';

import { useEffect, useState } from 'react';
import { DangerActionPlaceholder } from './primitives';

/**
 * 外部連携状態（read 中心） (issue #90, increment 3 / #83)。
 *
 * /api/platform/integrations（developer 専用 read）から、外部連携（Vonage 等）と管理ログイン方式
 * （Entra / Cognito / 共有パスワード）の登録状態・有効状態・接続結果・最終日時を横断表示する。
 * **API シークレットや秘密鍵などの機密値は表示しない**。シークレット再登録・連携設定変更は
 * 破壊的操作として確認・昇格・監査を伴う導線に隔離する（次増分）。
 */
type IntegrationRow = {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  lastResult: 'untested' | 'success' | 'failure';
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorSummary?: string;
};
type AuthMethodRow = {
  id: string;
  label: string;
  enabled: boolean;
  issues: string[];
};
type IntegrationsResponse = {
  integrations: IntegrationRow[];
  authMethods: AuthMethodRow[];
};

const RESULT_LABEL: Record<IntegrationRow['lastResult'], string> = {
  untested: '未テスト',
  success: '成功',
  failure: '失敗',
};

const th = { padding: '6px 8px' } as const;
const headRow = { textAlign: 'left', opacity: 0.6 } as const;
const bodyRow = { borderTop: '1px solid var(--color-border)' } as const;

export function Integrations() {
  const [data, setData] = useState<IntegrationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/platform/integrations');
      if (cancelled) return;
      if (!res.ok) {
        setError(
          res.status === 403 ? 'この画面の閲覧権限がありません。' : '連携状態の取得に失敗しました。',
        );
        return;
      }
      setData((await res.json()) as IntegrationsResponse);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>外部連携</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        Vonage / Entra(Cognito) / 共有パスワードなどの連携状態を横断確認します（読み取り専用）。
        表示するのは登録状態・有効状態・接続確認結果・最終日時のみで、API シークレットや秘密鍵
        などの機密値は表示しません。
      </p>

      {error ? <p style={{ color: 'var(--color-platform-warn)' }}>{error}</p> : null}

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>外部連携</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr style={headRow}>
            <th style={th}>連携</th>
            <th style={th}>設定</th>
            <th style={th}>有効</th>
            <th style={th}>直近結果</th>
            <th style={th}>要約</th>
          </tr>
        </thead>
        <tbody>
          {(data?.integrations ?? []).map((i) => (
            <tr key={i.id} style={bodyRow}>
              <td style={th}>{i.label}</td>
              <td style={{ ...th, opacity: 0.8 }}>{i.configured ? '済' : '未'}</td>
              <td style={{ ...th, opacity: 0.8 }}>{i.enabled ? '有効' : '無効'}</td>
              <td style={{ ...th, opacity: 0.8 }}>{RESULT_LABEL[i.lastResult]}</td>
              <td style={{ ...th, opacity: 0.6 }}>{i.lastErrorSummary ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>
        管理画面ログイン方式
      </h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr style={headRow}>
            <th style={th}>方式</th>
            <th style={th}>有効</th>
            <th style={th}>設定上の問題</th>
          </tr>
        </thead>
        <tbody>
          {(data?.authMethods ?? []).map((m) => (
            <tr key={m.id} style={bodyRow}>
              <td style={th}>{m.label}</td>
              <td style={{ ...th, opacity: 0.8 }}>{m.enabled ? '有効' : '無効'}</td>
              <td style={{ ...th, opacity: 0.6 }}>{m.issues.length ? m.issues.join(' / ') : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="シークレット再登録 / 連携設定の変更" />
      </div>
    </section>
  );
}
