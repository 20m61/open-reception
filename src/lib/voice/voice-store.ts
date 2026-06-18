/**
 * 音声設定の in-memory ストア (issue #28)。既定では TTS/STT とも無効（テキスト主導）。
 */
import { clampRate, clampVolume, type VoiceProvider, type VoiceSettings } from '@/domain/voice/types';

const DEFAULTS: VoiceSettings = {
  ttsEnabled: false,
  sttEnabled: false,
  ttsProvider: 'browser',
  sttProvider: 'browser',
  voiceId: '',
  rate: 1,
  volume: 1,
  language: 'ja-JP',
  guidanceIdle: 'ようこそ。画面にタッチして受付を開始してください。',
  guidanceConfirm: '内容をご確認のうえ、呼び出しを開始してください。',
  fallbackText: '音声がご利用いただけない場合も、画面の案内に沿って受付できます。',
};

let settings: VoiceSettings = { ...DEFAULTS };

export function getVoiceSettings(): VoiceSettings {
  return { ...settings };
}

function asProvider(value: unknown, fallback: VoiceProvider): VoiceProvider {
  return value === 'browser' || value === 'none' ? value : fallback;
}

export function updateVoiceSettings(patch: unknown): VoiceSettings {
  if (typeof patch === 'object' && patch !== null) {
    const o = patch as Record<string, unknown>;
    if (typeof o.ttsEnabled === 'boolean') settings.ttsEnabled = o.ttsEnabled;
    if (typeof o.sttEnabled === 'boolean') settings.sttEnabled = o.sttEnabled;
    if (o.ttsProvider !== undefined) settings.ttsProvider = asProvider(o.ttsProvider, settings.ttsProvider);
    if (o.sttProvider !== undefined) settings.sttProvider = asProvider(o.sttProvider, settings.sttProvider);
    if (typeof o.voiceId === 'string') settings.voiceId = o.voiceId;
    if (typeof o.rate === 'number') settings.rate = clampRate(o.rate);
    if (typeof o.volume === 'number') settings.volume = clampVolume(o.volume);
    if (typeof o.language === 'string' && o.language.trim()) settings.language = o.language.trim();
    if (typeof o.guidanceIdle === 'string') settings.guidanceIdle = o.guidanceIdle;
    if (typeof o.guidanceConfirm === 'string') settings.guidanceConfirm = o.guidanceConfirm;
    if (typeof o.fallbackText === 'string') settings.fallbackText = o.fallbackText;
  }
  return getVoiceSettings();
}

/** テスト用: 既定へ戻す。 */
export function __resetVoice(): void {
  settings = { ...DEFAULTS };
}
