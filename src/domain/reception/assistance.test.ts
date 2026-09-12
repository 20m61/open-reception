import { describe, expect, it } from 'vitest';
import {
  assistanceAvailabilityFor,
  assistanceModeReducer,
  INITIAL_ASSISTANCE_MODE,
  shouldSuspendReceptionInteraction,
} from './assistance';

describe('assistanceAvailabilityFor (#1074)', () => {
  it.each(['selectingPurpose', 'selectingTarget', 'inputVisitorInfo', 'confirming'] as const)(
    '%s では設定済み支援先があればCTAを出せる',
    (state) => {
      expect(
        assistanceAvailabilityFor({
          state,
          online: true,
          capability: { status: 'available', channel: 'voice' },
        }),
      ).toEqual({ available: true, channel: 'voice' });
    },
  );

  it('calling/result系では入力支援CTAを出さない', () => {
    expect(
      assistanceAvailabilityFor({
        state: 'calling',
        online: true,
        capability: { status: 'available', channel: 'voice' },
      }),
    ).toEqual({ available: false, reason: 'state_not_eligible' });
  });

  it('offlineなら「つなぐ」契約を返さない', () => {
    expect(
      assistanceAvailabilityFor({
        state: 'inputVisitorInfo',
        online: false,
        capability: { status: 'available', channel: 'voice' },
      }),
    ).toEqual({ available: false, reason: 'offline' });
  });

  it('未設定なら未設定理由をそのまま返す', () => {
    expect(
      assistanceAvailabilityFor({
        state: 'selectingTarget',
        online: true,
        capability: { status: 'unavailable', reason: 'not_configured' },
      }),
    ).toEqual({ available: false, reason: 'not_configured' });
  });
});

describe('assistanceModeReducer (#1074)', () => {
  it('availableなREQUESTだけrequestingへ進む', () => {
    expect(
      assistanceModeReducer(INITIAL_ASSISTANCE_MODE, {
        type: 'REQUEST',
        availability: { available: true, channel: 'video' },
      }),
    ).toEqual({ mode: 'requesting', channel: 'video' });

    expect(
      assistanceModeReducer(INITIAL_ASSISTANCE_MODE, {
        type: 'REQUEST',
        availability: { available: false, reason: 'not_configured' },
      }),
    ).toEqual(INITIAL_ASSISTANCE_MODE);
  });

  it('requesting→connectedでもReceptionStateを必要としない独立mode', () => {
    const requesting = assistanceModeReducer(INITIAL_ASSISTANCE_MODE, {
      type: 'REQUEST',
      availability: { available: true, channel: 'staff_call' },
    });
    const connected = assistanceModeReducer(requesting, { type: 'CONNECTED' });

    expect(connected).toEqual({ mode: 'connected', channel: 'staff_call' });
    expect(shouldSuspendReceptionInteraction(connected)).toBe(true);
  });

  it('CLOSEで支援だけを閉じ、受付stateを巻き戻すeventを生成しない', () => {
    const requesting = { mode: 'requesting', channel: 'voice' } as const;
    expect(assistanceModeReducer(requesting, { type: 'CLOSE' })).toEqual(
      INITIAL_ASSISTANCE_MODE,
    );
  });

  it('失敗はfailed modeにし、call failure fallbackとは混ぜない', () => {
    const requesting = { mode: 'requesting', channel: 'voice' } as const;
    expect(
      assistanceModeReducer(requesting, { type: 'FAILED', reason: 'request_failed' }),
    ).toEqual({ mode: 'failed', reason: 'request_failed' });
  });
});
