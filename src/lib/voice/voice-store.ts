/**
 * 音声設定のストア (issue #28)。既定では TTS/STT とも無効（テキスト主導）。
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 */
import { clampRate, clampVolume, type VoiceProvider, type VoiceSettings } from '@/domain/voice/types';
import { getBackend } from '@/lib/data';

function defaults(): VoiceSettings {
  return {
    ttsEnabled: false,
    sttEnabled: false,
    ttsProvider: 'browser',
    sttProvider: 'browser',
    voiceId: '',
    rate: 1,
    volume: 1,
    language: 'ja-JP',
    // 待機画面のリード既定 (#324)。主指示（「ご用件をお選びください」）は見出し・アバター字幕が担うため、
    // リードは挨拶＋安心情報（タッチだけで受付できる）のみにし、「タッチして開始」の再指示で二重化しない。
    guidanceIdle: 'ようこそ。タッチ操作だけで受付できます。',
    guidanceConfirm: '内容をご確認のうえ、呼び出しを開始してください。',
    fallbackText: '音声がご利用いただけない場合も、画面の案内に沿って受付できます。',
  };
}

const voice = () => getBackend().singleton<VoiceSettings>('voice', { default: defaults });

async function current(): Promise<VoiceSettings> {
  return (await voice().get()) ?? defaults();
}

export async function getVoiceSettings(): Promise<VoiceSettings> {
  return { ...(await current()) };
}

function asProvider(value: unknown, fallback: VoiceProvider): VoiceProvider {
  return value === 'browser' || value === 'none' ? value : fallback;
}

export async function updateVoiceSettings(patch: unknown): Promise<VoiceSettings> {
  const settings = await current();
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
    // 来訪者向けプライバシー通知の要約文言の上書き (issue #314)。空文字は「未設定へ戻す」扱い。
    if (typeof o.privacyNotice === 'string') settings.privacyNotice = o.privacyNotice.trim() || undefined;
    // 呼び出し中の段階的ケア (issue #323)。しきい値は正の有限値のみ受け付ける（クランプ自体は
    // 消費側 src/domain/reception/calling-experience.ts の clampCallingStageThresholds に委譲）。
    // 文言は privacyNotice と同じ運用: 空文字は「未設定へ戻す（既定文言を使う）」扱い。
    if (typeof o.callingStageWaitingAfterMs === 'number' && Number.isFinite(o.callingStageWaitingAfterMs) && o.callingStageWaitingAfterMs > 0) {
      settings.callingStageWaitingAfterMs = o.callingStageWaitingAfterMs;
    }
    if (typeof o.callingStageNoticeAfterMs === 'number' && Number.isFinite(o.callingStageNoticeAfterMs) && o.callingStageNoticeAfterMs > 0) {
      settings.callingStageNoticeAfterMs = o.callingStageNoticeAfterMs;
    }
    if (typeof o.guidanceCallingWaiting === 'string') settings.guidanceCallingWaiting = o.guidanceCallingWaiting.trim() || undefined;
    if (typeof o.guidanceCallingNotice === 'string') settings.guidanceCallingNotice = o.guidanceCallingNotice.trim() || undefined;
    // ワンタップ満足度フィードバック収集の有効/無効 (issue #320)。既定（未設定）は「有効」扱い。
    if (typeof o.feedbackEnabled === 'boolean') settings.feedbackEnabled = o.feedbackEnabled;
  }
  await voice().put(settings);
  return { ...settings };
}

/** テスト用: 既定へ戻す。 */
export async function __resetVoice(): Promise<void> {
  await voice().reset();
}
