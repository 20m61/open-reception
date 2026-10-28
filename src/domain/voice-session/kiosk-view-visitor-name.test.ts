import { describe, expect, it } from 'vitest';
import {
  announcementFor,
  captionKeyFor,
  initialVoiceKioskState,
  isVisitorNameState,
  voiceKioskReducer,
  type VoiceKioskEvent,
  type VoiceKioskState,
} from './kiosk-view';

/** 氏名の聞き取りの UI 局面 (ADR 0011 §2・§3、#1290)。合成データだけを使う。 */
const active = (): VoiceKioskState => voiceKioskReducer(initialVoiceKioskState(), { type: 'activate' });
const run = (events: VoiceKioskEvent[], from = active()) => events.reduce(voiceKioskReducer, from);

describe('氏名の聞き取りの局面', () => {
  it('尋ねる（初回・言い直し）は listening。字幕を出し分け、言い直しだけ読み上げる', () => {
    const first = run([{ type: 'visitorNameAsk', retry: false }]);
    expect(first).toEqual({ mode: 'listening', listeningPrompt: 'visitorName' });
    expect(captionKeyFor(first)).toBe('voice.visitorName.ask');
    expect(announcementFor(first)).toBeNull();
    const retry = run([{ type: 'visitorNameAsk', retry: true }]);
    expect(captionKeyFor(retry)).toBe('voice.visitorName.askAgain');
    expect(announcementFor(retry)).toEqual({ key: 'voice.visitorName.askAgain', name: '' });
  });

  it('発話の途中経過（interim）が来ても、氏名を尋ねている字幕の出し分けを保つ', () => {
    const state = run([{ type: 'visitorNameAsk', retry: true }, { type: 'hearPartial', text: 'う' }]);
    expect(state.listeningPrompt).toBe('visitorNameRetry');
  });

  it('復唱は画面の字幕と読み上げで同じキー・同じ名前を使う', () => {
    const state = run([{ type: 'visitorNameReadback', name: '受付 太郎' }]);
    expect(state).toMatchObject({ mode: 'readback', readbackKind: 'visitorName', readbackName: '受付 太郎' });
    expect(captionKeyFor(state)).toBe('voice.readback.confirmVisitorName');
    expect(announcementFor(state)).toEqual({ key: 'voice.readback.confirmVisitorName', name: '受付 太郎' });
  });

  it('確定（confirmYes）で復唱を畳み、氏名を状態に残さない', () => {
    const state = run([{ type: 'visitorNameReadback', name: '受付 太郎' }, { type: 'confirmYes' }]);
    expect(state).toEqual({ mode: 'idle' });
  });

  it('キーボードへの案内は字幕と読み上げの両方', () => {
    const state = run([{ type: 'visitorNameKeyboard' }]);
    expect(state.mode).toBe('keyboardGuide');
    expect(captionKeyFor(state)).toBe('voice.visitorName.keyboard');
    expect(announcementFor(state)).toEqual({ key: 'voice.visitorName.keyboard', name: '' });
  });

  it('visitorNameStopped は氏名の局面だけを畳む（相手の復唱・不在告知は畳まない）', () => {
    for (const events of [
      [{ type: 'visitorNameAsk', retry: false }],
      [{ type: 'visitorNameReadback', name: '受付' }],
      [{ type: 'visitorNameKeyboard' }],
    ] as VoiceKioskEvent[][]) {
      const state = run(events);
      expect(isVisitorNameState(state)).toBe(true);
      expect(voiceKioskReducer(state, { type: 'visitorNameStopped' })).toEqual({ mode: 'idle' });
    }
    for (const events of [
      [{ type: 'heardNeedsConfirmation', displayName: '佐藤', reason: 'low_stt_confidence', kind: 'staff' }],
      [{ type: 'heardUnavailable', displayName: '佐藤' }],
      [{ type: 'listenStart' }],
    ] as VoiceKioskEvent[][]) {
      const state = run(events);
      expect(isVisitorNameState(state)).toBe(false);
      expect(voiceKioskReducer(state, { type: 'visitorNameStopped' })).toBe(state);
    }
  });

  it('タッチへ縮退（fallback）中は氏名のイベントでも抜けない', () => {
    const fallback = run([{ type: 'fallbackRequired', source: 'stt' }]);
    for (const event of [
      { type: 'visitorNameAsk', retry: false },
      { type: 'visitorNameReadback', name: '受付' },
      { type: 'visitorNameKeyboard' },
    ] as VoiceKioskEvent[]) {
      expect(voiceKioskReducer(fallback, event)).toBe(fallback);
    }
  });
});
