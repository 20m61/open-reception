import { describe, expect, it } from 'vitest';
import {
  TERMINAL_VOICE_STATES,
  VONAGE_CALL_STATUSES,
  applyVoiceEvent,
  isVonageCallStatus,
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
    // 「terminal である」だけの assert だと、どの terminal かを変える変異が素通りする。
    expect(apply(completed, answered)).toBe('no_answer');
    expect(isTerminalVoiceState(apply(completed, answered))).toBe(true);
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

describe('Vonage のステータス語彙 (2026-09-02 仕様照合)', () => {
  it('started は状態を動かさない（発信受付の通知。既知として受け取る）', () => {
    const started: VoiceCallEvent = { kind: 'status', status: 'started' };
    expect(apply(started)).toBe('queued');
    expect(apply(ringing, started)).toBe('ringing');
    expect(apply(ringing, answered, started)).toBe('awaiting_acceptance');
  });

  /**
   * `cancelled` は**こちらが呼出中に切った**とき（`/give-up`・引き継ぎ失敗の切断）に届く。
   * 以前は未知として無視され、`completed` が続かなければ相関が ringing のまま残っていた。
   */
  it.each(['cancelled', 'disconnected'] as const)(
    '%s は completed と同じく「終わったが誰も向かっていない」＝ no_answer',
    (status) => {
      expect(apply(ringing, { kind: 'status', status })).toBe('no_answer');
      expect(apply(ringing, answered, { kind: 'status', status })).toBe('no_answer');
    },
  );

  it.each(['cancelled', 'disconnected'] as const)('%s でも terminal は巻き戻さない', (status) => {
    const state = apply(ringing, answered, { kind: 'dtmf', choice: 'coming' }, { kind: 'status', status });
    expect(state).toBe('staff_coming');
  });

  it('一覧は Vonage Voice の event webhook の status（PSTN 1 レグに届きうるもの）と一致する', () => {
    // 公式 SDK の CallStatus 列挙のうち、留守電判定（human/machine）とアクション通知
    // （input/transfer/record）を除いた集合。ここを縮める変異は `/events` が黙って無視する
    // ステータスを増やすので、集合そのものを固定する。
    expect([...VONAGE_CALL_STATUSES].sort()).toEqual(
      [
        'answered',
        'busy',
        'cancelled',
        'completed',
        'disconnected',
        'failed',
        'rejected',
        'ringing',
        'started',
        'timeout',
        'unanswered',
      ].sort(),
    );
  });

  it('isVonageCallStatus は一覧の値だけを通す', () => {
    for (const status of VONAGE_CALL_STATUSES) expect(isVonageCallStatus(status)).toBe(true);
    expect(isVonageCallStatus('machine')).toBe(false);
    expect(isVonageCallStatus('')).toBe(false);
    expect(isVonageCallStatus(undefined)).toBe(false);
  });

  it('一覧の全ステータスが状態機械で処理できる（取りこぼしを実行でも塞ぐ）', () => {
    for (const status of VONAGE_CALL_STATUSES) {
      expect(() => apply(ringing, { kind: 'status', status })).not.toThrow();
    }
  });
});
