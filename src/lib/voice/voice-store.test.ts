import { beforeEach, describe, expect, it } from 'vitest';
import { __resetVoice, getVoiceSettings, updateVoiceSettings } from './voice-store';

beforeEach(async () => {
  await __resetVoice();
});

describe('voice-store (#28)', () => {
  it('既定では TTS/STT とも無効（テキスト主導）', async () => {
    const v = await getVoiceSettings();
    expect(v.ttsEnabled).toBe(false);
    expect(v.sttEnabled).toBe(false);
    expect(v.guidanceIdle).not.toBe('');
  });

  it('案内文言を更新できる', async () => {
    const v = await updateVoiceSettings({ guidanceIdle: 'いらっしゃいませ' });
    expect(v.guidanceIdle).toBe('いらっしゃいませ');
  });

  it('話速・音量を範囲内にクランプする', async () => {
    const v = await updateVoiceSettings({ rate: 5, volume: 9 });
    expect(v.rate).toBe(2);
    expect(v.volume).toBe(1);
    const v2 = await updateVoiceSettings({ rate: 0, volume: -1 });
    expect(v2.rate).toBe(0.5);
    expect(v2.volume).toBe(0);
  });

  it('provider は browser/none のみ受け付ける', async () => {
    const v = await updateVoiceSettings({ ttsProvider: 'invalid' });
    expect(v.ttsProvider).toBe('browser');
    const v2 = await updateVoiceSettings({ ttsProvider: 'none' });
    expect(v2.ttsProvider).toBe('none');
  });

  it('プライバシー通知の要約文言を上書きできる（既定は未設定, #314）', async () => {
    const before = await getVoiceSettings();
    expect(before.privacyNotice).toBeUndefined();

    const v = await updateVoiceSettings({ privacyNotice: 'カスタム通知文言です' });
    expect(v.privacyNotice).toBe('カスタム通知文言です');

    const persisted = await getVoiceSettings();
    expect(persisted.privacyNotice).toBe('カスタム通知文言です');
  });

  it('プライバシー通知の上書きを空文字にすると未設定へ戻る', async () => {
    await updateVoiceSettings({ privacyNotice: 'カスタム通知文言です' });
    const v = await updateVoiceSettings({ privacyNotice: '   ' });
    expect(v.privacyNotice).toBeUndefined();
  });
});
