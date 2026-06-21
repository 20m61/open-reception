import { describe, expect, it } from 'vitest';
import { LOCALE_LANGUAGE_CODE, resolveLocaleVoice } from './locale-voice';
import type { VoiceSettings } from '@/domain/voice/types';

const base: Pick<VoiceSettings, 'rate' | 'volume' | 'localeVoices'> = {
  rate: 1.1,
  volume: 0.8,
};

describe('resolveLocaleVoice (#103)', () => {
  it('上書き無しは既定言語コードと空 voiceId を返す', () => {
    expect(resolveLocaleVoice(base, 'en')).toEqual({
      languageCode: 'en-US',
      voiceId: '',
      rate: 1.1,
      volume: 0.8,
    });
  });

  it('全対応 locale に既定言語コードが定義されている', () => {
    expect(LOCALE_LANGUAGE_CODE.ja).toBe('ja-JP');
    expect(LOCALE_LANGUAGE_CODE.ko).toBe('ko-KR');
    expect(LOCALE_LANGUAGE_CODE.zh).toBe('cmn-CN');
  });

  it('localeVoices の上書きを優先する', () => {
    const s = { ...base, localeVoices: { en: { languageCode: 'en-GB', voiceId: 'Amy' } } };
    expect(resolveLocaleVoice(s, 'en')).toMatchObject({ languageCode: 'en-GB', voiceId: 'Amy' });
  });

  it('未設定 locale の上書きは既定 locale の上書きへフォールバックする', () => {
    const s = { ...base, localeVoices: { ja: { languageCode: 'ja-JP', voiceId: 'Mizuki' } } };
    // ko に上書きが無いので ja の上書きへフォールバック
    expect(resolveLocaleVoice(s, 'ko')).toMatchObject({ languageCode: 'ja-JP', voiceId: 'Mizuki' });
  });

  it('対応外 locale は既定 locale (ja) へフォールバックする', () => {
    expect(resolveLocaleVoice(base, 'fr' as never).languageCode).toBe('ja-JP');
  });

  it('rate / volume は共通設定を引き継ぐ', () => {
    const r = resolveLocaleVoice({ rate: 0.6, volume: 0.4 }, 'zh');
    expect(r.rate).toBe(0.6);
    expect(r.volume).toBe(0.4);
  });
});
