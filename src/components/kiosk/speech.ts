/**
 * 受付端末の音声合成（TTS）再生 (issue #5, #28)。
 * - 既定では無効。管理画面で ttsEnabled を有効にした場合のみ再生する。
 * - ブラウザの自動再生制約に合わせ、初回ユーザー操作（タップ）後にのみ再生する。
 * - 音声が使えない/失敗しても受付フローは継続する（テキスト案内が主導線）。
 */
export type SpeakSettings = { ttsEnabled: boolean; rate: number; volume: number; language: string };

/** 発話の開始/終了を受け取るコールバック（リップシンク #5 用。任意）。 */
export type SpeakEvents = { onStart?: () => void; onEnd?: () => void };

let primed = false;

/** 初回ユーザー操作で音声再生を有効化する。 */
export function primeSpeech(): void {
  primed = true;
}

export function speak(text: string, settings: SpeakSettings, events?: SpeakEvents): void {
  if (!settings.ttsEnabled || !primed || !text) return;
  try {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = settings.rate;
    utterance.volume = settings.volume;
    utterance.lang = settings.language;
    if (events) {
      // 発話中フラグの立ち上げ/下げ。エラー/中断時も必ず onEnd を呼び、口が開きっぱなしを防ぐ。
      utterance.onstart = () => events.onStart?.();
      utterance.onend = () => events.onEnd?.();
      utterance.onerror = () => events.onEnd?.();
    }
    synth.speak(utterance);
  } catch {
    /* 音声再生不可でも受付フローは止めない */
    events?.onEnd?.();
  }
}
