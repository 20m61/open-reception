'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AiGuidanceConfig } from '@/domain/ai-guidance/config';
import { Button, Field } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';

/**
 * AI 案内設定 (issue #104)。AI 案内の有効/無効と「回答してよいトピック（許可リスト）」を編集する。
 * 許可リスト外の質問は誤案内防止のため out-of-scope 扱いになり、有人/担当者へ切り替わる（#104 状態機械）。
 * トピックは 1 行 1 件（カンマ区切りも可）。正規化（trim・重複除去・上限）は API のドメイン層が行う。
 */
export function AiGuidanceManager() {
  const [config, setConfig] = useState<AiGuidanceConfig | null>(null);
  const [topicsText, setTopicsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/ai-guidance');
    if (res.ok) {
      const c = (await res.json()) as AiGuidanceConfig;
      setConfig(c);
      setTopicsText(c.allowedTopics.join('\n'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!config || busy) return;
    setBusy(true);
    setSaved(false);
    try {
      const res = await fetch('/api/admin/ai-guidance', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: config.enabled, allowedTopics: topicsText }),
      });
      if (res.ok) {
        const c = (await res.json()) as AiGuidanceConfig;
        setConfig(c);
        setTopicsText(c.allowedTopics.join('\n'));
        setSaved(true);
      }
    } finally {
      setBusy(false);
    }
  }, [config, topicsText, busy]);

  if (!config) {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>AI 案内設定</h1>
        <p>読み込み中…</p>
      </section>
    );
  }

  return (
    <section style={{ maxWidth: 560 }}>
      <h1 style={{ marginTop: 0 }}>AI 案内設定</h1>
      <p style={{ color: color.muted, marginTop: 0 }}>
        AI 案内は補助導線です。許可トピック外の質問や曖昧な入力は、誤案内を避けるため担当者/有人対応へ切り替わります。
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        <label style={chk}>
          <input
            type="checkbox"
            data-testid="ai-guidance-enabled"
            checked={config.enabled}
            onChange={(e) => {
              setSaved(false);
              setConfig({ ...config, enabled: e.target.checked });
            }}
          />
          AI 案内を有効にする（既定: 無効）
        </label>

        <Field label="回答を許可するトピック（1 行 1 件・カンマ区切り可）" htmlFor="ai-guidance-topics-input">
          <textarea
            id="ai-guidance-topics-input"
            data-testid="ai-guidance-topics"
            value={topicsText}
            onChange={(e) => {
              setSaved(false);
              setTopicsText(e.target.value);
            }}
            rows={6}
            placeholder={'例:\nFAQ\n施設案内\n受付操作'}
            style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </Field>

        <div style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
          <Button variant="primary" data-testid="ai-guidance-save" onClick={save} disabled={busy}>
            保存
          </Button>
          {saved ? (
            <span data-testid="ai-guidance-saved" style={{ color: color.success }}>
              保存しました
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const chk: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' };
const input: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};
