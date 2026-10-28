import { afterEach, describe, expect, it, vi } from 'vitest';
import { primeSpeech, speak } from './speech';

const settings = { ttsEnabled: true, rate: 1, volume: 1, language: 'ja-JP' };

function installSynthMock() {
  const speakFn = vi.fn();
  (globalThis as unknown as { window: unknown }).window = { speechSynthesis: { speak: speakFn, cancel: vi.fn() } };
  (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
    rate = 1;
    volume = 1;
    lang = '';
    constructor(public text: string) {}
  };
  return speakFn;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
});

describe('speak (#5)', () => {
  it('ttsEnabled が false なら再生しない', () => {
    const speakFn = installSynthMock();
    primeSpeech();
    speak('こんにちは', { ...settings, ttsEnabled: false });
    expect(speakFn).not.toHaveBeenCalled();
  });

  it('primed かつ有効なら再生する', () => {
    const speakFn = installSynthMock();
    primeSpeech();
    speak('こんにちは', settings);
    expect(speakFn).toHaveBeenCalledTimes(1);
  });

  it('音声 API が無くても例外を投げない（テキスト主導を継続）', () => {
    expect(() => speak('こんにちは', settings)).not.toThrow();
  });

  describe('終了と失敗の区別 (#1290)', () => {
    type Utterance = { onend?: () => void; onerror?: () => void };
    function lastUtterance(speakFn: ReturnType<typeof vi.fn>): Utterance {
      return speakFn.mock.calls.at(-1)?.[0] as Utterance;
    }

    it('読み終えたら onEnd、失敗は onError（onEnd は呼ばない）', () => {
      const speakFn = installSynthMock();
      primeSpeech();
      const onEnd = vi.fn();
      const onError = vi.fn();
      speak('通知', settings, { onEnd, onError });
      lastUtterance(speakFn).onerror?.();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onEnd).not.toHaveBeenCalled();
      speak('通知', settings, { onEnd, onError });
      lastUtterance(speakFn).onend?.();
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it('onError を渡さなければ、失敗は従来どおり onEnd に畳む', () => {
      const speakFn = installSynthMock();
      primeSpeech();
      const onEnd = vi.fn();
      speak('通知', settings, { onEnd });
      lastUtterance(speakFn).onerror?.();
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it('再生できない（TTS 無効・音声 API 無し・例外）ときは onError をすぐ呼ぶ', () => {
      const onError = vi.fn();
      const onEnd = vi.fn();
      installSynthMock();
      primeSpeech();
      speak('通知', { ...settings, ttsEnabled: false }, { onEnd, onError });
      delete (globalThis as unknown as { window?: unknown }).window;
      speak('通知', settings, { onEnd, onError });
      (globalThis as unknown as { window: unknown }).window = {
        speechSynthesis: {
          speak: () => {
            throw new Error('tts');
          },
          cancel: vi.fn(),
        },
      };
      speak('通知', settings, { onEnd, onError });
      expect(onError).toHaveBeenCalledTimes(3);
      expect(onEnd).not.toHaveBeenCalled();
    });
  });
});
