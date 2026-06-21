'use client';

import { useCallback, useEffect, useState } from 'react';
import type { VoiceSettings } from '@/domain/voice/types';
import { Button, Field, FormRow } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';

/** 音声設定 (issue #28)。TTS/STT の有効化・案内文言・話速・音量を編集する。 */
export function VoiceManager() {
  const [v, setV] = useState<VoiceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/voice');
    if (res.ok) setV((await res.json()) as VoiceSettings);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (p: Partial<VoiceSettings>) => setV((cur) => (cur ? { ...cur, ...p } : cur));

  const save = useCallback(async () => {
    if (!v || busy) return;
    setBusy(true);
    setSaved(false);
    try {
      const res = await fetch('/api/admin/voice', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(v),
      });
      if (res.ok) {
        setV((await res.json()) as VoiceSettings);
        setSaved(true);
      }
    } finally {
      setBusy(false);
    }
  }, [v, busy]);

  if (!v) return <section><h1 style={{ marginTop: 0 }}>音声設定</h1><p>読み込み中…</p></section>;

  return (
    <section style={{ maxWidth: 560 }}>
      <h1 style={{ marginTop: 0 }}>音声設定</h1>
      <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
        <label style={chk}>
          <input type="checkbox" data-testid="voice-tts" checked={v.ttsEnabled} onChange={(e) => patch({ ttsEnabled: e.target.checked })} />
          音声合成（読み上げ）を有効にする
        </label>
        <label style={chk}>
          <input type="checkbox" data-testid="voice-stt" checked={v.sttEnabled} onChange={(e) => patch({ sttEnabled: e.target.checked })} />
          音声認識を有効にする（結果は候補表示・確認必須／即時呼び出しはしない）
        </label>

        <Field label="待機画面の案内文言" htmlFor="voice-guidance-idle-input">
          <input id="voice-guidance-idle-input" data-testid="voice-guidance-idle" value={v.guidanceIdle} onChange={(e) => patch({ guidanceIdle: e.target.value })} style={input} />
        </Field>
        <Field label="確認画面の案内文言" htmlFor="voice-guidance-confirm-input">
          <input id="voice-guidance-confirm-input" data-testid="voice-guidance-confirm" value={v.guidanceConfirm} onChange={(e) => patch({ guidanceConfirm: e.target.value })} style={input} />
        </Field>
        <Field label="音声不可時の案内（fallback）" htmlFor="voice-fallback-input">
          <input id="voice-fallback-input" data-testid="voice-fallback" value={v.fallbackText} onChange={(e) => patch({ fallbackText: e.target.value })} style={input} />
        </Field>

        <FormRow>
          <Field label="話速（0.5–2.0）" htmlFor="voice-rate-input">
            <input id="voice-rate-input" type="number" step="0.1" min="0.5" max="2" data-testid="voice-rate" value={v.rate} onChange={(e) => patch({ rate: Number(e.target.value) })} style={{ ...input, width: 120 }} />
          </Field>
          <Field label="音量（0–1）" htmlFor="voice-volume-input">
            <input id="voice-volume-input" type="number" step="0.1" min="0" max="1" data-testid="voice-volume" value={v.volume} onChange={(e) => patch({ volume: Number(e.target.value) })} style={{ ...input, width: 120 }} />
          </Field>
          <Field label="言語" htmlFor="voice-language-input">
            <input id="voice-language-input" data-testid="voice-language" value={v.language} onChange={(e) => patch({ language: e.target.value })} style={{ ...input, width: 140 }} />
          </Field>
        </FormRow>

        <div style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}>
          <Button variant="primary" data-testid="voice-save" onClick={save} disabled={busy}>
            保存
          </Button>
          {saved ? <span data-testid="voice-saved" style={{ color: color.success }}>保存しました</span> : null}
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
