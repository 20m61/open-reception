/**
 * 呼び出し中のポーリング判断 (#647)。
 *
 * 「いつ止めるか」「何を dispatch するか」を純関数へ出す。React の effect には
 * タイマーと fetch だけを残す（判定を effect に置くとテストできない）。
 */
import { describe, expect, it } from 'vitest';
import {
  CALL_STATUS_POLL_INTERVAL_MS,
  CALL_STATUS_POLL_MAX_MS,
  decidePollAction,
} from './call-poll';

describe('decidePollAction — ポーリングの継続と終了', () => {
  it('呼び出し中のままなら待つ', () => {
    expect(decidePollAction('calling', 0)).toEqual({ kind: 'wait' });
    expect(decidePollAction('calling', 10_000)).toEqual({ kind: 'wait' });
  });

  it.each([
    ['connected', 'CALL_CONNECTED'],
    ['timeout', 'CALL_TIMEOUT'],
    ['failed', 'CALL_FAILED'],
  ])('サーバが %s を返したら %s を dispatch する', (state, event) => {
    expect(decidePollAction(state, 1_000)).toEqual({ kind: 'resolved', event });
  });

  it('🔴 サーバの結果は経過時間で上書きしない（権威はサーバ）', () => {
    // 上限を過ぎていても、サーバが結果を返しているならそれに従う。
    expect(decidePollAction('connected', CALL_STATUS_POLL_MAX_MS + 1)).toEqual({
      kind: 'resolved',
      event: 'CALL_CONNECTED',
    });
  });

  it('🔴 上限を過ぎても未確定なら諦める（無限ポーリングにしない）', () => {
    // サーバ側の呼出予算があるので通常ここへは来ない。来るのは相関を引けない等の異常時。
    expect(decidePollAction('calling', CALL_STATUS_POLL_MAX_MS + 1)).toEqual({ kind: 'give_up' });
  });

  it('上限ちょうどではまだ諦めない', () => {
    expect(decidePollAction('calling', CALL_STATUS_POLL_MAX_MS)).toEqual({ kind: 'wait' });
  });

  it('想定外の状態では待たない（沈黙させない）', () => {
    // cancelled / completed 等へ外部要因で移った場合、待ち続けても意味が無い。
    expect(decidePollAction('cancelled', 1_000)).toEqual({ kind: 'give_up' });
  });

  it('間隔と上限は運用可能な値', () => {
    // 短すぎると Lambda 呼び出しが増える。長すぎると来訪者の体感が悪い。
    expect(CALL_STATUS_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
    expect(CALL_STATUS_POLL_INTERVAL_MS).toBeLessThanOrEqual(5_000);
    // サーバの呼出予算（step timeout + 余裕 30s）より十分長いこと。
    expect(CALL_STATUS_POLL_MAX_MS).toBeGreaterThan(60_000);
  });
});
