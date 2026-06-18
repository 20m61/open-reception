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
});
