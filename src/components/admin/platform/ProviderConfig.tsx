'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  PROVIDER_IDS,
  type ProviderId,
  type SecretPresence,
  type TenantProviderConfigView,
} from '@/domain/provider-config/types';

/**
 * テナント別 CCaaS プロバイダ設定（developer 専用・write-only secret） (issue #405 Inc1)。
 *
 * 選択中テナント（サーバ側が Cookie から導出）のプロバイダ設定を read/write する。secret は
 * **write-only**: 応答・画面には presence（設定済み/未設定）のみを出し、値は決して表示・保持しない。
 * secret 値型・ストアは server-only（本 client component は非秘密の types のみ import する, AC3）。
 *
 * secret の set/clear は「期待 provider 名の一致」を確認フィールドで要求して誤操作を防ぐ（AC6）。
 */

const CONFIG_ENDPOINT = '/api/platform/integrations/provider-config';
const SECRET_ENDPOINT = '/api/platform/integrations/provider-config/secret';

type ConfigResponse = {
  config: TenantProviderConfigView | null;
  secretPresence?: SecretPresence;
};

const th = { padding: '6px 8px' } as const;

function presenceOf(res: ConfigResponse): SecretPresence {
  return res.config?.secretPresence ?? res.secretPresence ?? 'missing';
}

export function ProviderConfig() {
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 設定フォーム状態。
  const [provider, setProvider] = useState<ProviderId>('mock');
  const [enabled, setEnabled] = useState(false);
  const [applicationId, setApplicationId] = useState('');
  const [fromNumber, setFromNumber] = useState('');

  // secret フォーム状態（write-only。サーバ値では決して埋めない）。
  const [secretInput, setSecretInput] = useState('');
  const [confirmProvider, setConfirmProvider] = useState('');

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(CONFIG_ENDPOINT);
    if (!res.ok) {
      setError(
        res.status === 403
          ? 'この操作の権限がありません。'
          : res.status === 400
            ? '対象テナントを選択してください。'
            : '設定の取得に失敗しました。',
      );
      setData(null);
      return;
    }
    const body = (await res.json()) as ConfigResponse;
    setData(body);
    if (body.config) {
      setProvider(body.config.provider);
      setEnabled(body.config.enabled);
      setApplicationId(body.config.applicationId ?? '');
      setFromNumber(body.config.fromNumber ?? '');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveConfig = useCallback(async () => {
    setError(null);
    setNotice(null);
    const res = await fetch(CONFIG_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // secret はこのエンドポイントに送らない（別エンドポイントで write-only）。
      body: JSON.stringify({ provider, enabled, applicationId, fromNumber }),
    });
    if (!res.ok) {
      setError('設定の保存に失敗しました。');
      return;
    }
    setNotice('設定を保存しました。');
    await load();
  }, [provider, enabled, applicationId, fromNumber, load]);

  const saveSecret = useCallback(async () => {
    setError(null);
    setNotice(null);
    if (!secretInput.trim()) {
      setError('secret を入力してください。');
      return;
    }
    const res = await fetch(SECRET_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: secretInput, expectedProvider: data?.config?.provider }),
    });
    // 入力欄は成否に関わらず即クリア（画面・DOM に残さない）。
    setSecretInput('');
    if (!res.ok) {
      setError(res.status === 409 ? '先に設定を保存し、対象プロバイダを確認してください。' : 'secret の保存に失敗しました。');
      return;
    }
    setNotice('secret を保存しました（値は表示されません）。');
    await load();
  }, [secretInput, data, load]);

  const clearSecret = useCallback(async () => {
    setError(null);
    setNotice(null);
    const res = await fetch(SECRET_ENDPOINT, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedProvider: confirmProvider }),
    });
    setConfirmProvider('');
    if (!res.ok) {
      setError(
        res.status === 409
          ? '確認のため、現在のプロバイダ名を正しく入力してください。'
          : 'secret の消去に失敗しました。',
      );
      return;
    }
    setNotice('secret を消去しました。');
    await load();
  }, [confirmProvider, load]);

  const presence = data ? presenceOf(data) : 'missing';

  return (
    <section style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>テナント別プロバイダ設定</h2>
      <p style={{ opacity: 0.8, fontSize: '0.85rem' }}>
        選択中テナントの CCaaS プロバイダ設定です。secret は<strong>書き込み専用</strong>で、値は
        保存後も一切表示されません（状態のみ）。対象テナントはサーバ側で認可済みコンテキストから
        決まります。
      </p>

      {error ? <p style={{ color: 'var(--color-platform-warn)' }}>{error}</p> : null}
      {notice ? <p style={{ color: 'var(--color-platform-ok)' }}>{notice}</p> : null}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <tbody>
          <tr>
            <td style={th}>プロバイダ</td>
            <td style={th}>
              <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
                {PROVIDER_IDS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </td>
          </tr>
          <tr>
            <td style={th}>有効</td>
            <td style={th}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                aria-label="有効"
              />
            </td>
          </tr>
          <tr>
            <td style={th}>Application ID</td>
            <td style={th}>
              <input value={applicationId} onChange={(e) => setApplicationId(e.target.value)} />
            </td>
          </tr>
          <tr>
            <td style={th}>発信元番号</td>
            <td style={th}>
              <input value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} />
            </td>
          </tr>
        </tbody>
      </table>
      <button type="button" onClick={() => void saveConfig()} style={{ marginTop: 8 }}>
        設定を保存
      </button>

      <h3 style={{ fontSize: '0.95rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>
        API secret（書き込み専用）
      </h3>
      <p style={{ fontSize: '0.85rem' }}>
        現在の状態:{' '}
        <strong style={{ color: presence === 'set' ? 'var(--color-platform-ok)' : 'var(--color-platform-warn)' }}>
          {presence === 'set' ? '設定済み' : '未設定'}
        </strong>
      </p>
      <input
        type="password"
        value={secretInput}
        onChange={(e) => setSecretInput(e.target.value)}
        placeholder="新しい secret を入力（保存後は表示されません）"
        aria-label="API secret"
        autoComplete="new-password"
        style={{ width: '100%' }}
      />
      <button type="button" onClick={() => void saveSecret()} style={{ marginTop: 8 }}>
        secret を保存
      </button>

      <div style={{ marginTop: 'var(--space-md)' }}>
        <label style={{ fontSize: '0.8rem', opacity: 0.7 }}>
          消去の確認（現在のプロバイダ名を入力）
          <input
            value={confirmProvider}
            onChange={(e) => setConfirmProvider(e.target.value)}
            placeholder={data?.config?.provider ?? ''}
            aria-label="消去確認のプロバイダ名"
            style={{ marginLeft: 8 }}
          />
        </label>
        <button
          type="button"
          onClick={() => void clearSecret()}
          disabled={!confirmProvider || presence !== 'set'}
          style={{ marginLeft: 8, color: 'var(--color-platform-warn)' }}
        >
          secret を消去
        </button>
      </div>
    </section>
  );
}
