import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AvatarGuide } from './AvatarGuide';
import { VOICE_KIOSK_MODES, type VoiceKioskMode } from '@/domain/voice-session/kiosk-view';
import type { ReceptionState } from '@/domain/reception/state';

/**
 * AvatarGuide が受け取った `voiceMode` を、描画結果のデータ属性まで実際に通すこと (#1095)。
 *
 * ソースの文字列ではなく、描画したマークアップで確かめる（jsdom が無いので
 * `renderToStaticMarkup`。calling-status-a11y.test.tsx と同じ流儀）。
 */
function attrs(screenState: ReceptionState, voiceMode?: VoiceKioskMode) {
  const html = renderToStaticMarkup(<AvatarGuide screenState={screenState} voiceMode={voiceMode} />);
  const pick = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];
  return {
    mode: pick('data-avatar-voice-mode'),
    phase: pick('data-avatar-behavior-phase'),
    listenFocus: pick('data-avatar-listen-focus'),
  };
}

describe('AvatarGuide: voiceMode を描画へ通す (#1095)', () => {
  it('どの局面でも、渡した voiceMode がそのまま描画に出る', () => {
    for (const mode of VOICE_KIOSK_MODES) {
      expect(attrs('selectingTarget', mode).mode, mode).toBe(mode);
    }
  });

  it('未指定は inactive で、従来どおり ambient（聞いていない見え方）', () => {
    expect(attrs('selectingTarget')).toEqual({ mode: 'inactive', phase: 'ambient', listenFocus: 'false' });
  });

  it('聞き取り中は listen focus が立ち、inactive とは違う phase になる', () => {
    const listening = attrs('selectingTarget', 'listening');
    expect(listening.listenFocus).toBe('true');
    expect(listening.phase).not.toBe('ambient');
  });

  it('局面が変われば描画も変わる（定数で潰されていない）', () => {
    const phases = new Set(VOICE_KIOSK_MODES.map((m) => attrs('selectingTarget', m).phase));
    const focus = new Set(VOICE_KIOSK_MODES.map((m) => attrs('selectingTarget', m).listenFocus));
    expect(phases.size).toBeGreaterThan(1);
    expect(focus).toEqual(new Set(['true', 'false']));
  });
});
