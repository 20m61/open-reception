import { describe, expect, it } from 'vitest';
import {
  isTerminal,
  shouldResetOnInactivity,
  transition,
  transitionOrThrow,
  type ReceptionState,
} from './state';

describe('reception state machine', () => {
  it('待機から呼び出し成功までの正常系を遷移できる', () => {
    let s: ReceptionState = 'idle';
    s = transitionOrThrow(s, 'START');
    expect(s).toBe('selectingPurpose');
    s = transitionOrThrow(s, 'SELECT_PURPOSE');
    expect(s).toBe('selectingTarget');
    s = transitionOrThrow(s, 'SELECT_TARGET');
    expect(s).toBe('inputVisitorInfo');
    s = transitionOrThrow(s, 'SUBMIT_VISITOR_INFO');
    expect(s).toBe('confirming');
    s = transitionOrThrow(s, 'CONFIRM');
    expect(s).toBe('calling');
    s = transitionOrThrow(s, 'CALL_CONNECTED');
    expect(s).toBe('connected');
    s = transitionOrThrow(s, 'COMPLETE');
    expect(s).toBe('completed');
  });

  it('不正遷移は null を返す', () => {
    expect(transition('idle', 'CONFIRM')).toBeNull();
    expect(transition('confirming', 'CALL_CONNECTED')).toBeNull();
    expect(transition('completed', 'START')).toBeNull();
  });

  it('不正遷移は transitionOrThrow で例外になる', () => {
    expect(() => transitionOrThrow('idle', 'CONFIRM')).toThrowError(/Invalid reception transition/);
  });

  it('呼び出しの失敗・未応答・キャンセルを区別する', () => {
    expect(transition('calling', 'CALL_FAILED')).toBe('failed');
    expect(transition('calling', 'CALL_TIMEOUT')).toBe('timeout');
    expect(transition('calling', 'CANCEL')).toBe('cancelled');
  });

  it('失敗/未応答から代替導線へ進める', () => {
    expect(transition('failed', 'USE_FALLBACK')).toBe('fallback');
    expect(transition('timeout', 'USE_FALLBACK')).toBe('fallback');
  });

  it('RESET はどの状態からでも待機へ戻る', () => {
    for (const s of ['calling', 'failed', 'completed', 'connected'] as ReceptionState[]) {
      expect(transition(s, 'RESET')).toBe('idle');
    }
  });

  it('終端状態を判定できる', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('calling')).toBe(false);
  });

  describe('無操作タイムアウト対象 (issue #125)', () => {
    it('操作途中（選択・入力・確認・結果/代替案内）は待機へ戻す対象', () => {
      for (const s of [
        'selectingPurpose',
        'selectingTarget',
        'inputVisitorInfo',
        'confirming',
        'timeout',
        'failed',
        'fallback',
      ] as ReceptionState[]) {
        expect(shouldResetOnInactivity(s)).toBe(true);
      }
    });

    it('待機・通話接続中は対象外（生きた接続を切らない／既に待機）', () => {
      for (const s of ['idle', 'calling', 'connected'] as ReceptionState[]) {
        expect(shouldResetOnInactivity(s)).toBe(false);
      }
    });

    it('終端状態は対象外（短い自動復帰 AUTO_RESET が別途扱う）', () => {
      expect(shouldResetOnInactivity('completed')).toBe(false);
      expect(shouldResetOnInactivity('cancelled')).toBe(false);
    });
  });
});
