/**
 * 受付フロー reducer の単体テスト (issue #422 increment 4)。
 *
 * `KioskFlow.tsx` の中に在った間は DOM 越しにしか触れなかったが、切り出したことで
 * 直接突けるようになった。ここで固定するのは **状態機械が壊れない条件**:
 * 不正遷移で現状維持すること・RESET で PII が残らないこと。
 */
import { describe, expect, it } from 'vitest';
import { INITIAL, reducer, type FlowData } from './flow-state';

const target = { type: 'staff' as const, id: 's1', label: '佐藤' };
const visitor = { name: 'TEST-来訪者', company: 'TEST-株式会社' };

describe('reducer', () => {
  it('START で用件選択へ進み、先取りした目的を持ち回る', () => {
    const next = reducer(INITIAL, { type: 'START', pendingPurpose: 'delivery' });
    expect(next.state).toBe('selectingPurpose');
    expect(next.pendingPurpose).toBe('delivery');
  });

  it('目的が確定したら先取りヒントを消費し、相手を作り直す', () => {
    const started = reducer(INITIAL, { type: 'START', pendingPurpose: 'delivery' });
    const withTarget: FlowData = { ...started, target };
    const next = reducer(withTarget, { type: 'SELECT_PURPOSE', purpose: 'meeting' });
    expect(next.purpose).toBe('meeting');
    expect(next.pendingPurpose).toBeUndefined();
    // 目的が変われば相手も選び直し（前の目的で選んだ相手を持ち越さない）。
    expect(next.target).toBeUndefined();
  });

  it('呼び出し結果を outcome として記録する', () => {
    const calling: FlowData = { state: 'calling', purpose: 'meeting', target, visitor };
    expect(reducer(calling, { type: 'CALL_CONNECTED', sessionId: 'r1' })).toMatchObject({
      outcome: 'connected',
      sessionId: 'r1',
    });
    expect(reducer(calling, { type: 'CALL_TIMEOUT', sessionId: 'r1' }).outcome).toBe('timeout');
    expect(reducer(calling, { type: 'CALL_FAILED', sessionId: 'r1' }).outcome).toBe('failed');
  });

  it('不正な遷移は現状維持（受付画面を壊さない）', () => {
    // 待機中に「確認」は起こり得ない。連打・戻る・タイムアウトが重なっても画面を壊さない。
    const same = reducer(INITIAL, { type: 'CONFIRM' });
    expect(same).toBe(INITIAL);

    const calling: FlowData = { state: 'calling', purpose: 'meeting', target, visitor };
    expect(reducer(calling, { type: 'START' })).toBe(calling);
  });

  it('RESET は初期状態へ戻し、来訪者情報を持ち越さない (#125)', () => {
    const filled: FlowData = {
      state: 'confirming',
      purpose: 'meeting',
      target,
      visitor,
      sessionId: 'r1',
      outcome: 'connected',
      pendingPurpose: 'delivery',
    };
    const next = reducer(filled, { type: 'RESET' });
    expect(next).toEqual(INITIAL);
    expect(next.visitor).toBeUndefined();
    expect(next.target).toBeUndefined();
    expect(next.sessionId).toBeUndefined();
  });

  it('BACK / CANCEL は状態だけを動かし、入力済みの値は保持する（修正して戻れる）', () => {
    const confirming: FlowData = { state: 'confirming', purpose: 'meeting', target, visitor };
    const back = reducer(confirming, { type: 'BACK' });
    expect(back.state).not.toBe('confirming');
    expect(back.visitor).toEqual(visitor);
    expect(back.target).toEqual(target);
  });
});

describe('呼び出し失敗の理由 (#422)', () => {
  const calling: FlowData = { state: 'calling', purpose: 'meeting', target, visitor };

  it('通信断とサーバ側の失敗を区別して持ち回る（状態は同じ failed）', () => {
    const network = reducer(calling, { type: 'CALL_FAILED', reason: 'network' });
    expect(network.state).toBe('failed');
    expect(network.failureReason).toBe('network');

    const server = reducer(calling, { type: 'CALL_FAILED', sessionId: 'r1', reason: 'server' });
    expect(server.state).toBe('failed');
    expect(server.failureReason).toBe('server');
  });

  it('理由を付けない失敗（担当者応答からの代替導線）は undefined のまま', () => {
    expect(reducer(calling, { type: 'CALL_FAILED', sessionId: 'r1' }).failureReason).toBeUndefined();
  });

  it('RESET で理由も破棄される（次の来訪者へ持ち越さない）', () => {
    const failed = reducer(calling, { type: 'CALL_FAILED', reason: 'network' });
    expect(reducer(failed, { type: 'RESET' }).failureReason).toBeUndefined();
  });
});
