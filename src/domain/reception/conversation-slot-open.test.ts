import { describe, expect, it } from 'vitest';
import { isConversationSlotOpen } from './conversation-draft';
import { RECEPTION_STATES } from './state';

/**
 * slot がまだ開いている（その画面を通り過ぎていない）か (#1290)。言い直しが使える値に
 * ならなかったとき、`replaceConversationSlot` で消してよいのは開いている slot だけ。
 */
describe('isConversationSlotOpen', () => {
  it('氏名は inputVisitorInfo とそれより手前の受付途中の画面で開いている', () => {
    for (const state of ['selectingPurpose', 'selectingTarget', 'inputVisitorInfo'] as const) {
      expect(isConversationSlotOpen('visitorName', state), state).toBe(true);
    }
    expect(isConversationSlotOpen('visitorName', 'confirming')).toBe(false);
  });

  it('相手は selectingTarget までは開いていて、inputVisitorInfo では閉じている', () => {
    expect(isConversationSlotOpen('target', 'selectingTarget')).toBe(true);
    expect(isConversationSlotOpen('target', 'inputVisitorInfo')).toBe(false);
  });

  it('受付途中の 4 状態以外では、どの slot も開いていない（draft を持たない）', () => {
    for (const state of RECEPTION_STATES.filter(
      (s) => !['selectingPurpose', 'selectingTarget', 'inputVisitorInfo', 'confirming'].includes(s),
    )) {
      for (const key of ['purpose', 'target', 'visitorName', 'company'] as const) {
        expect(isConversationSlotOpen(key, state), `${key}@${state}`).toBe(false);
      }
    }
  });
});
