'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Field, SaveFeedback, useSaveFeedback } from '@/components/admin/ui';
import { space } from '@/components/admin/ui/tokens';

type SecurityView = { pinRequired: boolean; ipAllowlist: string[]; pinConfigured: boolean; emergencyStop: boolean };

/** セキュリティ設定 (issue #23, #29)。PIN 必須・PIN 変更・IP 許可リストを編集する。 */
export function SecurityManager() {
  const [view, setView] = useState<SecurityView | null>(null);
  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState('');
  const [ipText, setIpText] = useState('');
  const [busy, setBusy] = useState(false);
  const { feedback, success, failure, clear } = useSaveFeedback();
  const [confirmingEmergency, setConfirmingEmergency] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/security');
    if (res.ok) {
      const v = (await res.json()) as SecurityView;
      setView(v);
      setPinRequired(v.pinRequired);
      setIpText(v.ipAllowlist.join('\n'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    clear();
    try {
      const ipAllowlist = ipText.split('\n').map((s) => s.trim()).filter(Boolean);
      const body: Record<string, unknown> = { pinRequired, ipAllowlist };
      if (pin.trim() !== '') body.pin = pin.trim();
      const res = await fetch('/api/admin/security', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setPin('');
        success();
        await load();
      } else {
        failure();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, ipText, pinRequired, pin, load, success, failure, clear]);

  const setEmergency = useCallback(
    async (emergencyStop: boolean) => {
      setConfirmingEmergency(false);
      await fetch('/api/admin/security', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ emergencyStop }),
      });
      await load();
    },
    [load],
  );

  if (!view) return <section><h1 style={{ marginTop: 0 }}>セキュリティ設定</h1><p>読み込み中…</p></section>;

  return (
    <section style={{ maxWidth: 480 }}>
      <h1 style={{ marginTop: 0 }}>セキュリティ設定</h1>

      <div
        data-testid="emergency-section"
        className={view.emergencyStop ? 'notice notice--danger' : 'notice notice--warning'}
        style={{ marginBottom: 24 }}
      >
        <strong>緊急停止モード</strong>
        <p style={{ margin: '8px 0' }} data-testid="emergency-state">
          現在: {view.emergencyStop ? '停止中（全端末で受付を停止）' : '通常稼働'}
        </p>
        {view.emergencyStop ? (
          <Button variant="primary" data-testid="emergency-resume" onClick={() => setEmergency(false)}>
            受付を再開する
          </Button>
        ) : confirmingEmergency ? (
          <div style={{ display: 'flex', gap: space.sm }}>
            <Button variant="danger" data-testid="emergency-confirm" onClick={() => setEmergency(true)}>
              本当に全端末を停止する
            </Button>
            <Button data-testid="emergency-cancel" onClick={() => setConfirmingEmergency(false)}>
              やめる
            </Button>
          </div>
        ) : (
          <Button variant="danger" data-testid="emergency-stop" onClick={() => setConfirmingEmergency(true)}>
            緊急停止する
          </Button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        <label style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
          <input
            type="checkbox"
            data-testid="security-pin-required"
            checked={pinRequired}
            onChange={(e) => setPinRequired(e.target.checked)}
          />
          受付端末の表示に PIN 許可を必須にする
        </label>
        <Field
          label={`PIN を変更（空欄なら変更しない／現在: ${view.pinConfigured ? '設定済み' : '未設定'}）`}
          htmlFor="security-pin"
        >
          <input type="password" id="security-pin" data-testid="security-pin" value={pin} onChange={(e) => setPin(e.target.value)} style={input} />
        </Field>
        <Field label="IP 許可リスト（1 行に 1 件、空なら全許可）" htmlFor="security-ip">
          <textarea id="security-ip" data-testid="security-ip" value={ipText} onChange={(e) => setIpText(e.target.value)} rows={4} style={input} />
        </Field>
        <div style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
          <Button variant="primary" data-testid="security-save" onClick={save} disabled={busy}>
            保存
          </Button>
          <SaveFeedback feedback={feedback} successTestId="security-saved" errorTestId="security-error" />
        </div>
      </div>
    </section>
  );
}

const input: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};
