import type { Locale } from '@/lib/i18n';
import type { KioskFlow as KioskCustomFlow } from './custom-flow/types';
import { VISITOR_NAME_FIELD_KEY } from './custom-flow/field-values';
import type { SpeakEvents } from './speech';

/**
 * `inputVisitorInfo` で音声の氏名の聞き取りを始めるかの判定と、通知の読み上げ (ADR 0011、#1290)。
 * `KioskFlow` / `VoiceSessionLayer` の effect から呼ぶ。判定を effect に埋めると node の unit で
 * 縛れないので、ここへ出してある。
 */

/** 通知の読み上げを待つ上限。過ぎても終了の通知が来なければ、読み上げられなかったとみなす（§2）。 */
export const VISITOR_NAME_NOTICE_TIMEOUT_MS = 25_000;

/** 名乗りの抽出器と「はい／いいえ」の判定が日本語だけなので、日本語の表示のときだけ聞く。 */
const VOICE_NAME_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ja', 'ja-simple']);

export type VisitorNameVoiceInput = {
  /** 通知を読み上げられるか（`ttsEnabled: false` なら聞かない。§2）。 */
  ttsEnabled: boolean;
  locale: Locale;
  /** 確認画面から戻ってきた（氏名がすでに入っている）。戻ったら自動で始めない（§3-c）。 */
  returnedWithName: boolean;
  /** 氏名の欄がある（既定の経路は常に true。カスタムフローは `customFlowAcceptsVoiceName`）。 */
  hasNameField: boolean;
};

export function isVisitorNameVoiceEligible(input: VisitorNameVoiceInput): boolean {
  return (
    input.ttsEnabled && VOICE_NAME_LOCALES.has(input.locale) && !input.returnedWithName && input.hasNameField
  );
}

/** カスタムフローで音声の氏名を入れてよいか（§5）: visitorInfo の step と、text の `name` の欄がある。 */
export function customFlowAcceptsVoiceName(flow: KioskCustomFlow): boolean {
  return (
    flow.steps.includes('visitorInfo') &&
    flow.fields.some((f) => f.key === VISITOR_NAME_FIELD_KEY && f.type === 'text')
  );
}

type Speak = (text: string, events: SpeakEvents) => void;
type Timer = (fn: () => void, ms: number) => () => void;

const defaultTimer: Timer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/**
 * 読み上げて、**最後まで読み終えたか**を返す。失敗・中断（`onError`）、例外、上限の時間までに
 * 終了の通知が来ないときは false。最初に決まった結果だけを返す。
 */
export function speakUntilEnd(speak: Speak, text: string, timer: Timer = defaultTimer): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let cancel: () => void = () => {};
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(ok);
    };
    cancel = timer(() => settle(false), VISITOR_NAME_NOTICE_TIMEOUT_MS);
    try {
      speak(text, { onEnd: () => settle(true), onError: () => settle(false) });
    } catch {
      settle(false);
    }
  });
}
