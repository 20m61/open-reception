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
});
