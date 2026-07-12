'use client';

import { useCallback, useEffect, useState } from 'react';
import type { VoiceSettings } from '@/domain/voice/types';
import { Button, Field, FormRow, SaveFeedback, useSaveFeedback } from '@/components/admin/ui';
import { space } from '@/components/admin/ui/tokens';
import { DEFAULT_CALLING_STAGE_THRESHOLDS } from '@/domain/reception/calling-experience';
import { sanitizeA11yEnabledModes, type A11yEnabledModes } from '@/domain/kiosk/a11y-modes';

/** 音声設定 (issue #28)。TTS/STT の有効化・案内文言・話速・音量を編集する。 */
export function VoiceManager() {
  const [v, setV] = useState<VoiceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const { feedback, success, failure, clear } = useSaveFeedback();

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/voice');
    if (res.ok) setV((await res.json()) as VoiceSettings);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (p: Partial<VoiceSettings>) => {
    clear();
    setV((cur) => (cur ? { ...cur, ...p } : cur));
  };

  const save = useCallback(async () => {
    if (!v || busy) return;
    setBusy(true);
    clear();
    try {
      const res = await fetch('/api/admin/voice', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(v),
      });
      if (res.ok) {
        setV((await res.json()) as VoiceSettings);
        success();
      } else {
        failure();
      }
    } finally {
      setBusy(false);
    }
  }, [v, busy, success, failure, clear]);

  if (!v) return <section><h1 style={{ marginTop: 0 }}>音声設定</h1><p>読み込み中…</p></section>;

  // アクセシビリティ支援モードの有効/無効 (issue #321)。未設定は「全モード有効」として表示する
  // （sanitizeA11yEnabledModes の既定と一致させる。保存時は常に全 4 モード分をまとめて送る）。
  const a11yModes = sanitizeA11yEnabledModes(v.a11yModesEnabled);
  const patchA11yMode = (key: keyof A11yEnabledModes, enabled: boolean) =>
    patch({ a11yModesEnabled: { ...a11yModes, [key]: enabled } });

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
        <label style={chk}>
          <input
            type="checkbox"
            data-testid="voice-feedback-enabled"
            checked={v.feedbackEnabled ?? true}
            onChange={(e) => patch({ feedbackEnabled: e.target.checked })}
          />
          受付完了・未応答・失敗画面でワンタップ満足度フィードバックを収集する
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
        {/* 来訪者向けプライバシー通知の要約文言（未設定時は既定文言, issue 314）。 */}
        <Field label="来訪者向けプライバシー通知（未設定時は既定文言）" htmlFor="voice-privacy-notice-input">
          <textarea
            id="voice-privacy-notice-input"
            data-testid="voice-privacy-notice"
            value={v.privacyNotice ?? ''}
            onChange={(e) => patch({ privacyNotice: e.target.value })}
            rows={3}
            placeholder="入力いただいたお名前・会社名・ご用件は、担当者への取り次ぎにのみ使用し、記録には保存しません。"
            style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </Field>

        {/* 呼び出し中(calling)の段階的ケア (issue #323)。しきい値・案内文言をテナント側で調整できる。 */}
        <FormRow>
          <Field label={`「もう少しお待ちください」に切り替える経過(ms) / 既定 ${DEFAULT_CALLING_STAGE_THRESHOLDS.waitingAfterMs}`} htmlFor="voice-calling-waiting-after-input">
            <input
              id="voice-calling-waiting-after-input"
              type="number"
              min="100"
              step="1000"
              data-testid="voice-calling-waiting-after-ms"
              value={v.callingStageWaitingAfterMs ?? ''}
              placeholder={String(DEFAULT_CALLING_STAGE_THRESHOLDS.waitingAfterMs)}
              onChange={(e) => patch({ callingStageWaitingAfterMs: e.target.value ? Number(e.target.value) : undefined })}
              style={{ ...input, width: 160 }}
            />
          </Field>
          <Field label={`タイムアウト予告を出す経過(ms) / 既定 ${DEFAULT_CALLING_STAGE_THRESHOLDS.noticeAfterMs}`} htmlFor="voice-calling-notice-after-input">
            <input
              id="voice-calling-notice-after-input"
              type="number"
              min="100"
              step="1000"
              data-testid="voice-calling-notice-after-ms"
              value={v.callingStageNoticeAfterMs ?? ''}
              placeholder={String(DEFAULT_CALLING_STAGE_THRESHOLDS.noticeAfterMs)}
              onChange={(e) => patch({ callingStageNoticeAfterMs: e.target.value ? Number(e.target.value) : undefined })}
              style={{ ...input, width: 160 }}
            />
          </Field>
        </FormRow>
        <Field label="「もう少しお待ちください」段階の案内文言（未設定時は既定文言）" htmlFor="voice-guidance-calling-waiting-input">
          <input
            id="voice-guidance-calling-waiting-input"
            data-testid="voice-guidance-calling-waiting"
            value={v.guidanceCallingWaiting ?? ''}
            onChange={(e) => patch({ guidanceCallingWaiting: e.target.value })}
            style={input}
          />
        </Field>
        <Field label="タイムアウト予告段階の案内文言（未設定時は既定文言）" htmlFor="voice-guidance-calling-notice-input">
          <input
            id="voice-guidance-calling-notice-input"
            data-testid="voice-guidance-calling-notice"
            value={v.guidanceCallingNotice ?? ''}
            onChange={(e) => patch({ guidanceCallingNotice: e.target.value })}
            style={input}
          />
        </Field>

        {/*
          来訪者向けアクセシビリティ支援モード (issue #321)。モードごとに kiosk の支援モードパネルへ
          出す/出さないを切り替える。無効にしたモードはパネル自体から消える（機能フラグと同じ扱い）。
        */}
        <fieldset style={fieldset}>
          <legend style={legend}>アクセシビリティ支援モード（受付端末の常設パネルに出す機能）</legend>
          <label style={chk}>
            <input
              type="checkbox"
              data-testid="voice-a11y-large-text"
              checked={a11yModes.largeText}
              onChange={(e) => patchA11yMode('largeText', e.target.checked)}
            />
            大きな文字（フォントサイズ切替）
          </label>
          <label style={chk}>
            <input
              type="checkbox"
              data-testid="voice-a11y-high-contrast"
              checked={a11yModes.highContrast}
              onChange={(e) => patchA11yMode('highContrast', e.target.checked)}
            />
            ハイコントラスト表示
          </label>
          <label style={chk}>
            <input
              type="checkbox"
              data-testid="voice-a11y-low-reach"
              checked={a11yModes.lowReach}
              onChange={(e) => patchA11yMode('lowReach', e.target.checked)}
            />
            低位置レイアウト（操作ボタンを下寄せ）
          </label>
          <label style={chk}>
            <input
              type="checkbox"
              data-testid="voice-a11y-simple-japanese"
              checked={a11yModes.simpleJapanese}
              onChange={(e) => patchA11yMode('simpleJapanese', e.target.checked)}
            />
            やさしい日本語
          </label>
        </fieldset>

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
          <SaveFeedback feedback={feedback} successTestId="voice-saved" errorTestId="voice-error" />
        </div>
      </div>
    </section>
  );
}

const chk: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' };
const fieldset: React.CSSProperties = {
  border: '1px solid var(--color-surface-2)',
  borderRadius: 8,
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const legend: React.CSSProperties = { padding: '0 8px', fontWeight: 600 };
const input: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};
