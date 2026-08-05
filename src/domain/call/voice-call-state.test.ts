import { describe, expect, it } from 'vitest';
import {
  TERMINAL_VOICE_STATES,
  applyVoiceEvent,
  initialVoiceCallState,
  isTerminalVoiceState,
  voiceStateToRouteResult,
  type VoiceCallEvent,
  type VoiceCallState,
} from './voice-call-state';

const ringing: VoiceCallEvent = { kind: 'status', status: 'ringing' };
const answered: VoiceCallEvent = { kind: 'status', status: 'answered' };
const completed: VoiceCallEvent = { kind: 'status', status: 'completed' };

/** 一連のイベントを順に適用する。 */
function apply(...events: VoiceCallEvent[]): VoiceCallState {
  return events.reduce(applyVoiceEvent, initialVoiceCallState());
}

describe('通常の進行 (#4)', () => {
  it('発信 → 呼出 → 応答 → 意思表示待ち', () => {
    expect(initialVoiceCallState()).toBe('queued');
    expect(apply(ringing)).toBe('ringing');
    expect(apply(ringing, answered)).toBe('awaiting_acceptance');
  });

  it.each([
    ['accept', 'answered'],
    ['coming', 'staff_coming'],
    ['declined', 'declined'],
    ['delegate', 'declined'],
  ] as const)('DTMF %s → %s', (choice, expected) => {
    expect(apply(ringing, answered, { kind: 'dtmf', choice })).toBe(expected);
  });

  it.each([
    ['busy', 'busy'],
    ['unanswered', 'no_answer'],
    ['timeout', 'no_answer'],
    ['rejected', 'declined'],
    ['failed', 'failed'],
  ] as const)('provider status %s → %s', (status, expected) => {
    expect(apply(ringing, { kind: 'status', status })).toBe(expected);
  });
});

describe('terminal から巻き戻さない (#4)', () => {
  it.each(TERMINAL_VOICE_STATES)('%s に達したら以降のイベントを無視する', (terminal) => {
    // 実際に起きる: 担当者が 2（向かう）を押して切る → completed が後から届く。
    // ここで上書きすると「向かうと言ったのに未応答扱い」になり、取次が次の人へ進んでしまう。
    const after = [ringing, answered, completed, { kind: 'dtmf', choice: 'accept' } as const].reduce(
      applyVoiceEvent,
      terminal,
    );
    expect(after).toBe(terminal);
  });

  it('staff_coming の後に completed が来ても staff_coming のまま', () => {
    const state = apply(ringing, answered, { kind: 'dtmf', choice: 'coming' }, completed);
    expect(state).toBe('staff_coming');
  });
});

describe('順不同イベントを許容する (#4)', () => {
  it('answered より先に completed が来ても、後続の answered で巻き戻らない', () => {
    // at-least-once 配信では順序が保証されない。
    const state = apply(completed, answered);
    expect(isTerminalVoiceState(state)).toBe(true);
  });

  it('ringing が応答後に遅れて届いても awaiting_acceptance を保つ', () => {
    expect(apply(ringing, answered, ringing)).toBe('awaiting_acceptance');
  });

  it('同じイベントが複数回届いても状態が変わらない（冪等は ledger、ここは無害性）', () => {
    expect(apply(ringing, ringing, ringing)).toBe('ringing');
    expect(apply(ringing, answered, answered)).toBe('awaiting_acceptance');
  });
});

describe('応答したが意思表示が無いまま終了 (#4)', () => {
  it('awaiting_acceptance のまま completed なら no_answer（次の手へ進む）', () => {
    // 応答はしたが誰も「向かう」と言っていない。来訪者から見れば誰も約束していないので、
    // 取次は次の手へ進むべき。ここを answered（終端成功）にすると取次が止まって放置される。
    expect(apply(ringing, answered, completed)).toBe('no_answer');
  });

  it('呼出のまま completed なら no_answer', () => {
    expect(apply(ringing, completed)).toBe('no_answer');
  });
});

describe('voiceStateToRouteResult — 取次語彙への写像 (#4)', () => {
  it.each([
    ['answered', 'answered'],
    ['staff_coming', 'staff_coming'],
    ['declined', 'declined'],
    ['no_answer', 'no_answer'],
    ['busy', 'busy'],
    ['failed', 'failed'],
  ] as const)('%s → %s', (state, expected) => {
    expect(voiceStateToRouteResult(state)).toBe(expected);
  });

  it.each(['queued', 'ringing', 'awaiting_acceptance'] as const)(
    '進行中の %s は取次結果を持たない（未確定を確定として扱わない）',
    (state) => {
      expect(voiceStateToRouteResult(state)).toBeUndefined();
    },
  );

  it('全ての terminal state が取次結果へ写せる（取りこぼしを型と実行の両方で塞ぐ）', () => {
    for (const state of TERMINAL_VOICE_STATES) {
      expect(voiceStateToRouteResult(state)).toBeDefined();
    }
  });
});
