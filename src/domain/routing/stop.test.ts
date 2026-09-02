/**
 * 「受付が終わったら取次も止まる」 (#743)。
 */
import { describe, expect, it } from 'vitest';
import { RECEPTION_STATES } from '@/domain/reception/state';
import { decideRoutingStop, routingMayContinue, ROUTING_STOP_REASONS } from './stop';

describe('routingMayContinue (#743)', () => {
  it('呼び出し中だけ続けてよい', () => {
    expect(routingMayContinue('calling')).toBe(true);
  });

  /**
   * 🔴 **これが不変条件の本体。** 受付状態が増えたときに黙って「進んでよい」側へ
   * 入らないよう、**既知の全状態**に対して確かめる。
   */
  it('🔴 呼び出し中以外のすべての受付状態で止まる', () => {
    for (const state of RECEPTION_STATES) {
      if (state === 'calling') continue;
      expect(routingMayContinue(state), `${state} で取次が続いてしまう`).toBe(false);
    }
  });

  it('未知の状態でも止まる（許可リストで判断する）', () => {
    expect(routingMayContinue('TEST-unknown')).toBe(false);
  });
});

describe('decideRoutingStop (#743)', () => {
  it('呼び出し中なら続ける', () => {
    expect(decideRoutingStop('calling')).toEqual({ kind: 'continue' });
  });

  it('終端していれば止める', () => {
    expect(decideRoutingStop('timeout')).toEqual({ kind: 'stop', reason: 'reception_terminal' });
  });

  /**
   * 🔴 **読めないまま撃たない。** 不在から「まだ呼び出し中だ」をでっち上げると、
   * 取り消された受付のために社内の電話が鳴る。
   */
  it('🔴 受付を読めなければ止める', () => {
    expect(decideRoutingStop(undefined)).toEqual({ kind: 'stop', reason: 'reception_terminal' });
  });

  it('明示の停止理由は受付状態より優先する（来訪者・運用者の意思）', () => {
    for (const reason of ROUTING_STOP_REASONS) {
      expect(decideRoutingStop('calling', reason)).toEqual({ kind: 'stop', reason });
    }
  });
});
