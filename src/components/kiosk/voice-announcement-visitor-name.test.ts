import { describe, expect, it } from 'vitest';
import {
  initialVoiceKioskState,
  voiceKioskReducer,
  type VoiceKioskEvent,
  type VoiceKioskState,
} from '@/domain/voice-session/kiosk-view';
import { shouldAnnounce } from './voice-announcement';

/**
 * 来訪者が話している最中に、言い直しの促しを重ねて読み上げない (#1290 の独立レビュー M-1)。
 * 合成データだけを使う。
 */
function announcements(events: VoiceKioskEvent[]): number {
  let state: VoiceKioskState = voiceKioskReducer(initialVoiceKioskState(), { type: 'activate' });
  let previous: VoiceKioskState | null = state;
  let count = 0;
  for (const event of events) {
    state = voiceKioskReducer(state, event);
    if (shouldAnnounce(previous, state)) count += 1;
    previous = state;
  }
  return count;
}

describe('言い直しの促しは 1 度だけ読み上げる', () => {
  it('促しの後に途中経過が何度来ても、読み上げは 1 回', () => {
    expect(
      announcements([
        { type: 'visitorNameAsk', retry: true },
        { type: 'hearPartial', text: 'う' },
        { type: 'hearPartial', text: 'うけ' },
        { type: 'hearPartial', text: 'うけつけ' },
      ]),
    ).toBe(1);
  });

  it('下界: 2 度目の言い直し（新しい促し）はまた読み上げる', () => {
    expect(
      announcements([
        { type: 'visitorNameAsk', retry: true },
        { type: 'hearPartial', text: 'う' },
        { type: 'visitorNameAsk', retry: true },
      ]),
    ).toBe(2);
  });
});
